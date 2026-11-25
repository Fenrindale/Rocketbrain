'use strict';

const { randomUUID } = require('node:crypto');

const limits = { pages: 4, rows: 1000, bytes: 4 * 1024 * 1024 };

function captured(result) {
  const { browse, rows, edit, spatial } = result;
  return { page: browse.page, rows, rowIds: edit.rowIds, spatial, hasPrevious: browse.hasPrevious, hasNext: browse.hasNext,
    bytes: Buffer.byteLength(JSON.stringify([rows, edit.rowIds, spatial]), 'utf8') };
}

function start(result) {
  return { id: randomUUID(), pages: [captured(result)] };
}

function extend(window, result, direction) {
  const current = captured(result), pages = [...window.pages];
  const forward = direction === 'next';
  const edge = forward ? pages.at(-1).page : pages[0].page;
  if (current.page !== edge + (forward ? 1 : -1) || current.rows.length === 0) {
    throw Error('The next snapshot page changed. Reopen the table snapshot.');
  }
  if (forward) pages.push(current);
  else pages.unshift(current);
  while (pages.length > 1 && (pages.length > limits.pages || pages.reduce((n, page) => n + page.rows.length, 0) > limits.rows ||
    pages.reduce((n, page) => n + page.bytes, 0) > limits.bytes)) {
    if (forward) pages.shift();
    else pages.pop();
  }
  return { id: window.id, pages };
}

function present(window, result) {
  const { pages } = window, first = pages[0], last = pages.at(-1);
  const rows = pages.flatMap(page => page.rows), rowIds = pages.flatMap(page => page.rowIds);
  let offset = 0;
  const spatial = pages.flatMap(page => {
    const cells = (page.spatial || []).map(item => ({ ...item, row: item.row + offset }));
    offset += page.rows.length;
    return cells;
  });
  const browse = { ...result.browse, page: first.page, hasPrevious: first.hasPrevious, hasNext: last.hasNext,
    window: { id: window.id, firstPage: first.page, lastPage: last.page } };
  return { ...result, rows, rowCount: rows.length, browse, spatial: spatial.length ? spatial : undefined,
    edit: { ...result.edit, rowIds, hasMorePossible: last.hasNext } };
}

module.exports = { start, extend, present, limits };
