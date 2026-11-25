'use strict';
const {SchemaDesigner}=require('./schema-designer');
const {SchemaObjectEditor}=require('./object-editor');

const { performance } = require('node:perf_hooks');
const { validateQuery, validateReadQuery, parameters, tokenize } = require('./sql-policy');
const { operationOf, outcomeOf, driverActivity } = require('./activity-log');
const { readMetadata, attachCheckMetadata, readForeignKeyTargetCatalog, readRelationshipJoinCatalog } = require('./metadata');
const { readCatalogRefresh } = require('./catalog-refresh');
const { readRelatedCatalog } = require('./related-rows');
const { readJoinCatalog } = require('./join-catalog');
const { isolationLevel, serverIsolationLevel } = require('./transaction-isolation');
const { localDriverOptions } = require('./local-transport');
const { geometryType, preserveGeometry, captureGeometry } = require('./result-map');
const { TableEditor } = require('./grid');
const { SchemaRenamer } = require('./schema-rename');
const { SchemaRecovery } = require('./schema-recovery');
const { SchemaApplier } = require('./schema-apply');
const scriptEngine=require('./sql-script');
const { transactionSql,assertTransactionStart,reject:transactionError }=require('./sql-script-transaction');
const { inferScriptParameters } = require('./parameter-inference');
const routineCall = require('./routine-call');
const { reviewScriptCall } = require('./sql-script-call');
const routinePackage = require('./routine-package');
const { contextOf: objectSourceContext } = require('./object-source');
const { collectRoutineResults, maxBytes: maxRoutineResultBytes } = require('./routine-call-stream');
const {randomUUID}=require('node:crypto');
const { normalizeRdsIam, validateRdsIamRoute, createRdsIamHandshake, handshakeTimeout } = require('./rds-iam');
const { normalizeWriteProtection, protectionError, requireConnectionMode, requireStatementScope,verifyCallableScope } = require('./write-protection');
const { sessionLifecycle, initializationStatements } = require('./session-lifecycle');
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const METADATA_ID = '__rocketbrain_metadata__';
const MAX_PROTECTED_DEPENDENCIES = 128;
const CASCADE_RULES = new Set(['CASCADE', 'SET NULL', 'SET DEFAULT']);
const FOREIGN_KEY_RULES = new Set(['RESTRICT', 'NO ACTION', ...CASCADE_RULES]);
const quoteIdentifier = name => {
  const quote = String.fromCharCode(96);
  return quote + name.replaceAll(quote, quote + quote) + quote;
};
function fail(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
function limits(options = {}) {
  const maxRows = options.maxRows ?? 500, timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 5000) throw new Error('maxRows must be an integer from 1 to 5000.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120000) throw new Error('timeoutMs must be an integer from 10 to 120000.');
  return { maxRows, timeoutMs };
}
function connectionOptions(config) {
  if (!config || typeof config !== 'object') throw new Error('A MySQL connection is required.');
  const local = localDriverOptions(config);
  for (const key of local ? ['user', 'database'] : ['host', 'user', 'database']) {
    if (typeof config[key] !== 'string' || !config[key].trim() || config[key].length > 1024) throw new Error('Enter a valid MySQL ' + key + '.');
  }
  const port = config.port ?? 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port from 1 to 65535.');
  if (config.password !== undefined && typeof config.password !== 'string') throw new Error('The password must be text.');
  if (config.readOnly !== undefined && typeof config.readOnly !== 'boolean') throw new Error('readOnly must be a boolean.');
  if (config.ssl && (typeof config.ssl !== 'object' || config.ssl.rejectUnauthorized === false)) throw new Error('TLS certificate verification must remain enabled.');
  // MySQL treats Unix sockets as secure for full SHA-2 authentication. Windows named pipes require RSA exchange.
  const pipeAuth = config.transport?.kind === 'named-pipe' ? {
    authPlugins: { caching_sha2_password: require('mysql2').authPlugins.caching_sha2_password({ overrideIsSecure: false }) }
  } : undefined;
  return {
    ...(local || { host: config.host.trim(), port }), user: config.user, database: config.database, password: config.password || '',
    ...pipeAuth,
    ...(config.ssl ? { ssl: { rejectUnauthorized: true, ...(typeof config.ssl.ca === 'string' ? { ca: config.ssl.ca } : {}) } } : {}),
    multipleStatements: false, rowsAsArray: true, supportBigNumbers: true, bigNumberStrings: true,
    dateStrings: true, jsonStrings: true, charset: 'utf8mb4', connectTimeout: 5000, enableKeepAlive: true,
    flags: '-LOCAL_FILES', decimalNumbers: false,
  };
}
function safeError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code.startsWith('ROCKETBRAIN_')) return error;
  const messages = {
    ER_ACCESS_DENIED_ERROR: 'MySQL rejected the user name or password.',
    ER_DBACCESS_DENIED_ERROR: 'This MySQL user cannot access the selected database.',
    ER_BAD_DB_ERROR: 'The selected MySQL database does not exist.',
    ECONNREFUSED: 'The MySQL server refused the connection. Check its address and port.',
    ENOENT: 'The database socket or named pipe is unavailable. Check that the local server is listening.',
    EACCES: 'The database transport was denied by the operating system. Check the socket or pipe permissions.',
    EPERM: 'The database transport was denied by the operating system. Check the socket or pipe permissions.',
    ENOTFOUND: 'The MySQL server address could not be found.',
    ETIMEDOUT: 'The MySQL connection timed out.',
    PROTOCOL_CONNECTION_LOST: 'The database connection was lost. Reconnect this console explicitly; a write may have completed.',
    ER_PARSE_ERROR: 'MySQL could not parse the query. Check its syntax and database dialect.',
    ER_NO_SUCH_TABLE: 'A table used by the query does not exist in the selected database.',
    ER_BAD_FIELD_ERROR: 'A column used by the query could not be found.',
    ER_DUP_ENTRY: 'The change conflicts with an existing unique or primary key.',
    ER_LOCK_DEADLOCK: 'The server detected a deadlock. Inspect the transaction state before retrying.',
    ER_LOCK_WAIT_TIMEOUT: 'The server lock wait timed out. Inspect the transaction state before retrying.',
    ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: 'The server refused this operation in a read-only transaction.',
    ER_QUERY_INTERRUPTED: 'The database query was interrupted.',
    ER_QUERY_TIMEOUT: 'The server stopped the query at its time limit.',
    ER_STATEMENT_TIMEOUT: 'The server stopped the query at its time limit.',
    HANDSHAKE_SSL_ERROR: 'The MySQL TLS connection failed. Check the server certificate.',
    SELF_SIGNED_CERT_IN_CHAIN: 'The MySQL TLS certificate is not trusted. Supply the issuing CA certificate.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The MySQL TLS certificate is not trusted. Supply the issuing CA certificate.',
    CERT_HAS_EXPIRED: 'The MySQL TLS certificate has expired.',
  };
  const publicCode = /^[A-Z][A-Z0-9_]{0,70}$/.test(code) ? code : 'MYSQL_ERROR';
  return fail(publicCode, messages[code] || 'The MySQL operation failed (' + publicCode + ').', { fatal: Boolean(error?.fatal) });
}
function cellValue(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return '0x' + value.toString('hex');
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  return JSON.stringify(value);
}
function newSession(id, readOnly, database) {
  return { id, readOnly, database, autocommit: true, inTransaction: false, transactionState: 'idle',
    everWritable: !readOnly,
    transactionIsolation: null,
    outcomeUnknown: false, needsReconnect: false, connected: false, connection: null, connectionId: null,
    queue: Promise.resolve(), active: null, closed: false, cancellationVersion: 0 };
}

/**
 * Each named console pins one connection. No user statement is retried.
 * A bounded result may destroy its connection; result.state makes that explicit.
 * The SQL policy is not a sandbox for privileged server UDFs.
 */
