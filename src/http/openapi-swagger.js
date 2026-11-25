'use strict';

function legacyParameterLists(resolve, frame, pathParameters, operationParameters, consumes) {
  function split(values) {
    if (values === undefined) return { ordinary: [], body: null };
    if (!Array.isArray(values) || values.length > 40) throw Error('This entry has more than 40 parameters or an invalid parameter list.');
    const ordinary = [];
    let body = null;
    for (const input of values) {
      const resolved = resolve(input, frame);
      const item = resolved.value;
      if (item.in === 'formData') throw Error('Swagger form-data parameters require multipart or form encoding.');
      if (item.in !== 'body') { ordinary.push(input); continue; }
      if (body || typeof item.name !== 'string' || !item.name || !Object.hasOwn(item, 'schema')) {
        throw Error('Swagger requires one named body parameter with a schema.');
      }
      body = resolved;
    }
    return { ordinary, body };
  }
  const path = split(pathParameters), operation = split(operationParameters);
  if (path.body && operation.body && path.body.value.name !== operation.body.value.name) {
    throw Error('A Swagger operation cannot inherit and declare different body parameters.');
  }
  const body = operation.body ?? path.body;
  const json = jsonMedia(consumes);
  return { pathParameters: path.ordinary, operationParameters: operation.ordinary,
    request: body && { frame: body.frame, value: { required: body.value.required,
      content: json ? { 'application/json': { schema: body.value.schema } } : {} } } };
}

function jsonMedia(value) {
  if (value === undefined) return false;
  if (!Array.isArray(value) || value.length > 24 || value.some(type => typeof type !== 'string' || type.length > 140)) {
    throw Error('Specify at most 24 Swagger media types.');
  }
  return value.some(type => type.toLowerCase() === 'application/json');
}

function swaggerBasePath(document) {
  const prefix = document.basePath ?? '/';
  if (typeof prefix !== 'string' || prefix.length > 1024 || !/^\/(?!\/)[^?{}#\\\x00-\x20]*$/.test(prefix) ||
      prefix.split('/').some(part => part === '.' || part === '..')) throw Error('The Swagger basePath must be an absolute path with no query or fragment.');
  return prefix;
}

function swaggerServers(document, operation) {
  const prefix = swaggerBasePath(document);
  const host = document.host;
  if (host === undefined) return [prefix];
  if (typeof host !== 'string' || !host || host.length > 255 || /[\s@/?#\\]/.test(host)) throw Error('The Swagger host must be a hostname and optional port.');
  const schemes = operation.schemes ?? document.schemes;
  if (schemes === undefined) return ['//' + host + prefix];
  if (!Array.isArray(schemes) || schemes.length > 4 || !schemes.length) throw Error('Specify the Swagger transport schemes as a bounded list.');
  const supported = [...new Set(schemes.filter(scheme => ['http', 'https'].includes(scheme)))];
  if (!supported.length) throw Error('The Swagger operation does not declare an HTTP transport.');
  try {
    return supported.map(scheme => new URL(`${scheme}://${host}${prefix}`).href);
  } catch { throw Error('The Swagger host or base path is invalid.'); }
}

module.exports = { legacyParameterLists, jsonMedia, swaggerBasePath, swaggerServers };
