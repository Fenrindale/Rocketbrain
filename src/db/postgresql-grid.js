'use strict';

const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const bounds = {
  int2: [-32768n, 32767n],
  int4: [-2147483648n, 2147483647n],
  int8: [-9223372036854775808n, 9223372036854775807n]
};
const maxText = 8192;
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_POSTGRES_GRID' });

function gridNames(profile, table) {
  const schema = profile?.postgresql?.schema;
  if (profile?.postgresqlGridEditing !== true || !schema || !identifier.test(schema) ||
      /^pg_|^information_schema$/.test(schema) || typeof table !== 'string' || !identifier.test(table)) {
    throw fail('Open a PostgreSQL profile approved for reviewed cell edits and choose an ordinary table in its schema.');
  }
  return { schema, table };
}

function gridCell(value, column) {
  if (value === null && column.nullable) return null;
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > maxText ||
      Buffer.from(value).toString('utf8') !== value) {
    throw fail('Use SQL NULL where allowed, or enter a UTF-8 cell value up to 8 KiB.');
  }
  if (Object.hasOwn(bounds, column.type)) {
    if (!/^-?\d{1,19}$/.test(value)) throw fail('Enter an exact integer for the PostgreSQL cell.');
    const integer = BigInt(value), [min, max] = bounds[column.type];
    if (integer < min || integer > max) throw fail('The new integer exceeds the range of the PostgreSQL cell type.');
    return integer.toString();
  }
  if (column.type === 'text' || column.type === 'varchar') return value;
  throw fail('Choose a built-in integer or text cell.');
}

function wireGridEdit(edit) {
  if (!identifier.test(edit.column.name) || !/^\d{1,10}$/.test(edit.relation) ||
      !/^\d{1,10}$/.test(edit.rowVersion) || !identifier.test(edit.identity.column) ||
      !Object.hasOwn(bounds, edit.identity.type) || !Number.isInteger(edit.identity.number) ||
      !Number.isInteger(edit.column.number) || !Number.isInteger(edit.column.typeModifier) || typeof edit.column.nullable !== 'boolean') {
    throw fail('Reload the observed PostgreSQL row before editing.');
  }
  const original = gridCell(edit.original, edit.column), replacement = gridCell(edit.replacement, edit.column);
  if (original === replacement) throw fail('Enter a changed PostgreSQL value.');
  const identity = gridCell(edit.identity.value, { type: edit.identity.type, nullable: false });
  return [edit.relation, edit.rowVersion, edit.identity.column, edit.identity.type, identity,
    edit.column.type, String(edit.column.nullable), original === null ? '0' : '1', original ?? '',
    replacement === null ? '0' : '1', replacement ?? '', edit.identity.number, edit.column.number, edit.column.typeModifier].join('\0');
}

module.exports = { gridNames, gridCell, wireGridEdit };
