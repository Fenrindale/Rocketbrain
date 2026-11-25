'use strict';

const { FAMILIES, LIMITS: spatialLimits, fromWkb } = require('./schema-conversion-spatial');
const { PROFILE, inverse } = require('./schema-reprojection');
const land = require('./result-map-land.json');

const geometryType = 255;
const limits = Object.freeze({ rows: 500, vertices: 16384, parts: 4096, cartesianMagnitude: 1e12 });
const fail = message => Error(message);

function preserveGeometry(field, next) {
  return field.type === 'GEOMETRY' ? field.buffer() : next();
}

function geometryPreview(node) {
  const pair = ([x, y]) => ({ x, y });
  if (node.type === 1) return pair(node.coordinates);
  if (node.type === 2) return node.items.map(pair);
  if (node.type === 3) return node.items.map(ring => ring.map(pair));
  return node.items.map(geometryPreview);
}

function captureGeometry(bytes) {
  if (!Buffer.isBuffer(bytes)) return undefined;
  const srid = bytes.length >= 4 ? bytes.readUInt32LE(0) : undefined;
  const unsupported = status => ({ display: 'Geometry · ' + (srid === undefined ? 'missing SRID' : 'SRID ' + srid) +
    ' · ' + status, observation: { srid, status } });
  if (bytes.length < 9) return unsupported('invalid geometry');
  if (bytes.length > spatialLimits.bytes + 4) return unsupported('geometry exceeds preview limit');
  const payload = bytes.subarray(4);
  if (payload.length === 9 && [0, 1].includes(payload[0])) {
    const uint = index => payload[0] ? payload.readUInt32LE(index) : payload.readUInt32BE(index);
    if (uint(1) === 7 && uint(5) === 0) return { display: '[]', observation: { srid, status: 'empty geometry' } };
  }
  try {
    // The internal format carries explicit SRID and X/Y. Interpret its domain only for the selected map projection.
    const node = fromWkb(payload, 0);
    const display = JSON.stringify(geometryPreview(node));
    return { display, observation: { srid, node } };
  } catch {
    return unsupported('unsupported geometry');
  }
}

function mapColumns(result) {
  return (result?.fields || []).flatMap((field, index) => field.type === geometryType ? [index] : []);
}

function geographic(srid, [x, y]) {
  if (srid === 4326 && Math.abs(x) <= 180 && Math.abs(y) <= 90) return [x, y];
  if (srid === 3857 && Math.abs(x) <= PROFILE.maxMetres && Math.abs(y) <= PROFILE.maxMetres) return inverse([x, y]);
  throw fail('coordinates outside the SRID domain');
}

function featureParts(node, project) {
  if (node.type === 1) return [{ type: 'point', points: [project(node.coordinates)] }];
  if (node.type === 2) return [{ type: 'line', points: node.items.map(project) }];
  if (node.type === 3) return [{ type: 'polygon', rings: node.items.map(ring => ring.map(project)) }];
  return node.items.flatMap(item => featureParts(item, project));
}

function pointsOf(part) {
  return part.type === 'polygon' ? part.rings.flat() : part.points;
}

function resultExtent(features) {
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of features) for (const part of feature.parts) for (const [x, y] of pointsOf(part)) {
    extent[0] = Math.min(extent[0], x);
    extent[1] = Math.min(extent[1], y);
    extent[2] = Math.max(extent[2], x);
    extent[3] = Math.max(extent[3], y);
  }
  return extent;
}

function circularCenter(features) {
  const longitudes = features.flatMap(feature => feature.parts.flatMap(pointsOf)).map(([x]) => x).sort((a, b) => a - b);
  let widest = -1, origin;
  for (const [index, longitude] of longitudes.entries()) {
    const next = longitudes[index + 1] ?? longitudes[0] + 360;
    if (next - longitude > widest) { widest = next - longitude; origin = next; }
  }
  const center = origin + (360 - widest) / 2;
  return center - 360 * Math.floor((center + 180) / 360);
}

const nearestLongitude = (longitude, reference) => longitude + 360 * Math.round((reference - longitude) / 360);

function around(parts, center) {
  function sequence(points, previous) {
    return points.map(([x, y]) => {
      previous = nearestLongitude(x, previous);
      return [previous, y];
    });
  }
  return parts.map(part => {
    if (part.type !== 'polygon') return { ...part, points: sequence(part.points, center) };
    const rings = [];
    for (const ring of part.rings) rings.push(sequence(ring, rings[0]?.[0]?.[0] ?? center));
    return { ...part, rings };
  });
}

function mapResult(result, column) {
  if (!Number.isInteger(column) || !mapColumns(result).includes(column)) {
    throw fail('Choose a native geometry result column.');
  }
  const observations = new Map((result.spatial || []).map(item => [item.row, item.cells[column]]));
  const sets = { geographic: [], cartesian: [] };
  const omitted = {};
  const omit = reason => { omitted[reason] = (omitted[reason] || 0) + 1; };
  const readRows = Math.min(result.rows.length, limits.rows);
  let vertices = 0, partCount = 0;
  for (let row = 0; row < readRows; row++) {
    if (result.rows[row][column] === null) { omit('SQL NULL'); continue; }
    const value = observations.get(row);
    if (!value?.node) { omit(value?.status || 'geometry evidence unavailable'); continue; }
    const { srid, node } = value;
    if (![0, 4326, 3857].includes(srid)) { omit('unsupported SRID ' + srid); continue; }
    const group = srid === 0 ? 'cartesian' : 'geographic';
    const project = pair => {
      if (srid !== 0) return geographic(srid, pair);
      if (pair.some(value => Math.abs(value) > limits.cartesianMagnitude)) throw fail('coordinates outside the Cartesian map range');
      return pair;
    };
    let parts;
    try { parts = featureParts(node, project); }
    catch (error) { omit(error.message); continue; }
    const count = parts.reduce((sum, part) => sum + pointsOf(part).length, 0);
    if (vertices + count > limits.vertices || partCount + parts.length > limits.parts) {
      omit('map vertex or feature limit');
      continue;
    }
    vertices += count;
    partCount += parts.length;
    sets[group].push({ row, srid, family: FAMILIES[node.type - 1], parts });
  }
  const groups = Object.entries(sets).filter(([, features]) => features.length).map(([kind, features]) => {
    if (kind === 'geographic') {
      const center = circularCenter(features);
      for (const feature of features) feature.parts = around(feature.parts, center);
    }
    return { kind, features, extent: resultExtent(features) };
  });
  return {
    column, rows: result.rows.length, mappedRows: groups.reduce((sum, group) => sum + group.features.length, 0),
    omitted: Object.entries(omitted).map(([reason, count]) => ({ reason, count })),
    outsideLimit: result.rows.length - readRows, partial: result.truncated === true || result.browse?.hasNext === true,
    groups, land: sets.geographic.length ? land.polygons : []
  };
}

module.exports = { geometryType, mapColumns, preserveGeometry, captureGeometry, mapResult };
