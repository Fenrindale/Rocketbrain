'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { captureGeometry, mapColumns, mapResult, preserveGeometry } = require('../src/db/result-map');
const { toWkb } = require('../src/db/schema-conversion-spatial');
const { forward } = require('../src/db/schema-reprojection');

const point = (x, y) => ({ type: 1, coordinates: [x, y] });
function geometry(srid, node) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(srid);
  return captureGeometry(Buffer.concat([prefix, toWkb(node)]));
}
function result(values) {
  return { columns: ['value', 'value'], fields: [{ type: 252 }, { type: 255 }],
    rows: values.map((value, index) => ['row ' + index, value?.display ?? null]),
    spatial: values.flatMap((value, row) => value ? [{ row, cells: { 1: value.observation } }] : []) };
}

test('native geometry capture keeps explicit SRID, both WKB byte orders and grid preview compatibility', () => {
  const bytes = Buffer.alloc(25);
  bytes.writeUInt32LE(4326);
  bytes[4] = 0;
  bytes.writeUInt32BE(1, 5);
  bytes.writeDoubleBE(126.978, 9);
  bytes.writeDoubleBE(37.5665, 17);
  assert.deepEqual(preserveGeometry({ type: 'GEOMETRY', buffer: () => bytes }, () => undefined), bytes);
  assert.equal(preserveGeometry({ type: 'NEWDECIMAL' }, () => '0.0100'), '0.0100');
  const observed = captureGeometry(bytes);
  assert.equal(observed.display, '{"x":126.978,"y":37.5665}');
  assert.deepEqual(observed.observation, { srid: 4326, node: point(126.978, 37.5665) });
  assert.deepEqual(geometry(4326, point(126.978, 37.5665)), observed);
  assert.deepEqual(mapColumns(result([observed])), [1]);
  assert.throws(() => mapResult(result([observed]), 0), /native geometry/);
});

test('geographic result maps project EPSG 3857, wrap the antimeridian and separate SRID 0', () => {
  const line = { type: 2, items: [[179, 30], [-179, 32]] };
  const projected = forward([177, 34]);
  const map = mapResult(result([geometry(4326, line), geometry(3857, point(...projected)), geometry(0, point(10, 90))]), 1);
  const [geographic, cartesian] = map.groups;
  assert.equal(geographic.kind, 'geographic');
  assert.deepEqual(geographic.features[0].parts[0], { type: 'line', points: [[179, 30], [181, 32]] });
  const [longitude, latitude] = geographic.features[1].parts[0].points[0];
  assert.ok(Math.abs(longitude - 177) < 1e-8 && Math.abs(latitude - 34) < 1e-8);
  assert.deepEqual(cartesian, { kind: 'cartesian', extent: [10, 90, 10, 90], features: [
    { row: 2, srid: 0, family: 'POINT', parts: [{ type: 'point', points: [[10, 90]] }] }
  ] });
  assert.equal(map.mappedRows, 3);
  assert.ok(map.land.length > 100);
});

test('geometry collections preserve multipart rows and polygon holes while reporting all omissions', () => {
  const polygon = { type: 3, items: [
    [[10, 20], [16, 20], [16, 26], [10, 26], [10, 20]],
    [[11, 21], [12, 21], [12, 22], [11, 22], [11, 21]]
  ] };
  const multipoint = { type: 4, items: [point(14, 24), point(15, 23)] };
  const collection = { type: 7, items: [polygon, multipoint] };
  const invalid = captureGeometry(Buffer.from([1, 2, 3]));
  const limit = captureGeometry(Buffer.alloc(130 * 1024));
  const empty = captureGeometry(Buffer.from('00000000010700000000000000', 'hex'));
  assert.equal(empty.display, '[]');
  const mapped = mapResult({
    ...result([geometry(4326, collection), null, geometry(1, point(2, 3)),
      geometry(4326, point(10, 98)), invalid, limit, empty]), truncated: true
  }, 1);
  const [feature] = mapped.groups[0].features;
  assert.equal(feature.row, 0);
  assert.equal(feature.family, 'GEOMETRYCOLLECTION');
  assert.deepEqual(feature.parts.map(part => part.type), ['polygon', 'point', 'point']);
  assert.deepEqual(feature.parts[0].rings, polygon.items);
  assert.deepEqual(mapped.omitted.map(item => item.reason), [
    'SQL NULL', 'unsupported SRID 1', 'coordinates outside the SRID domain', 'invalid geometry',
    'geometry exceeds preview limit', 'empty geometry'
  ]);
  assert.equal(mapped.partial, true);
  assert.equal(mapped.mappedRows, 1);
});

test('result maps limit rows and vertices without silently mixing or partly drawing shapes', () => {
  const small = geometry(0, point(0, 0));
  const large = geometry(0, { type: 2, items: Array.from({ length: 4096 }, (_, index) => [index, index % 2]) });
  const map = mapResult(result([...Array(5).fill(large), ...Array(498).fill(small)]), 1);
  assert.equal(map.outsideLimit, 3);
  assert.equal(map.mappedRows, 4);
  assert.deepEqual(map.omitted, [{ reason: 'map vertex or feature limit', count: 496 }]);
  const missing = mapResult({ fields: [{ type: 255 }], rows: [['legacy capture']], spatial: [] }, 0);
  assert.equal(missing.groups.length, 0);
  assert.deepEqual(missing.omitted, [{ reason: 'geometry evidence unavailable', count: 1 }]);
});
