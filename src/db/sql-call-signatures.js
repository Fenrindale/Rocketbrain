'use strict';

const parameter = (label, placeholder = label) => ({ label, placeholder });
const form = (name, parts, options = {}) => {
  const parameters = parts.filter(part => typeof part !== 'string').map(part => part.label);
  const label = name + '(' + parts.map(part => typeof part === 'string' ? part : part.label).join('') + ')';
  return { name, parts, parameters, label, ...options };
};
function comma(name, labels, options = {}) {
  const parameters = labels.map(label => typeof label === 'string' ? parameter(label) : label);
  return form(name, parameters.flatMap((arg, index) => index ? [', ', arg] : [arg]), options);
}
const minimum = (major, minor, patch = 0) => [major, minor, patch];
const mysql8 = minimum(8, 0), maria10 = minimum(10, 5);

const common = [
  ...['ABS', 'FLOOR', 'CEIL', 'LOWER', 'UPPER', 'LCASE', 'UCASE', 'LENGTH', 'CHAR_LENGTH', 'CHARACTER_LENGTH',
    'LTRIM', 'RTRIM', 'SUM', 'AVG', 'MIN', 'MAX', 'DATE', 'HEX', 'UNHEX', 'JSON_TYPE', 'JSON_VALID']
    .map(name => comma(name, ['expression'])),
  ...['IFNULL', 'NULLIF', 'INSTR', 'LEFT', 'RIGHT', 'DATEDIFF']
    .map(name => comma(name, ['expression', ['LEFT', 'RIGHT'].includes(name) ? 'length' : 'argument'])),
  comma('COUNT', [parameter('expression', '*')]),
  comma('REPLACE', ['subject', 'search', 'replacement']),
  comma('LOCATE', ['search', 'subject']),
  comma('LOCATE', ['search', 'subject', parameter('start', '1')], { extra: 'start position' }),
  comma('IF', ['condition', 'true_value', 'false_value']),
  comma('ROUND', ['expression']),
  comma('ROUND', ['expression', parameter('scale', '2')], { extra: 'scale' }),
  ...['CONCAT', 'COALESCE', 'GREATEST', 'LEAST'].map(name => comma(name, ['first_value', 'next_value'], { variadic: true })),
  comma('CONCAT_WS', ['separator', 'first_value', 'next_value'], { variadic: true }),
  comma('SUBSTRING', ['subject', parameter('start', '1'), parameter('length', '2')]),
  form('SUBSTRING', [parameter('subject'), ' FROM ', parameter('start', '1'), ' FOR ', parameter('length', '2')],
    { separators: ['FROM', 'FOR'], extra: 'FROM / FOR syntax' }),
  comma('TRIM', ['subject']),
  form('TRIM', ['BOTH ', parameter('removal', "' '"), ' FROM ', parameter('subject')], { separators: ['FROM'], extra: 'BOTH / FROM syntax' }),
  form('CAST', [parameter('expression'), ' AS ', parameter('type', 'CHAR')], { separators: ['AS'] }),
  form('EXTRACT', [parameter('unit', 'YEAR'), ' FROM ', parameter('expression')], { separators: ['FROM'] }),
  comma('JSON_VALUE', ['document', parameter('path', "'$.key'")]),
  comma('JSON_EXTRACT', ['document', parameter('path', "'$.key'")], { variadic: true }),
  comma('JSON_CONTAINS', ['document', 'candidate']),
  comma('JSON_CONTAINS', ['document', 'candidate', parameter('path', "'$.key'")], { extra: 'JSON path' }),
  comma('JSON_SET', ['document', parameter('path', "'$.key'"), 'value'], { repeat: 2 })
];

const regexp = ['subject', 'pattern', 'replacement'];
const vendor = {
  mysql: [
    comma('REGEXP_REPLACE', regexp),
    comma('REGEXP_REPLACE', [...regexp, parameter('position', '1'), parameter('occurrence', '0'), parameter('match_type', "'c'")],
      { extra: 'optional regular-expression controls' }),
    form('JSON_VALUE', [parameter('document'), ', ', parameter('path', "'$.key'"), ' RETURNING ', parameter('type', 'UNSIGNED'),
      ' ', parameter('on_empty', 'NULL'), ' ON EMPTY ', parameter('on_error', 'NULL'), ' ON ERROR'],
      { minimum: minimum(8, 0, 21), typedJson: true, extra: 'typed RETURNING / ON EMPTY / ON ERROR' }),
    comma('JSON_STORAGE_SIZE', ['document']),
    comma('JSON_STORAGE_FREE', ['document']),
    comma('UUID_TO_BIN', ['uuid']),
    comma('UUID_TO_BIN', ['uuid', parameter('swap_flag', '0')], { extra: 'swap flag' })
  ],
  mariadb: [
    comma('REGEXP_REPLACE', regexp),
    comma('JSON_NORMALIZE', ['document'], { minimum: minimum(10, 7) }),
    comma('JSON_DETAILED', ['document']),
    comma('JSON_DETAILED', ['document', parameter('indent', '2')], { extra: 'indent width' }),
    comma('JSON_QUERY', ['document', parameter('path', "'$.key'")]),
    comma('JSON_KEY_VALUE', ['document', parameter('path', "'$.key'")], { minimum: minimum(11, 2) })
  ]
};

function versionObserved(options) {
  if (!Array.isArray(options?.sqlMode) || !['mysql', 'mariadb'].includes(options.dialect) || typeof options.serverVersion !== 'string') return;
  const maria = options.dialect === 'mariadb';
  if (/mariadb/i.test(options.serverVersion) !== maria) return;
  const group = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{1,3}))?/.exec(options.serverVersion.replace(/^5\.5\.5-(?=\d)/, ''));
  if (group) return [Number(group[1]), Number(group[2]), Number(group[3] || 0)];
}

function atLeast(actual, minimum) {
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function availableForms(options) {
  const actual = versionObserved(options);
  if (!actual || options.sqlMode.includes('ORACLE') || !atLeast(actual, options.dialect === 'mysql' ? mysql8 : maria10)) return [];
  const eligible = entry => atLeast(actual, entry.minimum ?? (entry.name === 'JSON_VALUE' && options.dialect === 'mysql' ? minimum(8, 0, 21) : mysql8));
  return [...common, ...vendor[options.dialect]].filter(eligible);
}

module.exports = { availableForms };