class MysqlService {
  constructor(config, { createConnection, reportActivity, reportSession, mintIamToken } = {}) {
    this._options = connectionOptions(config);
    this._sessionLifecycle = sessionLifecycle(config.sessionLifecycle);
    this._initialization = this._sessionLifecycle ? initializationStatements(this._sessionLifecycle.initialSql) : [];
    this._writeProtection = normalizeWriteProtection(config.writeProtection);
    const security = require('./connection-security').connectionSecurity(config);Object.assign(this._options,security.options);this._connectionCleanup=security.dispose;
    if (config.auth !== undefined) {
      const auth = normalizeRdsIam(config.auth);
      const { host, user, port = 3306 } = config;
      validateRdsIamRoute({ ...config, auth }, config.ssl);
      if (!config.ssl.ca || security.options.stream || config.password) {
        throw fail('ROCKETBRAIN_RDS_IAM', 'Use the AWS RDS CA bundle and direct TLS with IAM authentication.');
      }
      this._rdsIam = () => createRdsIamHandshake({ host, user, port, auth }, mintIamToken);
    }
    this._defaultReadOnly = this._writeProtection?.connectionReadOnly || config.readOnly !== false;
    this._createConnection = createConnection || (options => require('mysql2').createConnection(options));
    this._reportActivity = reportActivity;
    this._reportSession = reportSession;
    this._sessions = new Map([['default', newSession('default', this._defaultReadOnly, this._options.database)]]);
    this._metadataSession = newSession(METADATA_ID, true, this._options.database);
    this._catalogConnections = new WeakMap();
    this._disposed = false; this._revision = 0;
    this._editor = new TableEditor(this);
    this._schemaRenamer = new SchemaRenamer(this,{createSession:newSession});
    this._schemaApplier = new SchemaApplier(this,{createSession:newSession});
    this._schemaRecovery = new SchemaRecovery(this,{createSession:newSession});
    this._schemaDesigner = new SchemaDesigner(this,{createSession:newSession});
    this._objectEditor = new SchemaObjectEditor(this,{createSession:newSession});
    this._scriptReviews=new Map();
  }
  _assertOpen() { if (this._disposed) throw new Error('The MySQL connection has been closed.'); }
  _id(id) {
    if (typeof id !== 'string' || !id || id.length > 2048 || id === METADATA_ID) throw new Error('Enter a valid console session ID.');
    return id;
  }
  _session(id = 'default') {
    this._assertOpen(); this._id(id);
    const session = this._sessions.get(id);
    if (!session) throw new Error('Open this console session before running SQL.');
    return session;
  }
  _state(session) {
    const { id, readOnly, autocommit, inTransaction, transactionState, transactionIsolation, connected, connectionId, database, outcomeUnknown, needsReconnect } = session;
    return { id, readOnly, autocommit, inTransaction, transactionState, transactionIsolation, connected, connectionId, database, outcomeUnknown, needsReconnect, busy: Boolean(session.active||session.scriptRunning),
      ...(this._writeProtection && { writeProtection: structuredClone(this._writeProtection) }),
      ...(session.lifecycle && { lifecycle: { initializedStatements: session.lifecycle.initializedStatements,
        keepAliveChecks: session.lifecycle.keepAliveChecks, disconnectedByIdleTimeout: session.lifecycle.disconnectedByIdleTimeout } }) };
  }
  getSessionState(id = 'default') { return this._state(this._session(id)); }
  async openSession(id, { readOnly = this._defaultReadOnly } = {}) {
    this._assertOpen(); this._id(id);
    if (typeof readOnly !== 'boolean') throw new Error('readOnly must be a boolean.');
    requireConnectionMode(this._writeProtection, readOnly);
    let session = this._sessions.get(id);
    if (!session) {
      if (this._sessions.size >= 32) throw new Error('Close an unused console before opening more than 32 sessions.');
      this._sessions.set(id, session = newSession(id, readOnly, this._options.database));
    } else if (session.readOnly !== readOnly) throw new Error('Use setReadOnly to change an existing console mode explicitly.');
    return this._enqueue(session, async () => { await this._ensureConnection(session); return this._state(session); });
  }
  _enqueue(session, operation, { allowReconnect = false, lifecycleProbe = false } = {}) {
    this._assertOpen();
    if((this._schemaApplier?.applying||this._schemaRecovery?.applying||this._schemaDesigner?.applying||this._objectEditor?.applying)&&this._sessions.get(session.id)===session)throw fail('ROCKETBRAIN_SCHEMA_BUSY','Wait for the reviewed schema application before using this console.');
    const managed = this._sessionLifecycle && this._sessions.get(session.id) === session;
    if (managed && !lifecycleProbe) this._clearSessionTimers(session);
    session.pendingOperations=(session.pendingOperations||0)+1;
    const cancellationVersion = session.cancellationVersion;
    const pending = session.queue.then(async () => {
      this._assertOpen();
      if((this._schemaApplier?.applying||this._schemaRecovery?.applying||this._schemaDesigner?.applying||this._objectEditor?.applying)&&this._sessions.get(session.id)===session)throw fail('ROCKETBRAIN_SCHEMA_BUSY','Wait for the reviewed schema application before using this console.');
      if(this._schemaRenamer?.applying&&this._sessions.get(session.id)===session)throw fail('ROCKETBRAIN_SCHEMA_BUSY','Wait for the owned schema rename before using this console.');
      if (session.closed) throw new Error('This console session has been closed.');
      if (session.cancellationVersion !== cancellationVersion) throw fail('ROCKETBRAIN_CANCELLED', 'The queued console operation was cancelled before execution.');
      if (session.needsReconnect && !allowReconnect) throw fail('ROCKETBRAIN_RECONNECT_REQUIRED', 'This console lost its server session. Reconnect explicitly; temporary tables, variables and uncommitted changes cannot be restored.', { state: this._state(session) });
      return operation();
    });
    const tracked=pending.finally(()=>{
      session.pendingOperations--;
      if (!managed || !session.lifecycle || session.pendingOperations) return;
      if (!lifecycleProbe) session.lifecycle.lastUserActivity = performance.now();
      this._scheduleSessionTimers(session);
    });
    session.queue = tracked.catch(() => {});
    return tracked;
  }
  _observe(session, result) {
    if (!Number.isInteger(result?.serverStatus)) throw fail('ROCKETBRAIN_STATE_UNAVAILABLE', 'The server did not report transaction status. This console cannot safely continue.');
    session.autocommit = Boolean(result.serverStatus & 2);
    session.inTransaction = Boolean(result.serverStatus & 1);
    session.transactionState = session.inTransaction ? 'active' : 'idle';
  }
  _lose(session, reason, mayWrite = false, abort = true) {
    this._clearSessionTimers(session);
    const connection = session.connection, active = session.active;
    session.outcomeUnknown ||= !session.readOnly && (Boolean(session.inTransaction) || mayWrite || Boolean(active?.mayWrite));
    session.connection = null; session.connected = false; session.connectionId = null;
    session.transactionIsolation = null;
    session.needsReconnect = true; session.inTransaction = null; session.transactionState = 'unknown';
    if (connection) connection.destroy();
    if (abort && active) active.abort(reason);
  }
  _clearSessionTimers(session) {
    const timer = session.lifecycle;
    if (!timer) return;
    clearTimeout(timer.keepAlive);
    clearTimeout(timer.idle);
    timer.keepAlive = timer.idle = undefined;
  }
  _scheduleSessionTimers(session) {
    if (this._disposed || session.closed || !session.connected || session.needsReconnect || this._sessions.get(session.id) !== session) return;
    const timer = session.lifecycle, connection = session.connection;
    const usable = () => !this._disposed && !session.closed && session.connection === connection && !session.pendingOperations && !session.active;
    const idle = () => usable() && !session.inTransaction && session.autocommit && !session.outcomeUnknown;
    const { keepAliveSeconds, idleSeconds } = this._sessionLifecycle;
    if (idleSeconds && idle() && !timer.idle) {
      const remaining = idleSeconds * 1000 - (performance.now() - timer.lastUserActivity);
      timer.idle = setTimeout(() => {
        timer.idle = undefined;
        if (!idle()) return;
        const error = fail('ROCKETBRAIN_IDLE_TIMEOUT', 'This idle console disconnected. Reconnect to open a fresh session.');
        this._editor.invalidate(session.id);
        this._lose(session, error);
        session.inTransaction = false;
        session.transactionState = 'idle';
        timer.disconnectedByIdleTimeout = true;
        this._reportSession?.();
      }, Math.max(1, remaining)).unref();
    }
    if (keepAliveSeconds && !timer.keepAlive) {
      timer.keepAlive = setTimeout(async () => {
        timer.keepAlive = undefined;
        if (!usable()) return;
        try {
          await this._enqueue(session, async () => {
            this._observe(session, await this._control(session, 'DO 0'));
            timer.keepAliveChecks++;
          }, { lifecycleProbe: true });
        } catch (error) {
          if (session.connection !== connection) return;
          if (error.code === 'ROCKETBRAIN_SCHEMA_BUSY') this._scheduleSessionTimers(session);
          else this._lose(session, error);
        }
      }, keepAliveSeconds * 1000).unref();
    }
  }
  async _ensureConnection(session) {
    requireConnectionMode(this._writeProtection, session.readOnly);
    if (session.connection && session.connected) return;
    if (session.needsReconnect) throw fail('ROCKETBRAIN_RECONNECT_REQUIRED', 'Reconnect this console explicitly before running SQL.');
    let connection;
    const iam = this._rdsIam?.();
    const connectionError = error => iam?.error() ?? safeError(error);
    // mysql2 caches TLS sessions by SSL options identity. IAM needs the peer certificate on every physical connection.
    const options = iam ? { ...this._options, ...iam.options, ssl: { ...this._options.ssl } } : { ...this._options };
    try { connection = this._createConnection(options); }
    catch (error) { this._lose(session, safeError(error)); throw safeError(error); }
    session.connection = connection;
    connection.on('error', error => {
      if (session.connection !== connection) return;
      this._lose(session, connectionError(error), Boolean(session.active?.mayWrite));
      this._reportSession?.();
    });
    connection.on('end', () => {
      if (session.connection !== connection) return;
      this._lose(session, fail('ROCKETBRAIN_CONNECTION_LOST', 'The server closed this console connection. Reconnect explicitly.'), Boolean(session.active?.mayWrite));
      this._reportSession?.();
    });
    await new Promise((resolve, reject) => {
      let finished = false;
      const finish = error => { if (finished) return; finished = true; clearTimeout(timer); if (session.active === active) session.active = null; error ? reject(error) : resolve(); };
      const active = { mayWrite: false, abort: finish };
      session.active = active;
      const timer = setTimeout(() => this._lose(session, fail('ROCKETBRAIN_TIMEOUT', 'The MySQL connection timed out. Reconnect this console.')), iam ? handshakeTimeout : 5000);
      try {
        connection.connect(error => {
          if (finished) return;
          if (error) { this._lose(session, connectionError(error)); return; }
          if (iam && !iam.sent()) {
            this._lose(session, fail('ROCKETBRAIN_RDS_IAM', 'The server did not authenticate this connection with the RDS IAM token.'));
            return;
          }
          session.connected = true; session.connectionId = connection.threadId ?? null; finish();
        });
      } catch (error) { this._lose(session, connectionError(error)); }
    });
    try {
      await this._control(session, 'SET SESSION TRANSACTION ' + (session.readOnly ? 'READ ONLY' : 'READ WRITE'));
      if (this._sessionLifecycle) {
        session.lifecycle = { lastUserActivity: performance.now(), initializedStatements: 0, keepAliveChecks: 0,
          disconnectedByIdleTimeout: false };
        for (const sql of this._initialization) {
          try { await this._control(session, sql); }
          catch (error) { throw fail('ROCKETBRAIN_SESSION_INITIALIZATION', 'The server rejected a reviewed session initialization setting (' + error.code + ').'); }
          session.lifecycle.initializedStatements++;
        }
      }
      await this._refreshState(session);
    } catch (error) { this._lose(session, error); throw error; }
  }
  _control(session, sql, timeoutMs = 5000, mayWrite = false) {
    if (this._writeProtection?.connectionReadOnly && /\bREAD[\s]+WRITE\b/i.test(sql)) {
      return Promise.reject(protectionError('This connection profile is locked to read-only mode.'));
    }
    return new Promise((resolve, reject) => {
      let finished = false, reportOutcome, outcome;
      const finish = (error, result) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (session.active === active) session.active = null;
        outcome = outcomeOf(error && (error.code || true));
        reportOutcome?.(outcome);
        if (error) reject(safeError(error)); else resolve(result);
      };
      const active = { mayWrite, abort: finish };
      session.active = active;
      const timer = setTimeout(() => this._lose(session, fail('ROCKETBRAIN_TIMEOUT', 'The session control timed out. Reconnect explicitly.')), timeoutMs);
      try {
        session.connection.query(sql, (error, result) => {
          if (error?.fatal) this._lose(session, safeError(error));
          else finish(error, result);
        });
        reportOutcome = this._activity(session, driverActivity(sql));
        if (finished) reportOutcome?.(outcome);
      }
      catch (error) { if (error?.fatal) this._lose(session, safeError(error)); else finish(error); }
    });
  }
  _activity(session, hint) {
    try {
      const finish = this._reportActivity?.(session, hint);
      if (typeof finish === 'function') return status => {
        try { finish(status); } catch { /* Activity reporting must never change the database outcome. */ }
      };
    } catch { /* A disabled or unavailable log is independent of SQL dispatch. */ }
    return undefined;
  }
  async _refreshState(session) {
    // mysql2's public streaming SELECT events omit EOF status. DO 0 is a
    // no-op without table access/implicit commit; its public ResultSetHeader
    // reports the server's IN_TRANS/AUTOCOMMIT bits after the user statement.
    try { this._observe(session, await this._control(session, 'DO 0')); }
    catch (error) { this._lose(session, error); throw error; }
  }
  async query(sql, options = {}) {
    const bounded = limits(options), values = parameters(options.values);
    const session = this._session(options.sessionId);
    return this._enqueue(session, async () => {
      const policy = validateQuery(sql, { readOnly: session.readOnly });
      if (policy.unboundedDml && options.allowUnboundedDml !== true) {
        throw fail('ROCKETBRAIN_UNBOUNDED_DML', 'Review the ' + policy.unboundedDml.command + ' without an outer WHERE clause before running it.');
      }
      await this._ensureConnection(session);
      let result, queryError;
      try { result = await this._stream(session, sql, values, bounded, policy.mayWrite, { category: 'query', operation: policy.first }); }
      catch (error) { queryError = error; }
      if (session.connected) {
        try { await this._refreshState(session); }
      catch (error) {
          if (policy.mayWrite) session.outcomeUnknown = true;
          if (!queryError) queryError = fail('ROCKETBRAIN_STATE_UNAVAILABLE', 'The statement finished but its transaction state could not be confirmed. Reconnect and inspect the database before rerunning a write.', { queryCompleted: Boolean(result) });
        }
      }
      if (policy.mayWrite) this._editor.invalidate(session.id);
      if (queryError) { queryError.state = this._state(session); throw queryError; }
      result.state = this._state(session); return result;
    });
  }
  async _scriptContext(session){
    await this._ensureConnection(session);
    const result=await this._stream(session,'SELECT @@SESSION.sql_mode, VERSION(), DATABASE(), CONNECTION_ID()',[],{maxRows:2,timeoutMs:5000},false,{category:'metadata',operation:'SELECT'});
    if(result.truncated||result.rows.length!==1||result.rows[0].length!==4)throw fail('ROCKETBRAIN_SCRIPT_CONTEXT','The server SQL context could not be observed.');
    const [mode,version,database,connectionId]=result.rows[0];
    if(typeof mode!=='string'||typeof version!=='string'||database!==this._options.database||!/^[0-9]+$/.test(String(connectionId)))throw fail('ROCKETBRAIN_SCRIPT_CONTEXT','The server SQL context does not match this console.');
    const sqlMode=scriptEngine.normalizeMode(mode.split(',').map(value=>value.trim().toUpperCase()).filter(Boolean));
    await this._refreshState(session);
    return {sqlMode,serverVersion:version,dialect:/mariadb/i.test(version)?'mariadb':'mysql',database,serverConnectionId:String(connectionId),connectionId:session.connectionId};
  }
  async _observeParameterContext(session, script, context) {
    if (!script.parameterDefinitions.length) return {};
    const observed = await this._stream(session, 'SELECT CURRENT_USER(), CURRENT_ROLE(), @@hostname, @@port, @@server_id, @@session.time_zone, @@session.collation_connection',
      [], { maxRows: 1, timeoutMs: 5000 }, false, { category: 'metadata', operation: 'SELECT' });
    const actor = observed.rows[0];
    if (observed.truncated || observed.rows.length !== 1 || actor.length !== 7 ||
      typeof actor[0] !== 'string' || !actor[0] || typeof actor[2] !== 'string' || !actor[2]) {
      throw fail('ROCKETBRAIN_SCRIPT_CONTEXT', 'The current server and account could not be observed for SQL parameter presets.');
    }
    const hints = await inferScriptParameters(script, context.database, async (schema, table) => {
      const result = await this._metadataQuery(
        "SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE,c.CHARACTER_SET_NAME,c.COLLATION_NAME FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON BINARY t.TABLE_SCHEMA=BINARY c.TABLE_SCHEMA AND BINARY t.TABLE_NAME=BINARY c.TABLE_NAME WHERE BINARY c.TABLE_SCHEMA=BINARY ? AND BINARY c.TABLE_NAME=BINARY ? AND t.TABLE_TYPE='BASE TABLE' ORDER BY c.ORDINAL_POSITION",
        [schema, table]);
      return result.rows;
    });
    return { ...hints, parameterAccountScope: scriptEngine.digest(JSON.stringify([context.dialect, context.database, actor])) };
  }
  async _checkPresetContext(session, script, context, expected) {
    const observed = await this._observeParameterContext(session, script, context);
    if (!expected?.accountScope || observed.parameterAccountScope !== expected.accountScope ||
      observed.parameterEvidence !== expected.evidence) {
      throw fail('ROCKETBRAIN_SCRIPT_STALE', 'The database account or parameter column metadata changed. Review the selected preset again.');
    }
  }
  async _reviewScriptCalls(session, script, context) {
    const calls=script.statements.filter(statement=>statement.call);
    const observed=new Map();
    if(!calls.length)return observed;
    if(!session.readOnly||script.hasWrites||calls.length>8) {
      throw fail('ROCKETBRAIN_SCRIPT_CALL','Use a read-only script with up to eight reviewed CALL statements.');
    }
    const query=(sql,values=[])=>this._stream(session,sql,values,{maxRows:35,timeoutMs:5000},false,
      {category:'metadata',operation:operationOf(sql)});
    for(const statement of calls) observed.set(statement.index,await reviewScriptCall(statement,context,query));
    return observed;
  }
  async _scriptTransactionTables(script, context) {
    if (!script.transactionBlock) return [];
    const {parseProjection}=require('./sql-related-source');
    const targets=new Map();
    for (const statement of script.statements) {
      if (statement.transaction) continue;
      const sql=statement.preparedSql ?? statement.sql;
      const tokens=tokenize(sql,false,{sqlMode:context.sqlMode,allowOptimizerHints:false});
      if (tokens.some(token=>token.kind==='variable'||token.kind==='word'&&token.upper==='INTO'&&!statement.mayWrite)) {
        throw transactionError('Keep variable operations outside the reviewed transaction.');
      }
      let location;
      if (statement.mayWrite) {
        location=requireStatementScope({tables:[],connectionReadOnly:false},sql,context.database,
          {mayWrite:true,readOnly:false,sqlMode:context.sqlMode,userSql:true});
      } else {
        if (statement.first!=='SELECT') throw transactionError('Use SELECT or direct InnoDB row changes inside a reviewed transaction.');
        verifyCallableScope(tokens);
        if (tokens.some(token=>token.kind==='word'&&['FROM','JOIN'].includes(token.upper))) {
          const shape=parseProjection(sql,context.database,context.sqlMode);
          if (!shape) throw transactionError('Use a direct column SELECT from one base table inside a read/write transaction.');
          location={schema:shape.schema,name:shape.table};
        }
      }
      if (!location) continue;
      const {schema,name}=location;
      if (schema!==context.database) throw transactionError('Keep a reviewed transaction within the connected schema.');
      const key=JSON.stringify([schema,name]), existing=targets.get(key);
      targets.set(key,{schema,name,write:Boolean(existing?.write||statement.mayWrite)});
    }
    if (targets.size>12) throw transactionError('A reviewed transaction can observe at most 12 base tables.');
    return Promise.all([...targets.values()].map(async target=>{
      const definition=await this._editor.definition(target.name,target.schema);
      if (definition.kind!=='BASE TABLE'||String(definition.engine).toUpperCase()!=='INNODB'||!definition.columns.length||
          target.write&&(!definition.triggerVisibility||definition.triggers.length)) {
        throw transactionError('Use observed InnoDB base tables and write targets without triggers in a reviewed transaction.');
      }
      return {...target,column:definition.columns[0].name,digest:scriptEngine.digest(JSON.stringify(definition))};
    }));
  }
  async describeScript(sql,{sessionId='default',inspectParameters=false}={}){
    const session=this._session(sessionId);
    return this._enqueue(session,async()=>{
      const context=await this._scriptContext(session),script=scriptEngine.analyzeScript(sql,{sqlMode:context.sqlMode,
        readOnly:session.readOnly,allowCalls:true,allowTransactions:true});
      await this._protectScript(session, script, context);
      await this._reviewScriptCalls(session,script,context);
      let parameterContext = {};
      if (inspectParameters) {
        try { parameterContext = await this._observeParameterContext(session, script, context); }
        catch (error) { if (!session.connected || session.needsReconnect) throw error; }
      }
      return structuredClone({...scriptEngine.publicScript(script),...context,...parameterContext,sessionId,state:this._state(session)});
    });
  }
  async previewScript(sql,options={}){
    const session=this._session(options.sessionId),bounded=limits(options),totalTimeoutMs=options.totalTimeoutMs??30000;
    if(!Number.isInteger(totalTimeoutMs)||totalTimeoutMs<100||totalTimeoutMs>scriptEngine.LIMITS.totalTimeoutMs)throw fail('ROCKETBRAIN_SCRIPT_LIMIT','Script timeout must be100ms to120000ms.');
    return this._enqueue(session,async()=>{
      const context=await this._scriptContext(session),script=scriptEngine.bindScript(scriptEngine.analyzeScript(sql,{sqlMode:context.sqlMode,
        readOnly:session.readOnly,allowCalls:true,allowTransactions:true}),options.parameters);
      assertTransactionStart(session,script.transactionBlock);
      await this._protectScript(session, script, context);
      const transactionTables=await this._scriptTransactionTables(script,context);
      const calls=await this._reviewScriptCalls(session,script,context);
      const presetContext = options.presetContext ? { ...options.presetContext } : undefined;
      if (presetContext) await this._checkPresetContext(session, script, context, presetContext);
      if(script.requiresImplicitCommitApproval&&session.inTransaction)throw fail('ROCKETBRAIN_SCRIPT_TRANSACTION','Commit or roll back the existing transaction before reviewing a DDL script.');
      for(const [id,review]of this._scriptReviews)if(Date.now()>review.expiresAt)this._scriptReviews.delete(id);
      while(this._scriptReviews.size>=scriptEngine.LIMITS.reviews)this._scriptReviews.delete(this._scriptReviews.keys().next().value);
      const reviewId=randomUUID(),state=this._state(session),review={reviewId,script,context,state,session,sessionId:session.id,cancellationVersion:session.cancellationVersion,expiresAt:Date.now()+scriptEngine.LIMITS.reviewLifetimeMs,bounded,totalTimeoutMs,presetContext,calls,transactionTables};
      this._scriptReviews.set(reviewId,review);
      const reviewWarning=script.transactionBlock ?
        'This script manages its own transaction. Rocketbrain verifies the final transaction state.' :
        'A script is not an atomic transaction; completed statements are never retried automatically.';
      const reviewed=scriptEngine.publicScript(script);
      for(const statement of reviewed.statements){
        const signature=calls.get(statement.index)?.parameters;
        const outputs=signature?.filter(parameter=>parameter.mode!=='IN');
        if(outputs?.length)statement.call={...statement.call,outputParameters:outputs};
      }
      return structuredClone({...reviewed,...context,reviewId,sessionId:session.id,readOnly:state.readOnly,autocommit:state.autocommit,expiresAt:review.expiresAt,scriptHash:scriptEngine.digest(sql),state,stopOnError:true,autoRetried:false,warnings:[...(script.requiresImplicitCommitApproval?['DDL may implicitly commit earlier statements in this script. It is not transactionally undoable.']:[]),'Preflight checks boundaries, execution policy and parameter types; it does not prove all statements are valid on this server.',reviewWarning]});
    });
  }
  discardScript(reviewId){return this._scriptReviews.delete(reviewId);}
  async listProcedureCalls(options) {
    const query = (sql, values) => this._metadataQuery(sql, values);
    return routineCall.listProcedures(query, await objectSourceContext(query), options);
  }
  async listProcedurePackages(options) {
    const query = (sql, values) => this._metadataQuery(sql, values);
    return routinePackage.listPackages(query, await objectSourceContext(query), options);
  }
  inspectProcedurePackage(target, options) {
    return this._withRoutineSession(async (_session, query) => routinePackage.inspectPackage(query, await objectSourceContext(query), target), options);
  }
  async _withRoutineSession(action, { write = false, guard = () => true, signal } = {}) {
    if (write && this._writeProtection) {
      throw protectionError('Procedure calls are unavailable on a read-only or table-protected profile because their effects cannot be verified.');
    }
    const id = 'routine-' + randomUUID();
    const check = () => {
      if (signal?.aborted) throw routineCall.fail('CANCELLED', 'The procedure operation was cancelled.');
      if (!guard()) throw routineCall.fail('STALE', 'The procedure connection changed. Prepare a new review.');
    };
    const cancel = () => { if (this._sessions.has(id)) void this.cancel(id).catch(() => {}); };
    check();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.openSession(id, { readOnly: !write });
      const session = this._session(id);
      const query = async (sql, values = []) => {
        check();
        const result = await this._stream(session, sql, values, { maxRows: 35, timeoutMs: 5000 }, false,
          { category: 'metadata', operation: operationOf(sql) });
        if (result.truncated) throw routineCall.fail('METADATA', 'The procedure definition exceeds its review limit.');
        return result;
      };
      return await action(session, query, check);
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (!this._disposed) await this.closeSession(id);
    }
  }
  inspectProcedureCall(target, options) {
    return this._withRoutineSession(async (session, query) => routineCall.observeProcedure(query, await objectSourceContext(query), target), options);
  }
  async runProcedureCall(review, inputs, { guard, signal, maxRows = 500, timeoutMs = 10000 } = {}) {
    const bounded = limits({ maxRows, timeoutMs });
    if (review?.object?.kind === 'package-function') return this._runPackageFunction(review, inputs, { guard, signal, timeoutMs: bounded.timeoutMs });
    return this._withRoutineSession(async (session, query, check) => {
      let invoked = false, committed = false;
      try {
        const context = await objectSourceContext(query);
        this._observe(session, await this._control(session, 'START TRANSACTION READ WRITE', bounded.timeoutMs));
        const before = await routineCall.observeProcedure(query, context, review.object);
        if (before.fingerprint !== review.fingerprint) throw routineCall.fail('STALE', 'The server account, procedure definition or input signature changed. Prepare a new review.');
        await this._refreshState(session);
        if (!session.inTransaction) throw routineCall.fail('TRANSACTION', 'The reviewed call could not start an isolated transaction.');
        const { callValues, variableValues, initializeSql, outputs } = routineCall.sessionArguments(before, inputs);
        if (initializeSql) await query(initializeSql, variableValues);
        check();
        invoked = true;
        const report = await this._executeProcedure(session, before.sql, callValues, bounded);
        this._observe(session, report);
        // MariaDB SHOW CREATE does not lock the routine. Recheck after the call before committing any caller-owned work.
        if (context.dialect === 'mariadb') {
          const after = await routineCall.observeProcedure(query, context, review.object);
          if (after.fingerprint !== before.fingerprint) throw routineCall.fail('STALE', 'The procedure definition or session context changed during the call.');
        }
        const outputParameters = await routineCall.readProcedureOutputs(query, outputs);
        if (outputParameters.length && report.resultBytes + Buffer.byteLength(JSON.stringify(outputParameters)) > maxRoutineResultBytes) {
          throw routineCall.fail('RESULT_LIMIT', 'The result sets and output parameters together exceed the 4 MiB limit.');
        }
        check();
        if (session.inTransaction) {
          this._observe(session, await this._control(session, 'COMMIT', bounded.timeoutMs));
          if (session.inTransaction) throw routineCall.fail('TRANSACTION', 'The procedure commit could not be confirmed.');
          committed = true;
        }
        return { ...report, outputParameters, state: 'completed', callerTransactionCommitted: committed,
          definitionCheck: context.dialect === 'mysql' ? 'transaction-pinned' : 'before-and-after',
          sessionId: session.id, sql: before.sql };
      } catch (error) {
        if (session.connected) {
          try { this._observe(session, await this._control(session, 'ROLLBACK', bounded.timeoutMs)); }
          catch (rollbackError) { this._lose(session, rollbackError, invoked); }
        }
        if (!invoked) throw error;
        throw Object.assign(routineCall.fail('EXECUTION', error.message + ' The call may have applied effects. Verify the database before any retry.'),
          { causeCode: error.code, possibleEffects: true, committed });
      }
    }, { guard, signal, write: true });
  }
  async _runPackageFunction(review, inputs, { guard, signal, timeoutMs }) {
    if (this._writeProtection) {
      throw protectionError('Package function calls are unavailable on protected profiles because the full routine effects cannot be verified.');
    }
    const bounded = { maxRows: 1, timeoutMs };
    return this._withRoutineSession(async (session, query, check) => {
      let invoked = false;
      try {
        const context = await objectSourceContext(query);
        const before = await routineCall.observeProcedure(query, context, review.object);
        if (before.fingerprint !== review.fingerprint) throw routineCall.fail('STALE', 'The package function definition or input signature changed. Prepare a new review.');
        const { values } = routineCall.bindProcedure(before.parameters, inputs);
        this._observe(session, await this._control(session, 'START TRANSACTION READ ONLY', bounded.timeoutMs));
        await this._refreshState(session);
        if (!session.readOnly || !session.inTransaction) throw routineCall.fail('TRANSACTION', 'The package function could not start an isolated read-only transaction.');
        check();
        invoked = true;
        const result = await this._stream(session, before.sql, values, bounded, false, { category: 'procedure', operation: 'SELECT' });
        if (result.truncated || result.columns.length !== 1 || result.columns[0] !== 'return_value' || result.rows.length !== 1 || result.rows[0].length !== 1)
          throw routineCall.fail('FUNCTION_RESULT', 'The package function did not return one scalar value.');
        const after = await routineCall.observeProcedure(query, await objectSourceContext(query), review.object);
        if (after.fingerprint !== before.fingerprint) throw routineCall.fail('STALE', 'The package function definition or session context changed during invocation.');
        await this._refreshState(session);
        if (!session.inTransaction) throw routineCall.fail('TRANSACTION', 'The server did not retain the read-only invocation transaction.');
        check();
        this._observe(session, await this._control(session, 'ROLLBACK', bounded.timeoutMs));
        if (session.inTransaction) throw routineCall.fail('TRANSACTION', 'The package function rollback could not be confirmed.');
        return { ...result, resultSets: [result], outputParameters: [], totalRows: 1,
          resultBytes: Buffer.byteLength(JSON.stringify({ columns: result.columns, fields: result.fields, rows: result.rows })),
          returns: before.returns, state: 'completed', callerTransactionCommitted: false, readOnlyInvocation: true,
          definitionCheck: 'before-and-after', sessionId: session.id, sql: before.sql };
      } catch (error) {
        if (session.connected && session.inTransaction) {
          try { this._observe(session, await this._control(session, 'ROLLBACK', bounded.timeoutMs)); }
          catch (rollbackError) { this._lose(session, rollbackError, invoked); }
        }
        if (!invoked) throw error;
        throw Object.assign(routineCall.fail('EXECUTION', error.message + ' The function result was discarded. Inspect the routine before any retry.'),
          { causeCode: error.code, possibleEffects: true, committed: false });
      }
    }, { guard, signal, write: false });
  }

  _executeProcedure(session, sql, values, { maxRows, timeoutMs, mayWrite = true }) {
    return new Promise((resolve, reject) => {
      if (!session.connected) { reject(routineCall.fail('SESSION', 'The procedure connection was lost.')); return; }
      let finished = false, reportOutcome;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (session.active === active) session.active = null;
        try { reportOutcome?.(outcomeOf(error && (error.code || true), false)); } catch { /* Activity is independent. */ }
        if (error) reject(safeError(error)); else resolve(result);
      };
      const active = { mayWrite, abort: finish };
      session.active = active;
      const stop = error => this._lose(session, error, mayWrite);
      const timer = setTimeout(() => stop(routineCall.fail('TIMEOUT', 'The procedure exceeded its time limit and its connection was closed.')), timeoutMs);
      try {
        const command = session.connection.execute({ sql, values, rowsAsArray: true });
        reportOutcome = this._activity(session, { category: 'procedure', operation: 'CALL' });
        collectRoutineResults(command, { maxRows, convertCell: cellValue, stop, finish: (error, result) => {
          if (error?.fatal) stop(safeError(error)); else finish(error, result);
        } });
      } catch (error) { finish(error); }
    });
  }
  async _protectScript(session, script, context) {
    if (!this._writeProtection) return;
    const targets = new Map();
    for (const statement of script.statements) {
      if (statement.transaction) continue;
      const target = requireStatementScope(this._writeProtection, statement.preparedSql || statement.sql, context.database,
        { mayWrite: statement.mayWrite, readOnly: session.readOnly, sqlMode: context.sqlMode, userSql: true });
      if (target) targets.set(JSON.stringify([target.schema, target.name]), target);
    }
    for (const target of targets.values()) await this._ensureSafeProtectedTarget(target);
  }
  async _executeReviewedScriptCall(session, statement, call, context, bounded, assertActive) {
    const plan = { statements: [statement], hasWrites: false };
    const next = await this._reviewScriptCalls(session, plan, context);
    if (next.get(statement.index)?.fingerprint !== call.fingerprint) {
      throw fail('ROCKETBRAIN_SCRIPT_STALE','The procedure changed before CALL.');
    }
    // One private set of slots per console, with no values retained between calls.
    const slots = call.parameters.some(parameter=>parameter.mode!=='IN')
      ? session.scriptProcedureSlots ||= randomUUID().replaceAll('-', '')
      : call.fingerprint;
    const args = routineCall.scriptSessionArguments(call, statement.values, slots);
    const query = (sql, values = [], timeoutMs = assertActive()) =>
      this._executeStream(session, sql, values, { timeoutMs, maxRows: 1 }, false);
    try {
      if (args.initializeSql) await query(args.initializeSql, args.variableValues);
      const report = await this._executeProcedure(session, args.sql, args.callValues,
        { ...bounded, timeoutMs: assertActive(), mayWrite: false });
      this._observe(session, report);
      const after = await this._reviewScriptCalls(session, plan, context);
      if (after.get(statement.index)?.fingerprint !== call.fingerprint || report.resultSets.length !== call.resultSets) {
        throw fail('ROCKETBRAIN_SCRIPT_STALE','The procedure definition or results changed during CALL.');
      }
      const outputParameters = await routineCall.readProcedureOutputs(query, args.outputs);
      const output = routineCall.procedureOutputGrid(outputParameters);
      if (output && report.resultBytes + Buffer.byteLength(JSON.stringify(output)) > maxRoutineResultBytes) {
        throw routineCall.fail('RESULT_LIMIT','The result sets and output parameters together exceed the 4 MiB limit.');
      }
      return {
        columns: [], fields: [], rows: [], rowCount: report.totalRows, affectedRows: report.affectedRows,
        durationMs: report.durationMs, truncated: false, warningCount: report.warningCount,
        resultSets: output ? [...report.resultSets, { ...output, procedureOutput: true }] : report.resultSets,
        ...(output && { outputParameters })
      };
    } finally {
      if (args.clearSql && session.connected) {
        try { await query(args.clearSql, [], Math.min(5000, bounded.timeoutMs)); }
        catch (error) {
          this._lose(session,error);
          throw fail('ROCKETBRAIN_RECONNECT_REQUIRED','The private procedure slots could not be cleared. Reconnect this console.');
        }
      }
    }
  }
  async _pinScriptTransaction(session, review, remaining) {
    for (const {schema,name,column,write} of review.transactionTables) {
      const sql='SELECT '+quoteIdentifier(column)+' FROM '+quoteIdentifier(schema)+'.'+quoteIdentifier(name)+
        ' LIMIT 0'+(write?' FOR UPDATE':'');
      await this._executeStream(session,sql,[],{maxRows:1,timeoutMs:remaining()},false);
    }
    await this._assertScriptTransactionTables(review);
  }
  async _assertScriptTransactionTables(review) {
    const observed=await this._scriptTransactionTables(review.script,review.context);
    if (JSON.stringify(observed)!==JSON.stringify(review.transactionTables)) {
      throw fail('ROCKETBRAIN_SCRIPT_STALE','A transaction table changed. Review the script again.');
    }
  }
  async runScript({reviewId,allowImplicitCommit=false,allowUnboundedDml=false,allowTransactionCommit=false,onStatement,cancellation}={}){
    this._assertOpen();const review=this._scriptReviews.get(reviewId);
    if(!review||Date.now()>review.expiresAt)throw fail('ROCKETBRAIN_SCRIPT_STALE','The script review expired or was already consumed. Review again.');
    if(review.script.requiresImplicitCommitApproval&&!allowImplicitCommit)throw fail('ROCKETBRAIN_SCRIPT_DDL','Explicitly acknowledge possible DDL implicit commits before running this script.');
    if (review.script.statements.some(statement => statement.unboundedDml) && allowUnboundedDml !== true) {
      throw fail('ROCKETBRAIN_UNBOUNDED_DML', 'Review the script statements without an outer WHERE clause before running them.');
    }
    const block=review.script.transactionBlock;
    if (block?.requiresCommitApproval&&allowTransactionCommit!==true) {
      throw transactionError('Explicitly approve committing the reviewed transaction writes.');
    }
    const session=this._session(review.sessionId);
    return this._enqueue(session,async()=>{
      if(this._scriptReviews.get(reviewId)!==review||Date.now()>review.expiresAt)throw fail('ROCKETBRAIN_SCRIPT_STALE','The script review expired or was already consumed.');
      const cancelled=()=>Boolean(cancellation?.isCancellationRequested||cancellation?.aborted);
      if(cancelled())throw fail('ROCKETBRAIN_CANCELLED','The script was cancelled before execution.');
      const context=await this._scriptContext(session),state=this._state(session);
      const stateKeys=['readOnly','autocommit','inTransaction','transactionState','connectionId','needsReconnect','outcomeUnknown'];
      if(review.session!==session||session.cancellationVersion!==review.cancellationVersion||stateKeys.some(key=>state[key]!==review.state[key])||JSON.stringify(context)!==JSON.stringify(review.context))throw fail('ROCKETBRAIN_SCRIPT_STALE','The console connection, transaction mode or SQL mode changed after script review. Review again.');
      assertTransactionStart(session,block);
      await this._protectScript(session, review.script, context);
      if (block) await this._assertScriptTransactionTables(review);
      const actualCalls=await this._reviewScriptCalls(session,review.script,context);
      for(const [index,observed] of actualCalls) {
        if(observed.fingerprint!==review.calls.get(index)?.fingerprint) {
          throw fail('ROCKETBRAIN_SCRIPT_STALE','The server procedure changed after script review. Review the script again.');
        }
      }
      if(cancelled()||session.cancellationVersion!==review.cancellationVersion||Date.now()>review.expiresAt) {
        throw fail('ROCKETBRAIN_SCRIPT_STALE','The script review changed before execution. Review again.');
      }
      if (review.presetContext) {
        await this._checkPresetContext(session, review.script, context, review.presetContext);
        if (cancelled() || session.cancellationVersion !== review.cancellationVersion || Date.now() > review.expiresAt) {
          throw fail('ROCKETBRAIN_SCRIPT_STALE', 'The saved parameter review changed before execution. Review again.');
        }
      }
      if(review.script.requiresImplicitCommitApproval&&session.inTransaction)throw fail('ROCKETBRAIN_SCRIPT_TRANSACTION','An existing transaction must be explicitly finished before DDL script execution.');
      this._scriptReviews.delete(reviewId);
      session.scriptRunning=true;
      const started=performance.now(),stateBefore=this._state(session),statements=review.script.statements.map(statement=>({index:statement.index,start:statement.start,end:statement.end,sql:statement.sql,first:statement.first,mayWrite:statement.mayWrite,ddl:statement.ddl,status:'not-run'}));
      let bytes=0,stopReason=null,resultState='completed',completed=0,failed=0,subscription;
      let ownedTransaction=false,commitPending=false,transactionOutcome='not-started';
      const remaining=()=>{
        if (cancelled()||session.cancellationVersion!==review.cancellationVersion) throw fail('ROCKETBRAIN_CANCELLED','The script was cancelled.');
        const left=Math.floor(review.totalTimeoutMs-(performance.now()-started));
        if (left<1) throw fail('ROCKETBRAIN_TIMEOUT','The reviewed transaction ran out of time.');
        return Math.min(left,review.bounded.timeoutMs);
      };
      const stop=()=>{session.cancellationVersion++;if(session.active)this._lose(session,fail('ROCKETBRAIN_CANCELLED','The script cancellation closed its owned console connection. Inspect a write outcome before reconnecting.'),session.active.mayWrite);};
      if(cancellation?.onCancellationRequested)subscription=cancellation.onCancellationRequested(stop);
      else if(cancellation?.addEventListener){cancellation.addEventListener('abort',stop,{once:true});subscription={dispose:()=>cancellation.removeEventListener('abort',stop)};}
      try{
        for(const statement of review.script.statements){
          const entry=statements[statement.index],elapsed=performance.now()-started;
          if(cancelled()||session.cancellationVersion!==review.cancellationVersion){resultState='cancelled';stopReason='cancelled';break;}
          if(session.closed||session.needsReconnect||!session.connected){resultState='stopped';stopReason='connection-unavailable';break;}
          if(elapsed>=review.totalTimeoutMs){resultState='stopped';stopReason='script-time-limit';break;}
          entry.stateBefore=this._state(session);const statementStart=performance.now();let result,error;
          try{
            const bounded={maxRows:review.bounded.maxRows,timeoutMs:Math.max(1,Math.floor(Math.min(review.bounded.timeoutMs,review.totalTimeoutMs-elapsed)))};
            const call=actualCalls.get(statement.index);
            if (statement.transaction) {
              const operation=statement.transaction,begin=operation.kind==='begin',end=['commit','rollback'].includes(operation.kind);
              if (!begin&&(!ownedTransaction||!session.inTransaction)) throw transactionError('The reviewed transaction lost its server state.');
              const timeoutMs=remaining();
              if (operation.kind==='commit') commitPending=true;
              const control=await this._control(session,transactionSql(operation,block),timeoutMs,commitPending&&block.requiresCommitApproval);
              if (begin) ownedTransaction=true;
              this._observe(session,control);
              if (session.inTransaction===end||!session.autocommit) throw transactionError('The transaction did not reach its reviewed server state.');
              if (end) {
                ownedTransaction=false;
                commitPending=false;
                transactionOutcome=operation.kind==='commit'?'committed':'rolled-back';
              } else if (begin) {
                await this._pinScriptTransaction(session,review,remaining);
              }
              result={columns:[],fields:[],rows:[],rowCount:0,affectedRows:0,truncated:false,warningCount:control.warningStatus||0};
            } else if(call) {
              result=await this._executeReviewedScriptCall(session,statement,call,context,bounded,remaining);
            } else result=await this._stream(session,statement.preparedSql,statement.values,bounded,statement.mayWrite,
              {category:'script',operation:statement.first,sqlMode:context.sqlMode});
          }catch(failure){error=failure;}
          if(session.connected)try{await this._refreshState(session);}catch(failure){if(statement.mayWrite)session.outcomeUnknown=true;if(!error)error=fail('ROCKETBRAIN_STATE_UNAVAILABLE','The statement finished but its transaction state could not be confirmed.',{queryCompleted:Boolean(result)});}
          if (ownedTransaction&&!session.inTransaction&&!error) error=transactionError('The server ended the reviewed transaction before its final statement.');
          if(statement.mayWrite)this._editor.invalidate(session.id);
          entry.durationMs=Math.round((performance.now()-statementStart)*100)/100;entry.stateAfter=this._state(session);
          if(error){entry.status='failed';entry.error={code:error.code||'MYSQL_ERROR',message:error.message,queryCompleted:Boolean(error.queryCompleted),outcomeUnknown:Boolean(session.outcomeUnknown)};failed++;resultState=cancelled()||error.code==='ROCKETBRAIN_CANCELLED'?'cancelled':'failed';stopReason=entry.error.code;try{onStatement?.(structuredClone(entry));}catch{}break;}
          entry.status='completed';completed++;result.state=entry.stateAfter;
          const size=Buffer.byteLength(JSON.stringify(result));
          if(bytes+size>scriptEngine.LIMITS.resultBytes){entry.result={...result,rows:[],fields:[],columns:[],resultSets:undefined,resultOmitted:true,warning:'The script aggregate result limit was reached; this fully drained statement was not retained.'};resultState='stopped';stopReason='script-result-limit';}
          else{entry.result=result;bytes+=size;}
          try{onStatement?.(structuredClone(entry));}catch{}
          if(stopReason)break;
          if(session.needsReconnect||result.truncated){resultState='stopped';stopReason='statement-result-limit';break;}
          const nextContext=await this._scriptContext(session);
          if(JSON.stringify(nextContext)!==JSON.stringify(review.context)){resultState='stopped';stopReason='sql-context-changed';break;}
        }
      }catch(error){resultState=cancelled()?'cancelled':'stopped';stopReason=error.code||'context-observation-failed';}
      finally{
        subscription?.dispose();
        try {
          if (ownedTransaction&&session.connected) {
            const rollback=await this._control(session,transactionSql({kind:'rollback'},block));
            this._observe(session,rollback);
            if (session.inTransaction) throw transactionError('The automatic rollback could not be confirmed.');
            transactionOutcome=commitPending?'unknown':'rolled-back-after-stop';
          } else if (ownedTransaction||commitPending) {
            transactionOutcome='unknown';
          }
        } catch (error) {
          this._lose(session,error,Boolean(block?.requiresCommitApproval));
          transactionOutcome='unknown';
        } finally {
          if (transactionOutcome==='unknown'&&block?.requiresCommitApproval) session.outcomeUnknown=true;
          session.scriptRunning=false;
        }
      }
      return {reviewId,sessionId:session.id,scriptHash:scriptEngine.digest(review.script.sql),state:resultState,statements,completed,failed,notRun:statements.filter(entry=>entry.status==='not-run').length,stopReason,durationMs:Math.round((performance.now()-started)*100)/100,stateBefore,stateAfter:this._state(session),atomic:false,autoRetried:false,resultBytes:bytes,parameterBindingsIncluded:false,resultMayContainParameterValues:true,...(block&&{transactionOutcome})};
    });
  }
  async _protectedParents({ schema, name }, definition) {
    const expected = new Map(definition.foreignKeys.map(([constraint, , , parentSchema, parentName]) => (
      [constraint, { schema: parentSchema, name: parentName }]
    )));
    const tokens = tokenize(definition.createSql, false);
    const declared = tokens.filter((token, index) => token.kind === 'word' && token.upper === 'FOREIGN'
      && tokens[index + 1]?.kind === 'word' && tokens[index + 1].upper === 'KEY').length;
    const observed = await this._metadataQuery(
      'SELECT CONSTRAINT_NAME,UNIQUE_CONSTRAINT_SCHEMA,REFERENCED_TABLE_NAME,UPDATE_RULE,DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME=? ORDER BY CONSTRAINT_NAME',
      [schema, name]);
    if (declared !== expected.size || observed.rows.length !== expected.size) {
      throw protectionError('Foreign key metadata for a protected table could not be verified.');
    }
    const parents = [];
    for (const [constraint, parentSchema, parentName, updateRule, deleteRule] of observed.rows) {
      const parent = expected.get(constraint);
      if (!parent || parent.schema !== parentSchema || parent.name !== parentName ||
        !FOREIGN_KEY_RULES.has(updateRule) || !FOREIGN_KEY_RULES.has(deleteRule)) {
        throw protectionError('Foreign key metadata for a protected table could not be verified.');
      }
      expected.delete(constraint);
      if (CASCADE_RULES.has(updateRule) || CASCADE_RULES.has(deleteRule)) parents.push(parent);
    }
    return parents;
  }
  async _ensureSafeProtectedTarget(target, pin) {
    const observed = new Map();
    const observe = async table => {
      const key = JSON.stringify([table.schema, table.name]);
      if (!observed.has(key)) {
        if (observed.size >= MAX_PROTECTED_DEPENDENCIES) throw protectionError('The protected table dependencies exceed the supported limit.');
        await pin?.(table);
        const definition = await this._editor.definition(table.name, table.schema);
        if (definition.kind !== 'BASE TABLE' || String(definition.engine).toUpperCase() !== 'INNODB') {
          throw protectionError('This profile permits writes only when the target and protected dependencies are InnoDB base tables.');
        }
        observed.set(key, definition);
      }
      return observed.get(key);
    };
    const definition = await observe(target);
    if (!definition.triggerVisibility || definition.triggers.length) {
      throw protectionError('This profile permits writes only to InnoDB base tables with verified trigger visibility and no triggers.');
    }
    // A cascade into a protected table must pass one of these child-side foreign keys.
    // Pin each child before reading its outgoing dependency edges.
    const pending = new Map(this._writeProtection.tables.map(table => [JSON.stringify([table.schema, table.name]), table]));
    for (const table of pending.values()) {
      if (table.schema.toLowerCase() === target.schema.toLowerCase() && table.name.toLowerCase() === target.name.toLowerCase()) {
        throw protectionError('This write could cascade to a table protected by the connection profile.');
      }
      for (const parent of await this._protectedParents(table, await observe(table))) {
        const key = JSON.stringify([parent.schema, parent.name]);
        if (pending.has(key)) continue;
        if (pending.size >= MAX_PROTECTED_DEPENDENCIES) throw protectionError('The protected table dependencies exceed the supported limit.');
        pending.set(key, parent);
      }
    }
  }
  async _pinnedProtectedWrite(session, target, timeoutMs, executeWrite) {
    const started = !session.inTransaction;
    const cancelVersion = session.cancellationVersion;
    const autoCommit = session.autocommit;
    const deadline = performance.now() + timeoutMs;
    let committing = false;
    const remaining = () => {
      if (!session.connected || session.cancellationVersion !== cancelVersion) throw fail('ROCKETBRAIN_CANCELLED', 'The protected write was cancelled.');
      if (!session.inTransaction) throw protectionError('The protected write lost its database transaction.');
      const left = Math.floor(deadline - performance.now());
      if (left < 1) throw fail('ROCKETBRAIN_TIMEOUT', 'The protected write exceeded its verification time limit.');
      return left;
    };
    try {
      if (session.readOnly) throw protectionError('Use a writable console for a protected profile write.');
      if (started) this._observe(session, await this._control(session, 'START TRANSACTION READ WRITE', timeoutMs));
      await this._ensureSafeProtectedTarget(target, async ({ schema, name }) => {
        const sql = 'SELECT 1 FROM ' + quoteIdentifier(schema) + '.' + quoteIdentifier(name) + ' LIMIT 0 FOR UPDATE';
        await this._executeStream(session, sql, [], { maxRows: 1, timeoutMs: remaining() }, false);
      });
      const result = await executeWrite(remaining());
      if (started && autoCommit) {
        const commitTimeout = remaining();
        committing = true;
        this._observe(session, await this._control(session, 'COMMIT', commitTimeout));
        if (session.inTransaction) throw protectionError('The protected write commit could not be confirmed.');
      }
      return result;
    } catch (error) {
      if (committing) session.outcomeUnknown = true;
      if (started && session.connected && session.inTransaction) {
        try { this._observe(session, await this._control(session, 'ROLLBACK')); }
        catch (rollbackError) { this._lose(session, rollbackError, committing); }
      }
      throw error;
    }
  }
  async _stream(session, sql, values, { maxRows, timeoutMs }, mayWrite, activity) {
    const userSql = activity?.category === 'query' || activity?.category === 'script';
    const target = requireStatementScope(this._writeProtection, sql, session.database,
      { mayWrite, readOnly: session.readOnly, userSql, sqlMode: activity?.sqlMode });
    const execute = left => this._executeStream(session, sql, values, { maxRows, timeoutMs: left }, mayWrite, activity);
    return target ? this._pinnedProtectedWrite(session, target, timeoutMs, execute) : execute(timeoutMs);
  }
  _executeStream(session, sql, values, { maxRows, timeoutMs }, mayWrite, activity) {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let finished = false, bytes = 0, reportOutcome;
      const result = { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0, affectedRows: 0, warningCount: 0, fields: [] };
      const finish = error => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (session.active === active) session.active = null;
        try { reportOutcome?.(outcomeOf(error && (error.code || true), result.truncated)); } catch { /* Recording is independent of the query. */ }
        if (error) reject(safeError(error));
        else { result.rowCount = result.rows.length; result.durationMs = Math.round((performance.now() - started) * 100) / 100; resolve(result); }
      };
      const active = { mayWrite, abort: finish };
      session.active = active;
      const timer = setTimeout(() => this._lose(session, fail('ROCKETBRAIN_TIMEOUT', 'The query exceeded ' + timeoutMs + ' ms. Its server session was closed; reconnect explicitly.')), timeoutMs);
      const truncate = message => {
        result.truncated = true; result.warning = message;
        this._lose(session, fail('ROCKETBRAIN_RESULT_LIMIT', message), mayWrite, false); finish();
      };
      try {
        // Binary-protocol binding avoids SQL_MODE-dependent value escaping.
        const options = { sql, rowsAsArray: true, typeCast: preserveGeometry };
        const query = values.length ? session.connection.execute({ ...options, values })
          : session.connection.query(options);
        reportOutcome = this._activity(session, activity || driverActivity(sql));
        query.on('fields', fields => {
          if (finished || !fields) return;
          result.columns = fields.map(field => String(field.name));
          result.fields = fields.map(field => ({ name: String(field.name), schema: field.schema || '', table: field.table || '',
            originalTable: field.orgTable || '', originalName: field.orgName || '', type: field.columnType ?? null, flags: field.flags ?? 0,
            characterSet: field.characterSet ?? null }));
          bytes = Buffer.byteLength(JSON.stringify(result.columns) + JSON.stringify(result.fields), 'utf8');
          if (bytes > MAX_RESULT_BYTES) this._lose(session, fail('ROCKETBRAIN_RESULT_LIMIT', 'The result column metadata exceeds 4 MiB.'), mayWrite);
        });
        query.on('result', row => {
          if (finished) return;
          if (!Array.isArray(row)) {
            if (!row || !Number.isInteger(row.affectedRows)) { this._lose(session, fail('ROCKETBRAIN_RESULT_INVALID', 'The server returned an unsupported result.'), mayWrite); return; }
            result.affectedRows = row.affectedRows; result.warningCount = row.warningStatus || 0;
            if (row.insertId != null) result.insertId = String(row.insertId);
            return;
          }
          if (result.rows.length >= maxRows) { truncate('The row limit was reached. This console connection was closed; reconnect before running more SQL.'); return; }
          let normalized;
          const cells = {};
          try {
            normalized = row.map((value, column) => {
              const geometry = result.fields[column]?.type === geometryType ? captureGeometry(value) : undefined;
              if (!geometry) return cellValue(value);
              cells[column] = geometry.observation;
              return geometry.display;
            });
          }
          catch { this._lose(session, fail('ROCKETBRAIN_RESULT_INVALID', 'A result cell could not be represented.'), mayWrite); return; }
          const spatial = Object.keys(cells).length ? { row: result.rows.length, cells } : undefined;
          const rowBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8') +
            (spatial ? Buffer.byteLength(JSON.stringify(spatial), 'utf8') : 0);
          if (bytes + rowBytes > MAX_RESULT_BYTES) {
            if (!result.rows.length) this._lose(session, fail('ROCKETBRAIN_RESULT_LIMIT', 'One result row exceeds the 4 MiB preview limit.'), mayWrite);
            else truncate('The 4 MiB result limit was reached. This console connection was closed; reconnect before running more SQL.');
            return;
          }
          if (spatial) {
            result.spatial ||= [];
            result.spatial.push(spatial);
          }
          bytes += rowBytes; result.rows.push(normalized);
        });
        query.on('error', error => {
          if (error?.fatal) this._lose(session, safeError(error), mayWrite);
          else finish(error);
        });
        query.on('end', () => finish());
      } catch (error) { if (error?.fatal) this._lose(session, safeError(error), mayWrite); else finish(error); }
    });
  }
  async _transaction(sql, options = {}, { requireIdle = false, commitRisk = false } = {}) {
    const session = this._session(options.sessionId);
    return this._enqueue(session, async () => {
      await this._ensureConnection(session);
      if (requireIdle && session.inTransaction) throw new Error('Commit or roll back the active transaction first.');
      let result;
      try { result = await this._control(session, typeof sql === 'function' ? sql(session) : sql); }
      catch (error) {
        if (session.connected) {
          try { await this._refreshState(session); } catch {}
        }
        error.state = this._state(session); throw error;
      }
      try { this._observe(session, result); }
      catch (error) { this._lose(session, error, commitRisk); throw error; }
      this._editor.invalidate(session.id);
      return this._state(session);
    });
  }
  async begin(options = {}) {
    return this._transaction(session => 'START TRANSACTION ' + (session.readOnly ? 'READ ONLY' : 'READ WRITE'), options, { requireIdle: true });
  }
  commit(options = {}) { return this._transaction('COMMIT', options, { commitRisk: true }); }
  rollback(options = {}) { return this._transaction('ROLLBACK', options); }
  async setReadOnly(readOnly, options = {}) {
    if (typeof readOnly !== 'boolean') throw new Error('readOnly must be a boolean.');
    requireConnectionMode(this._writeProtection, readOnly);
    const session = this._session(options.sessionId);
    return this._enqueue(session, async () => {
      await this._ensureConnection(session);
      if (session.inTransaction) throw new Error('Commit or roll back before changing the console read/write mode.');
      const result = await this._control(session, 'SET SESSION TRANSACTION ' + (readOnly ? 'READ ONLY' : 'READ WRITE'));
      this._observe(session, result); session.readOnly = readOnly; session.everWritable ||= !readOnly;
      this._editor.invalidate(session.id); return this._state(session);
    });
  }
  async setAutocommit(enabled, options = {}) {
    if (typeof enabled !== 'boolean') throw new Error('autocommit must be a boolean.');
    const session = this._session(options.sessionId);
    return this._enqueue(session, async () => {
      await this._ensureConnection(session);
      if (session.inTransaction) throw new Error('Commit or roll back before changing autocommit; enabling it would implicitly commit.');
      const result = await this._control(session, 'SET SESSION autocommit = ' + (enabled ? '1' : '0'));
      this._observe(session, result); this._editor.invalidate(session.id); return this._state(session);
    });
  }
  async _observeIsolation(session) {
    session.transactionIsolation = null;
    const result = await this._stream(session,
      "SHOW SESSION VARIABLES WHERE Variable_name IN ('transaction_isolation', 'tx_isolation')",
      [], { maxRows: 2, timeoutMs: 5000 }, false);
    await this._refreshState(session);
    session.transactionIsolation = serverIsolationLevel(result);
    return this._state(session);
  }
  async getTransactionIsolation(options = {}) {
    const session = this._session(options.sessionId);
    return this._enqueue(session, async () => {
      await this._ensureConnection(session);
      return this._observeIsolation(session);
    });
  }
  async setTransactionIsolation(value, { sessionId, expectedConnectionId, expectedIsolation, beforeChange } = {}) {
    const level = isolationLevel(value), session = this._session(sessionId);
    return this._enqueue(session, async () => {
      await this._ensureConnection(session);
      if (expectedConnectionId !== undefined && session.connectionId !== expectedConnectionId) {
        throw new Error('This console reconnected after the isolation picker opened. Open it again.');
      }
      await this._observeIsolation(session);
      if (session.inTransaction || session.outcomeUnknown) {
        throw new Error('Resolve any active or uncertain transaction before changing isolation.');
      }
      if (expectedIsolation !== undefined && session.transactionIsolation !== expectedIsolation) {
        throw new Error('This console isolation level changed after the picker opened. Open it again.');
      }
      beforeChange?.();
      if (session.transactionIsolation === level) return this._state(session);
      const result = await this._control(session, 'SET SESSION TRANSACTION ISOLATION LEVEL ' + level);
      this._editor.invalidate(session.id);
      for (const [id, review] of this._scriptReviews) if (review.sessionId === session.id) this._scriptReviews.delete(id);
      try {
        this._observe(session, result);
        const state = await this._observeIsolation(session);
        if (state.transactionIsolation !== level) throw fail('ROCKETBRAIN_ISOLATION_NOT_OBSERVED', 'The server reported a different isolation level.');
        return state;
      } catch (error) {
        this._lose(session, error);
        error.state = this._state(session);
        throw error;
      }
    });
  }
  async cancel(id = 'default') {
    const session = this._session(id);
    session.cancellationVersion++;
    if (session.active) this._lose(session, fail('ROCKETBRAIN_CANCELLED', 'Cancellation requested. The connection was closed; the server outcome is unconfirmed. Reconnect explicitly.'), Boolean(session.active.mayWrite));
    return this._state(session);
  }
  async reconnect(id = 'default') {
    const session = this._session(id);
    if (session.active) throw new Error('Cancel or finish the current query before reconnecting.');
    return this._enqueue(session, async () => {
      if (session.connected && session.inTransaction) throw new Error('Commit or roll back before reconnecting an active transaction.');
      if (session.connection) { const connection = session.connection; session.connection = null; connection.destroy(); }
      session.connected = false; session.connectionId = null; session.needsReconnect = false;
      session.autocommit = true; session.inTransaction = false; session.transactionState = 'idle';
      session.transactionIsolation = null;
      // Reconnect does not prove an earlier write's outcome and replays no SQL.
      this._editor.invalidate(session.id);
      for(const [reviewId,review]of this._scriptReviews)if(review.sessionId===id)this._scriptReviews.delete(reviewId);
      await this._ensureConnection(session); return this._state(session);
    }, { allowReconnect: true });
  }
  async closeSession(id = 'default') {
    const session = this._sessions.get(this._id(id));
    if (!session) return;
    session.closed = true; this._lose(session, fail('ROCKETBRAIN_SESSION_CLOSED', 'This console session has been closed.'));
    this._editor.invalidate(id);
    for(const [reviewId,review]of this._scriptReviews)if(review.sessionId===id)this._scriptReviews.delete(reviewId);
    this._sessions.delete(id);
  }
  async _metadataQuery(sql, values = []) {
    const session = this._metadataSession;
    // Introspection owns no user state or writes. A requested refresh may open
    // a fresh metadata connection after loss; console sessions never do this.
    if (session.needsReconnect && !session.active) {
      session.needsReconnect = false; session.inTransaction = false; session.transactionState = 'idle';
    }
    return this._enqueue(session, async () => {
      await this._ensureConnection(session);
      const result = await this._stream(session, sql, parameters(values), { maxRows: 5000, timeoutMs: 10000 }, false,
        { category: 'metadata', operation: operationOf(sql) });
      if (result.truncated) throw new Error('The metadata exceeds the 5000-row or 4 MiB limit. Narrow the database scope.');
      await this._refreshState(session); return result;
    });
  }
  async explainQueryPlan(sql, { assertCurrent, format = 'json' } = {}) {
    const { explainSql, normalizePlan } = require('./explain-plan');
    // Detect unsafe or ambiguous input before opening an introspection session.
    explainSql(sql, undefined, format);
    const context = await this._metadataQuery('SELECT VERSION(), DATABASE(), @@SESSION.sql_mode');
    const [version, database, mode] = context.rows[0] ?? [];
    if (typeof version !== 'string' || typeof database !== 'string' || typeof mode !== 'string') {
      throw Error('Could not confirm the database and SQL mode for visual EXPLAIN.');
    }
    const engine = /mariadb/i.test(version) ? 'mariadb' : 'mysql';
    if (engine !== 'mysql' && format === 'tree') throw Error('Use JSON with this MariaDB connection. MySQL TREE text requires MySQL.');
    const statement = explainSql(sql, mode.split(',').filter(Boolean), format);
    assertCurrent?.();
    const result = await this._metadataQuery(statement);
    if (result.rows.length !== 1 || result.rows[0].length !== 1) throw Error('Expected one plan from the server.');
    return normalizePlan({ raw: result.rows[0][0], engine, version, database, format });
  }
  async measureQueryPlan(sql, { assertCurrent, cancellation } = {}) {
    const { validatePlanQuery, measuredSql, normalizePlan } = require('./explain-plan');
    validatePlanQuery(sql, undefined, { measured: true });
    this._assertOpen();
    if (this._measurementSession) throw Error('Wait for the current query measurement.');
    const session = newSession('query-measurement', true, this._options.database);
    this._measurementSession = session;
    const cancelled = () => fail('ROCKETBRAIN_CANCELLED', 'The query measurement was cancelled.');
    let subscription;
    const check = () => {
      if (cancellation?.isCancellationRequested) throw cancelled();
      this._assertOpen();
      assertCurrent?.();
    };
    try {
      subscription = cancellation?.onCancellationRequested?.(() => this._lose(session, cancelled()));
      check();
      await this._ensureConnection(session);
      check();
      const context = await this._stream(session, 'SELECT VERSION(), DATABASE(), @@SESSION.sql_mode', [], { maxRows: 2, timeoutMs: 5000 }, false);
      const [version, database, mode] = context.rows[0] ?? [];
      if (typeof version !== 'string' || database !== this._options.database || typeof mode !== 'string') {
        throw Error('Could not confirm the database and SQL mode for query measurement.');
      }
      const engine = /mariadb/i.test(version) ? 'mariadb' : 'mysql';
      const statement = measuredSql(sql, mode.split(',').filter(Boolean), engine);
      check();
      await this._control(session, engine === 'mysql' ? 'SET SESSION max_execution_time = 8000' : 'SET SESSION max_statement_time = 8');
      check();
      this._observe(session, await this._control(session, 'START TRANSACTION READ ONLY'));
      check();
      let result;
      try {
        result = await this._stream(session, statement, [], { maxRows: 1, timeoutMs: 10000 }, false,
          { category: 'query', operation: engine === 'mysql' ? 'EXPLAIN' : 'ANALYZE' });
      } catch (error) {
        if (['ER_QUERY_TIMEOUT', 'ER_STATEMENT_TIMEOUT'].includes(error.code)) {
          throw fail('ROCKETBRAIN_TIMEOUT', 'The server stopped the measurement at its time limit.');
        }
        throw error;
      }
      check();
      if (result.truncated || result.rows.length !== 1 || result.rows[0].length !== 1) throw Error('Expected one measurement plan from the server.');
      return normalizePlan({ raw: result.rows[0][0], engine, version, database, measured: true,
        format: engine === 'mysql' ? 'tree' : 'json' });
    } finally {
      subscription?.dispose();
      session.closed = true;
      this._lose(session, fail('ROCKETBRAIN_CLOSED', 'The isolated measurement session closed.'));
      if (this._measurementSession === session) this._measurementSession = undefined;
    }
  }
  async schema() {
    const result = await this._metadataQuery('SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION', [this._options.database]);
    const tables = new Map();
    for (const [tableName, name, type, key] of result.rows) {
      if (!tables.has(tableName)) tables.set(tableName, { name: tableName, columns: [] });
      tables.get(tableName).columns.push({ name, type, primaryKey: key === 'PRI' });
    }
    return [...tables.values()];
  }
  async metadata() {
    this._assertOpen();
    let connection;
    const read = async (sql, values) => {
      const result = await this._metadataQuery(sql, values);
      const active = this._metadataSession.connection;
      if (!active || connection && active !== connection) throw Error('The metadata session changed. Refresh the full catalog again.');
      connection = active;
      return result;
    };
    const catalog=await readMetadata(read,this._options.database,++this._revision, undefined, { exactScope: true });
    try {
      const result=await read('SELECT VERSION(), @@sql_mode, @@lower_case_table_names',[]);
      const [version,mode,folding]=result.rows[0];
      catalog.serverVersion=String(version);catalog.dialect=/mariadb/i.test(version)?'mariadb':'mysql';catalog.sqlMode=String(mode).split(',').filter(Boolean);catalog.tableNameCaseSensitive=Number(folding)===0;catalog.semanticContextObserved=true;
    }catch{catalog.semanticContextObserved=false;catalog.warnings.push({area:'semanticContext',message:'Server SQL mode and identifier rules could not be observed.'});}
    if (catalog.semanticContextObserved) {
      await attachCheckMetadata(read, catalog);
      if (connection && connection === this._metadataSession.connection) this._catalogConnections.set(catalog, connection);
    }
    if (connection && connection !== this._metadataSession.connection) {
      throw Error('The metadata session changed. Refresh the full catalog again.');
    }
    return catalog;
  }
  async _relationshipCatalog(read, request) {
    this._assertOpen();
    let connection;
    const query = async (sql, values) => {
      const result = await this._metadataQuery(sql, values);
      const active = this._metadataSession.connection;
      if (!active || connection && connection !== active) throw Error('The metadata session changed while inspecting the relationship. Inspect again.');
      connection = active;
      return result;
    };
    return read(query, this._options.database, request, ++this._revision);
  }
  relationshipTargetCatalog(request) {
    return this._relationshipCatalog(readForeignKeyTargetCatalog, request);
  }
  relationshipJoinCatalog(request) {
    return this._relationshipCatalog(readRelationshipJoinCatalog, request);
  }
  async refreshCatalog(request) {
    const connection = this._catalogConnections.get(request.before);
    const assertCurrent = () => {
      request.assertCurrent?.();
      if (!connection || connection !== this._metadataSession.connection) {
        throw Error('The metadata session changed. Refresh the full catalog first.');
      }
    };
    assertCurrent();
    const result = await this._relationshipCatalog(readCatalogRefresh, { ...request, assertCurrent });
    assertCurrent();
    this._catalogConnections.set(result.catalog, connection);
    return result;
  }
  relatedRowsCatalog(request) { return this._relationshipCatalog(readRelatedCatalog, request); }
  crossLogicalEndpoint(request) { return this._relationshipCatalog(require('./cross-schema-logical').visibleEndpoint, request); }
  inspectCrossLogical(request) { return this._relationshipCatalog(require('./cross-schema-logical').inspectCrossLogical, request); }
  canFollowSqlResult(sessionId, connectionId) {
    const session = this._sessions.get(sessionId);
    return Boolean(session && session.connectionId === connectionId && session.connected && !session.closed &&
      session.readOnly && !session.everWritable && session.autocommit && !session.inTransaction &&
      !session.needsReconnect && !session.outcomeUnknown);
  }
  _sqlRelatedServer(session) {
    const { sourceServer } = require('./sql-related-source');
    return sourceServer(sql => this._stream(session, sql, [], { maxRows: 2, timeoutMs: 3000 }, false,
      { category: 'metadata', operation: 'SELECT' }));
  }
  async matchesRelatedRoute(sessionId, server) {
    const session = this._session(sessionId);
    return this._enqueue(session, async () => session.readOnly && session.autocommit && !session.inTransaction && session.connected &&
      await this._sqlRelatedServer(session) === server);
  }
  async captureSqlRowSource(sql, result, sessionId) {
    if (!result.rows.length || !this.canFollowSqlResult(sessionId, result.state?.connectionId)) return null;
    const { sourceServer, parseProjection, describeSource, proveProjection } = require('./sql-related-source');
    const shape = parseProjection(sql, this._options.database);
    if (!shape) return null;
    const session = this._session(sessionId), connectionId = result.state.connectionId;
    const server = await this._enqueue(session, () => {
      return this.canFollowSqlResult(sessionId, connectionId) ? this._sqlRelatedServer(session) : null;
    });
    if (!server) return null;
    const observed = await this._relationshipCatalog(async (query, _database, target) => {
      return await sourceServer(query) === server ? describeSource(query, target) : null;
    }, shape);
    const source = this.canFollowSqlResult(sessionId, connectionId) ? proveProjection(result, shape, observed) : null;
    return source && { ...source, server };
  }
  recheckSqlRowSource(request) {
    return this._relationshipCatalog(require('./sql-related-source').recheckSource, request);
  }
  joinCompletionCatalog(request) { return this._relationshipCatalog(readJoinCatalog, request); }
  previewTable(name, options) { return this._editor.previewTable(name, options); }
  openKeysetBrowser(name, options) { return this._editor.openKeysetBrowser(name, options); }
  readKeysetPage(id, options, adjacentTo) { return this._editor.readKeysetPage(id, options, adjacentTo); }
  closeKeysetBrowser(id) { return this._editor.closeKeysetBrowser(id); }
  previewRelatedTable(target, options) { return this._editor.previewRelatedTable(target, options); }
  retainTableSnapshot(binding) { return this._editor.retainTableSnapshot(binding); }
  stageGridPaste(request) { return this._editor.stagePaste(request); }
  releaseTableSnapshot(binding) { return this._editor.releaseTableSnapshot(binding); }
  reviewChangeSet(changes) { return this._editor.reviewChangeSet(changes); }
  captureChangeSetReview(request) { return this._editor.captureReview(request); }
  rebindChangeSetReview(request) { return this._editor.rebindReview(request); }
  applyChangeSet(review) { return this._editor.applyChangeSet(review); }
  listSchemaObjects() { return this._objectEditor.list(); }
  inspectSchemaObject(request) { return this._objectEditor.inspect(request); }
  previewSchemaObject(request) { return this._objectEditor.preview(request); }
  applySchemaObject(request) { return this._objectEditor.apply(request); }
  discardSchemaObject(id) { return this._objectEditor.discard(id); }
  listSchemaObjectRecoveries() { return this._objectEditor.listRecoveries(); }
  recoverSchemaObject(request) { return this._objectEditor.recover(request); }
  openTableDesigner(request) { return this._schemaDesigner.open(request); }
  previewTableDesign(request) { return this._schemaDesigner.preview(request); }
  applyTableDesign(request) { return this._schemaDesigner.apply(request); }
  discardTableDesign(reviewId) { return this._schemaDesigner.discard(reviewId); }
  previewSchemaRename(request) { if(this._schemaApplier.applying||this._schemaRecovery.applying||this._streamImportState?.running||this._streamImportState?.pending)throw fail('ROCKETBRAIN_SCHEMA_BUSY','Wait for schema application/import to finish.');return this._schemaRenamer.preview(request); }
  listSchemaPrograms() { return this._schemaRecovery.listPrograms(); }
  analyzeSchemaPrograms(request) { return this._schemaRecovery.analyzePrograms(request); }
  previewSchemaRebuild(request) { return this._schemaRecovery.preview(request); }
  applySchemaRebuild(request) { return this._schemaRecovery.apply(request); }
  recoverSchemaRebuild(request) { return this._schemaRecovery.recover(request); }
  listSchemaRecoveries() { return this._schemaRecovery.list(); }
  discardSchemaRebuild(reviewId) { return this._schemaRecovery.discard(reviewId); }
  previewSchemaMigration(request) { return this._schemaApplier.preview(request); }
  applySchemaMigration(request) { return this._schemaApplier.apply(request); }
  discardSchemaMigration(reviewId) { return this._schemaApplier.discard(reviewId); }
  applySchemaRename(review) {
    if(this._schemaApplier.applying||this._schemaRecovery.applying||this._streamImportState?.running||this._streamImportState?.pending)throw fail('ROCKETBRAIN_SCHEMA_BUSY','Wait for schema application/import to finish.');
    if([...this._sessions.values()].some(session=>session.scriptRunning))throw fail('ROCKETBRAIN_SCHEMA_BUSY','Wait for every SQL script to finish before applying schema DDL.');
    return this._schemaRenamer.apply(review);
  }
  discardSchemaRename(reviewId) { return this._schemaRenamer.discard(reviewId); }
  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._measurementSession) {
      this._lose(this._measurementSession, fail('ROCKETBRAIN_CLOSED', 'The isolated measurement session closed.'));
    }
    try{
    this._schemaRenamer.dispose();
    await this._schemaDesigner.dispose();
    await this._objectEditor.dispose();
    await this._schemaApplier.dispose();
    await this._schemaRecovery.dispose();
    this._scriptReviews.clear();
    for (const session of [...this._sessions.values(), this._metadataSession]) {
      session.closed = true; this._lose(session, fail('ROCKETBRAIN_CLOSED', 'The MySQL connection has been closed.'));
    }
    this._sessions.clear(); this._options.password = '';
    this._editor.models.clear(); this._editor.reviews.clear();
    }finally{this._options.password='';if(this._options.ssl?.key)this._options.ssl.key='';await this._connectionCleanup();}
  }
}

module.exports = { MysqlService, validateReadQuery, validateQuery };
