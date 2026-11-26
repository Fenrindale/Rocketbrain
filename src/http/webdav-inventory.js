'use strict';

const { SaxesParser } = require('saxes');
const { maxEntries, nameOf } = require('../remote/directory-snapshot');

const properties = '<propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getetag/></prop></propfind>';
const dav = (tag, local) => tag?.uri === 'DAV:' && tag.local === local;

function parseCollection(bytes, root) {
  const input = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parser = new SaxesParser({ xmlns: true });
  const stack = [], responses = [];
  let response, properties, nodes = 0;
  parser.on('doctype', () => { throw Error('WebDAV directory XML cannot contain a DOCTYPE.'); });
  parser.on('error', () => { throw Error('The WebDAV server returned invalid directory XML.'); });
  parser.on('opentag', tag => {
    stack.push({ ...tag, text: '' });
    if (++nodes > 1600 || stack.length > 12 || stack.length === 1 && !dav(tag, 'multistatus')) {
      throw Error('The WebDAV directory XML is not a bounded Multi-Status response.');
    }
    if (stack.length === 2 && dav(tag, 'response')) {
      if (responses.length > maxEntries) throw Error('Choose a WebDAV directory with at most 64 direct entries.');
      response = { href: '', scopes: [] };
    }
    if (response && stack.length === 3 && dav(tag, 'propstat')) properties = { status: '', kind: undefined };
    if (properties && stack.length === 5 && dav(stack[3], 'prop') && dav(tag, 'resourcetype')) properties.kind = 'file';
    if (properties && stack.length === 6 && dav(stack[4], 'resourcetype') && dav(tag, 'collection')) properties.kind = 'directory';
  });
  parser.on('text', text => { if (stack.length) stack.at(-1).text += text; });
  parser.on('closetag', () => {
    const { length: depth } = stack;
    const current = stack.pop();
    const value = current.text.trim();
    if (response && depth === 3 && dav(current, 'href')) response.href = value;
    if (properties && depth === 4 && dav(current, 'status')) properties.status = value;
    if (properties && depth === 5 && dav(stack[3], 'prop') && dav(current, 'getetag')) properties.tag = value;
    if (properties && depth === 5 && dav(stack[3], 'prop') && dav(current, 'getcontentlength') && /^\d+$/u.test(value)) {
      properties.bytes = Number(value);
    }
    if (response && depth === 3 && dav(current, 'propstat')) { response.scopes.push(properties); properties = undefined; }
    if (response && depth === 2 && dav(current, 'response')) { responses.push(response); response = undefined; }
  });
  parser.write(input).close();
  const base = decodeURIComponent(root.pathname);
  let collection = false;
  const rows = [];
  for (const item of responses) {
    if (!item.href.startsWith('/') && !/^https?:\/\//iu.test(item.href)) throw Error('The WebDAV collection returned an invalid member URI.');
    const url = new URL(item.href, root), pathname = decodeURIComponent(url.pathname);
    if (url.origin !== root.origin || url.search || url.hash || url.username || url.password || !pathname.startsWith(base)) {
      throw Error('The WebDAV collection returned a member outside the selected directory.');
    }
    const recognized = item.scopes.filter(scope => /^HTTP\/\d\.\d 2\d\d(?: |$)/u.test(scope.status) && scope.kind);
    if (recognized.length !== 1) throw Error('The WebDAV collection returned an opaque resource type.');
    const { kind, tag, bytes } = recognized[0];
    if (pathname === base) {
      if (collection || kind !== 'directory') throw Error('The WebDAV root does not identify one directory.');
      collection = true;
      continue;
    }
    const relative = pathname.slice(base.length);
    const name = nameOf(kind === 'directory' ? relative.replace(/\/$/u, '') : relative);
    rows.push({ name, kind, ...(kind === 'file' && { tag: tag || undefined, bytes }) });
  }
  if (!collection) throw Error('The server did not list the selected WebDAV collection.');
  return rows;
}

module.exports = { parseCollection, properties };
