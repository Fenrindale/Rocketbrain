'use strict';

const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { fileKey } = require('./dependency-builds');
const { fail } = require('./workbench-model');

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const maximumSegments = 100000;
const lineText = text => text.replace(/\r\n?/gu, '\n');
const invalid = () => fail('The Kotlin/JS application has an unsupported or invalid source map.');

function segmentValues(segment) {
  const values = [];
  let pending = 0, scale = 1;
  for (const digit of segment) {
    const index = alphabet.indexOf(digit);
    if (index < 0 || scale > 32 ** 5) throw invalid();
    pending += (index & 31) * scale;
    if (index & 32) scale *= 32;
    else {
      const value = Math.floor(pending / 2);
      values.push(pending % 2 ? -value : value);
      if (values.length > 5) throw invalid();
      pending = 0;
      scale = 1;
    }
  }
  if (scale !== 1 || ![1, 4, 5].includes(values.length)) throw invalid();
  return values;
}

function workspaceSource(mapFile, name, files) {
  if (typeof name !== 'string' || !name.length || name.length > 2048 || /[\x00-\x1f\x7f]/u.test(name)) throw invalid();
  try {
    const url = new URL(name.replace(/\\/gu, '/'), pathToFileURL(mapFile));
    if (url.protocol !== 'file:' || url.host || url.search || url.hash) return undefined;
    return files.get(fileKey(fileURLToPath(url)));
  } catch { return undefined; }
}

function bindKotlinJsMap({ map, mapFile, script, snapshot }) {
  if (map?.version !== 3 || map.sections !== undefined || map.sourceRoot && map.sourceRoot !== '' ||
      !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent) || !Array.isArray(map.names) ||
      !map.sources.length || map.sources.length > 4000 || map.names.length > 40000 ||
      map.sources.length !== map.sourcesContent.length || typeof map.mappings !== 'string' ||
      map.mappings.length > 2 * 1024 * 1024) throw invalid();
  const sources = map.sources.map((name, index) => {
    const source = workspaceSource(mapFile, name, snapshot.files);
    if (!source) return undefined;
    const content = map.sourcesContent[index];
    if (typeof content !== 'string' || lineText(content).replace(/^\uFEFF/u,'') !== lineText(source.text)) {
      throw fail('The Kotlin/JS compiler map does not contain the exact saved Kotlin source. Rebuild the target.');
    }
    return source;
  });
  const expected = sources.filter(Boolean).map(item => fileKey(item.file));
  if (!expected.length || new Set(expected).size !== expected.length) {
    throw fail('The application map does not identify unambiguous reviewed Kotlin sources.');
  }
  const sourceLinesByFile = new Map(sources.filter(Boolean).map(item => [fileKey(item.file), lineText(item.text).split('\n')]));
  const generatedText = lineText(script).split('\n');
  const rows = new Map(), reverse = new Map();
  const groups = map.mappings.split(';');
  if (groups.length > 50000) throw invalid();
  let sourceIndex = 0, sourceLine = 0, sourceColumn = 0, nameIndex = 0, count = 0;
  for (const [generatedLine, group] of groups.entries()) {
    if (!group) continue;
    if (generatedLine >= generatedText.length) throw invalid();
    let generatedColumn = 0, previous = -1;
    const row = [];
    for (const segment of group.split(',')) {
      if (++count > maximumSegments) throw invalid();
      const fields = segmentValues(segment);
      generatedColumn += fields[0];
      if (generatedColumn < previous || generatedColumn > generatedText[generatedLine].length) throw invalid();
      previous = generatedColumn;
      let origin;
      if (fields.length > 1) {
        sourceIndex += fields[1];
        sourceLine += fields[2];
        sourceColumn += fields[3];
        if (sourceIndex < 0 || sourceIndex >= sources.length || sourceLine < 0 || sourceColumn < 0) throw invalid();
        if (fields.length === 5) {
          nameIndex += fields[4];
          if (nameIndex < 0 || nameIndex >= map.names.length) throw invalid();
        }
        const input = sources[sourceIndex];
        if (input) {
          const key = fileKey(input.file);
          const lines = sourceLinesByFile.get(key);
          if (sourceLine >= lines.length || sourceColumn > lines[sourceLine].length) throw invalid();
          origin = { file: input.file, line: sourceLine, column: sourceColumn };
          const identity = key + '\0' + sourceLine;
          if (!reverse.has(identity)) reverse.set(identity, new Set());
          reverse.get(identity).add(generatedLine);
        }
      }
      row.push({ generatedColumn, origin });
    }
    rows.set(generatedLine, row);
  }
  if (!reverse.size) throw fail('No executable positions map to the reviewed Kotlin sources.');

  function original(line, column) {
    const row = rows.get(line);
    if (!row || !Number.isInteger(column) || column < 0) return undefined;
    let low = 0, high = row.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (row[mid].generatedColumn <= column) low = mid + 1;
      else high = mid;
    }
    return low > 0 ? row[low-1].origin : undefined;
  }

  function generatedLines(file, line) {
    return [...(reverse.get(fileKey(file) + '\0' + line) ?? [])];
  }
  return { original, generatedLines, sourceCount: expected.length };
}

function linkedKotlinMap(script, main) {
  const match = /(?:^|\n)\/\/# sourceMappingURL=([A-Za-z0-9_.-]+\.map)\s*$/u.exec(script);
  if (!match || match[1] !== path.basename(main) + '.map') throw invalid();
  return match[1];
}

module.exports = { bindKotlinJsMap, linkedKotlinMap };
