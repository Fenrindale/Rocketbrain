'use strict';

const { randomUUID } = require('node:crypto');
const metadata = require('./database-admin-metadata');
const grants = require('./database-table-grant');
const principals = require('./database-principal-create');

function registerDatabaseAdmin(context, vscode, { database }) {
  const documents = new Map(), reviews = new Map(), subscriptions = [];
  let disposed = false, generation = 0;

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw new Error('Open a trusted workspace to inspect database administration metadata.');
  }

  function guarded(lease, ticket) {
    return { ...lease, guard: () => !disposed && vscode.workspace.isTrusted && generation === ticket && lease.guard() };
  }

  function inspect(action) {
    trusted();
    const ticket = generation;
    return database.withDatabaseAdmin(async lease => {
      const value = await action((sql, values) => metadata.readRows(lease.db, sql, values));
      trusted();
      if (ticket !== generation || !lease.guard()) throw new Error('The active administrator connection changed.');
      return value;
    });
  }

  function describeAccount(account) { return account.host ? account.user + '@' + account.host : account.user; }
  const append = (map, id, value) => {
    while (map.size >= 8) map.delete(map.keys().next().value);
    map.set(id, value);
  };

  function retainReview(type, lease, ticket, plan) {
    trusted();
    if (ticket !== generation || !lease.guard()) throw new Error('The connection changed while preparing the review.');
    const reviewId = randomUUID(), expiresAt = Date.now() + 2 * 60 * 1000;
    append(reviews, reviewId, { type, plan, db: lease.db, epoch: lease.epoch, generation: ticket, expiresAt });
    return { reviewId, expiresAt };
  }

  function reviewed(type, id) {
    trusted();
    const saved = reviews.get(id);
    if (!saved || saved.type !== type || saved.expiresAt <= Date.now() || generation !== saved.generation) {
      throw new Error('The review expired or the administrator connection changed.');
    }
    return saved;
  }

  function consumeReview(type, id, action) {
    const saved = reviewed(type, id);
    return database.withDatabaseAdmin(async lease => {
      if (saved.db !== lease.db || saved.epoch !== lease.epoch || reviewed(type, id) !== saved) {
        throw new Error('The review belongs to an inactive connection.');
      }
      reviews.delete(id);
      return action(guarded(lease, saved.generation), saved.plan);
    }, { write: true });
  }

  async function prepareTableGrant(input) {
    trusted();
    const ticket = generation;
    return database.withDatabaseAdmin(async lease => {
      const plan = await grants.previewTableGrant(guarded(lease, ticket), input);
      return { ...retainReview('table-grant', lease, ticket, plan), sql: plan.sql, table: plan.target.table, action: plan.target.action,
        account: { ...plan.target.account }, database: plan.before.identity.database, previous: [...plan.before.privileges],
        expected: [...plan.expected], directScope: 'table', automaticRetry: false };
    });
  }

  async function applyTableGrant({ reviewId, approved } = {}) {
    trusted();
    if (approved !== true) throw new Error('Approve the single reviewed table privilege change.');
    return consumeReview('table-grant', reviewId, grants.applyTableGrant);
  }

  async function preparePrincipal(input) {
    trusted();
    const ticket = generation;
    return database.withDatabaseAdmin(async lease => {
      const plan = await principals.plan(guarded(lease, ticket), input);
      const { dialect, version, currentUser } = plan.identity;
      return { ...retainReview('principal-create', lease, ticket, plan), target: { ...plan.target },
        server: { dialect, version, account: currentUser }, sql: plan.sql, roleAdministrator: plan.roleAdministrator,
        automaticRetry: false, credentialsIncluded: false };
    });
  }

  async function applyPrincipal({ reviewId, approved, password } = {}) {
    trusted();
    if (approved !== true) throw new Error('Approve the single reviewed account or role creation.');
    return consumeReview('principal-create', reviewId, (lease, plan) => principals.apply(lease, plan, password));
  }

  const api = {
    listSystemSchemas: () => inspect(read => metadata.scope(read)),
    listSystemObjects: input => inspect(async read => {
      const overview = await metadata.scope(read);
      if (!overview.schemas.some(scope => scope.name === input?.schema && scope.visibility === 'visible')) {
        throw new Error('This system schema is unavailable under the current database account.');
      }
      return metadata.objects(read, input);
    }),
    inspectSystemObject: input => inspect(async read => {
      const context = await metadata.readContext(read);
      return { ...await metadata.object(read, input), dialect: context.dialect, version: context.version };
    }),
    listAccounts: () => inspect(async read => metadata.accounts(read, await metadata.readContext(read))),
    inspectAccess: account => inspect(async read => metadata.inspectAccess(read, await metadata.readContext(read), account)),
    prepareTableGrant,
    applyTableGrant,
    preparePrincipal,
    applyPrincipal,
    openPrincipalReview,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      documents.clear(); reviews.clear();
    }
  };

  async function show(content, fileName = 'metadata.md', id = randomUUID()) {
    trusted();
    append(documents, id, { content, generation });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-db-admin:/' + id + '/' + fileName));
    await vscode.window.showTextDocument(document, { preview: false });
    return { id, documentUri: document.uri.toString() };
  }
  const text = value => JSON.stringify(value == null ? '' : value);
  const line = column => text(column.name) + ' ' + text(column.type) + (column.nullable ? ' NULL' : ' NOT NULL');

  async function browseSystem() {
    const overview = await api.listSystemSchemas(), ticket = generation;
    const selected = await vscode.window.showQuickPick(overview.schemas.map(schema => ({
      label: schema.name, description: schema.visibility + (schema.instrumentation ? ' · instrumentation ' + schema.instrumentation : ''),
      detail: schema.description, schema
    })), { title: overview.dialect + ' ' + overview.version + ' · System Schema Catalog' });
    if (!selected) return;
    if (selected.schema.visibility !== 'visible') return vscode.window.showInformationMessage('This schema is unavailable under the connected account.');
    let page = 0, search = '';
    for (;;) {
      if (ticket !== generation) throw new Error('The server changed. Open System Schema Catalog again.');
      const result = await api.listSystemObjects({ schema: selected.schema.name, page, search });
      const action = await vscode.window.showQuickPick([
        { label: 'Search Objects', type: 'search' },
        ...(page ? [{ label: 'Previous Page', type: 'previous' }] : []),
        ...(result.hasNext && page < 20 ? [{ label: 'Next Page', type: 'next' }] : []),
        ...result.objects.map(object => ({ label: object.name, description: [object.kind, object.engine].filter(Boolean).join(' · '), type: 'object' }))
      ], { title: selected.schema.name + ' · ' + (result.objects.length ? 'Page ' + (page + 1) : 'No observed objects') });
      if (!action) return;
      if (action.type === 'previous') { page--; continue; }
      if (action.type === 'next') { page++; continue; }
      if (action.type === 'search') {
        const value = await vscode.window.showInputBox({ title: 'Search ' + selected.schema.name });
        if (value === undefined) return;
        search = value; page = 0; continue;
      }
      if (ticket !== generation) throw new Error('The server changed. Open System Schema Catalog again.');
      const detail = await api.inspectSystemObject({ schema: selected.schema.name, name: action.label });
      return show(['# ' + detail.schema + '.' + detail.name, '', detail.dialect + ' ' + detail.version + ' · ' + detail.kind,
        '', 'Column metadata visible to the connected account.', '', '```text', ...detail.columns.map(line), '```'].join('\n'));
    }
  }

  function accessText(value) {
    return ['# Database Access', '', describeAccount(value.selected) + ' · ' + value.dialect + ' ' + value.version,
      '', 'Observed direct privileges. Effective access can depend on roles, global and schema grants, and server rules.',
      ...(value.isCurrent ? ['Active roles in the metadata session: ' + (value.activeRoles || 'none observed')] : []),
      '', ...Object.entries(value.privileges).flatMap(([scope, data]) => [
        '## ' + scope + ' privileges', '', data.visibility,
        ...data.entries.map(entry => '- ' + text(entry.name) + (entry.grantable ? ' · grantable' : '') +
          (entry.schema ? ' · ' + [entry.schema, entry.table, entry.column].filter(Boolean).map(text).join('.') : '')), ''
      ]), '## Roles', '', value.roleScope + ' · ' + value.roles.visibility,
      ...value.roles.entries.map(role => '- ' + text(describeAccount(role)) + (role.defaultRole ? ' · default' : '') + (role.grantable ? ' · grantable' : ''))].join('\n');
  }

  async function inspectAccount() {
    const ticket = generation, list = await api.listAccounts();
    const picked = await vscode.window.showQuickPick([
      { label: 'Current Session Account', description: list.visibility === 'unavailable' ? 'Other account names unavailable' : '' },
      ...list.entries.map(value => ({ label: describeAccount(value), description: value.kind, account: value }))
    ], { title: 'Inspect Database Access' });
    if (!picked) return;
    if (ticket !== generation) throw new Error('The administrator connection changed. Select the account again.');
    return show(accessText(await api.inspectAccess(picked.account)));
  }

  async function editGrant() {
    const ticket = generation, list = await api.listAccounts();
    if (list.visibility !== 'observed') throw new Error('A complete visible account list is required to select an existing grant target.');
    const current = (await api.inspectAccess()).selected;
    const selected = await vscode.window.showQuickPick(list.entries.filter(account => account.kind !== 'role' && account.user && account.host &&
      (account.user !== current.user || account.host !== current.host)).map(account => ({ label: describeAccount(account), account })),
    { title: 'Select Existing Account for a Table Grant' });
    if (!selected) return;
    const catalog = database.catalogSnapshot();
    const table = await vscode.window.showQuickPick((catalog?.tables || []).filter(value => value.kind === 'table' && !/^__rb_/i.test(value.name))
      .map(table => table.name), { title: 'Select a Table in the Active User Database' });
    if (!table) return;
    const choice = await vscode.window.showQuickPick([{ label: 'Grant SELECT', action: 'grant' }, { label: 'Revoke Direct SELECT', action: 'revoke' }],
      { title: 'Select a Table Privilege Change' });
    if (!choice) return;
    if (ticket !== generation) throw new Error('The administrator connection changed. Start the review again.');
    const plan = await prepareTableGrant({ account: selected.account, table, action: choice.action });
    await show(['-- Direct table SELECT privilege review',
      '-- The server applies this statement immediately. Review the selected account and table.',
      '-- Direct privileges before: ' + (plan.previous.join(', ') || '(none)'),
      '-- Expected direct privileges: ' + (plan.expected.join(', ') || '(none)'), '', plan.sql + ';'].join('\n'), 'review.sql', plan.reviewId);
    const confirmation = await vscode.window.showWarningMessage('Apply this reviewed table privilege change?', { modal: true }, 'Apply Reviewed Grant');
    if (confirmation !== 'Apply Reviewed Grant') { reviews.delete(plan.reviewId); return; }
    const result = await applyTableGrant({ reviewId: plan.reviewId, approved: true });
    if (result.state === 'verified') await vscode.window.showInformationMessage('The direct table privilege change was verified.');
    else await vscode.window.showWarningMessage('Database privilege change ' + result.state + '. Refresh access metadata to inspect the server outcome.');
    return result;
  }

  async function openPrincipalReview(reviewId) {
    const { plan } = reviewed('principal-create', reviewId);
    const { target, identity } = plan;
    return show(['# Create database ' + target.kind, '',
      'Connected server: ' + text(identity.hostname) + ':' + text(identity.port) + ' · ' + text(identity.version),
      'Executing account: ' + text(identity.currentUser), 'Target: ' + text(describeAccount(target)), '',
      'The server applies creation immediately. It will refuse an authorization identifier that already exists.',
      'No explicit object privileges are added.',
      ...(plan.roleAdministrator ? ['MariaDB role administrator: ' + text(plan.roleAdministrator)] : []),
      ...(target.kind === 'account' ? ['The password is supplied separately at Apply.'] : []),
      '', '```sql', plan.sql + ';', '```'].join('\n'), 'principal-review.md', reviewId);
  }

  async function createPrincipal() {
    const ticket = generation;
    const selected = await vscode.window.showQuickPick([
      { label: 'Create login account', kind: 'account' }, { label: 'Create role', kind: 'role' }
    ], { title: 'Review Database Account or Role Creation' });
    if (!selected) return;
    const user = await vscode.window.showInputBox({ title: 'New ' + selected.kind + ' name', ignoreFocusOut: true });
    if (user === undefined) return;
    const host = selected.kind === 'account'
      ? await vscode.window.showInputBox({ title: 'Exact account host', prompt: 'Enter an IP address or DNS name', ignoreFocusOut: true }) : undefined;
    if (selected.kind === 'account' && host === undefined) return;
    if (ticket !== generation) throw new Error('The administrator connection changed. Start the review again.');
    const review = await preparePrincipal({ kind: selected.kind, user, ...(host !== undefined && { host }) });
    try {
      await openPrincipalReview(review.reviewId);
      const confirm = 'Create Reviewed ' + (selected.kind === 'account' ? 'Account' : 'Role');
      const approved = await vscode.window.showWarningMessage('Create this reviewed database ' + selected.kind + '?', { modal: true }, confirm);
      if (approved !== confirm) return;
      reviewed('principal-create', review.reviewId);
      const password = selected.kind === 'account' ? await vscode.window.showInputBox({ title: 'Password for the new database account',
        password: true, ignoreFocusOut: true, validateInput: principals.passwordProblem }) : undefined;
      if (selected.kind === 'account' && password === undefined) return;
      const result = await applyPrincipal({ reviewId: review.reviewId, approved: true, password });
      if (result.state === 'verified') void vscode.window.showInformationMessage('Database ' + selected.kind + ' creation verified.');
      else void vscode.window.showWarningMessage('Database ' + selected.kind + ' creation ' + result.state + '. Inspect account metadata before making another review.');
      return result;
    } finally { reviews.delete(review.reviewId); }
  }

  for (const [name, command] of [['systemCatalog', browseSystem], ['inspectAccess', inspectAccount], ['reviewTableGrant', editGrant],
    ['reviewCreatePrincipal', createPrincipal]]) {
    subscriptions.push(vscode.commands.registerCommand('rocketbrain.db.' + name, async () => {
      try { trusted(); return await command(); }
      catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Database: ' + error.message); }
    }));
  }
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('rocketbrain-db-admin', {
    provideTextDocumentContent(uri) {
      const entry = documents.get(uri.path.split('/').filter(Boolean)[0]);
      if (!entry || entry.generation !== generation || disposed || !vscode.workspace.isTrusted) return '# Database metadata view expired';
      return entry.content;
    }
  }));
  subscriptions.push(database.onDidChangeDatabase(() => { generation++; }));
  return api;
}

module.exports = { registerDatabaseAdmin };
