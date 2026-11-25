'use strict';

const invalid = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_SESSION_LIFECYCLE' });
const literal = /^'(?:[A-Z0-9_:+, /-]{0,512})'$/i;
const safeModes = new Set(['ONLY_FULL_GROUP_BY', 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES', 'NO_ZERO_DATE',
  'NO_ZERO_IN_DATE', 'ERROR_FOR_DIVISION_BY_ZERO', 'NO_ENGINE_SUBSTITUTION']);

function initializationStatements(script) {
  if (typeof script !== 'string' || Buffer.byteLength(script) > 2048 || /\0|\r(?!\n)/.test(script)) {
    throw invalid('Enter at most 2 KiB of supported SET SESSION initialization SQL.');
  }
  const lines = script.replace(/\r\n/g, '\n').split(';').map(line => line.trim()).filter(Boolean);
  if (lines.length > 4) throw invalid('Enter at most four SET SESSION initialization statements.');
  const settings = new Map();
  for (const line of lines) {
    const parts = /^SET[ \t]+SESSION[ \t]+(time_zone|sql_mode|sql_safe_updates|group_concat_max_len)[ \t]*=[ \t]*(.+)$/i.exec(line);
    if (!parts) throw invalid('Initialization accepts SET SESSION time_zone, sql_mode, sql_safe_updates or group_concat_max_len.');
    const name = parts[1].toLowerCase(), value = parts[2].trim();
    if (settings.has(name)) throw invalid('Choose each session initialization setting once.');
    if (name === 'time_zone' || name === 'sql_mode') {
      if (!literal.test(value)) throw invalid('Use an exact single-quoted time zone or SQL mode literal.');
      if (name === 'time_zone' && !/^'(?:SYSTEM|[+-]\d\d:\d\d|[A-Za-z_]+(?:\/[A-Za-z_0-9+-]+)+)'$/i.test(value)) {
        throw invalid('Use a numeric offset, SYSTEM or an installed named time zone.');
      }
      if (name === 'sql_mode' && value !== "''" && !value.slice(1, -1).toUpperCase().split(',').every(mode => safeModes.has(mode))) {
        throw invalid('Choose supported SQL strictness modes. Initialization leaves SQL tokenization unchanged.');
      }
    } else if (name === 'sql_safe_updates' ? !/^[01]$/.test(value) :
        !/^[1-9]\d{0,7}$/.test(value) || Number(value) < 4 || Number(value) > 16 * 1024 * 1024) {
      throw invalid('Use 0 or 1 for sql_safe_updates or a group_concat_max_len from 4 to 16777216.');
    }
    settings.set(name, `SET SESSION ${name} = ${value}`);
  }
  return [...settings.values()];
}

function sessionLifecycle(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['initialSql', 'keepAliveSeconds', 'idleSeconds'].includes(key))) {
    throw invalid('Use valid session initialization, keep-alive and idle settings.');
  }
  const { initialSql = '', keepAliveSeconds = 0, idleSeconds = 0 } = value;
  const interval = (seconds, min, max) => Number.isSafeInteger(seconds) && (seconds === 0 || seconds >= min && seconds <= max);
  if (!interval(keepAliveSeconds, 1, 3600) || !interval(idleSeconds, 2, 86400)) {
    throw invalid('Use keep-alive from 1 to 3600 seconds, idle timeout from 2 to 86400 seconds, or 0 to disable either.');
  }
  const statements = initializationStatements(initialSql);
  if (!statements.length && !keepAliveSeconds && !idleSeconds) return undefined;
  return { initialSql: statements.join(';\n'), keepAliveSeconds, idleSeconds };
}

module.exports = { initializationStatements, sessionLifecycle };
