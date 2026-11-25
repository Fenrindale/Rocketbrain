'use strict';

const { validIdentifier } = require('../java/file-templates');

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const binders = { path: 'PathVariable', query: 'RequestParam', header: 'RequestHeader', cookie: 'CookieValue' };
const styles = { path: 'simple', query: 'form', header: 'simple', cookie: 'form' };
const scalarTypes = { string: 'String', unspecified: 'String', integer: 'Long', number: 'BigDecimal', boolean: 'Boolean' };
const reserved = new Set(['BigDecimal', 'Objects', 'ResponseEntity', 'RestController', 'Handler', 'String', 'Object', 'Long', 'Boolean',
  'RequestMapping', 'RequestMethod', 'PathVariable', 'RequestParam', 'RequestHeader', 'CookieValue', 'RequestBody']);
const parameterName = /^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/;
const pathPart = /^(?:[A-Za-z0-9_.~%-]+|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const titleCase = value => (value.match(/[A-Za-z0-9]+/g) ?? []).map(part => part[0].toUpperCase() + part.slice(1)).join('');
const literal = value => JSON.stringify(value);

function route(operation) {
  const { method, requestBody } = operation;
  const path = (operation.basePath ?? '').replace(/\/$/, '') + operation.path;
  const segments = path.split('/').slice(1);
  if (!methods.has(method) || !path.startsWith('/') || !segments.every((part, index) =>
      part === '' && index === segments.length - 1 || part !== '.' && part !== '..' && pathPart.test(part)) ||
      /%(?![\da-f]{2})/i.test(path)) throw Error('Spring generation requires an exact HTTP method and path with simple variable segments.');
  if (operation.security) throw Error('Generate only operations without declared authorization until an application security contract is provided.');
  if (requestBody && (!requestBody.json || method === 'GET' || method === 'HEAD')) throw Error('Use a JSON body on a supported write method.');
  const names = new Set();
  const parameters = operation.parameters.map(parameter => {
    const { name, in: location, type, required } = parameter;
    const suffix = titleCase(name);
    const variable = location + suffix;
    if (!Object.hasOwn(binders, location) || !Object.hasOwn(scalarTypes, type) || !parameterName.test(name) ||
        !suffix || names.has(variable) || parameter.style !== undefined && parameter.style !== styles[location] || parameter.allowReserved) {
      throw Error('Spring generation supports distinct scalar parameters with default serialization.');
    }
    names.add(variable);
    return { type: scalarTypes[type], variable, binding: '@' + binders[location] + '(name = ' + literal(name) + ', required = ' + Boolean(required) + ') ' };
  });
  if (requestBody) parameters.push({ type: 'Object', variable: 'body', binding: '@RequestBody(required = ' + requestBody.required + ') ' });
  const bindings = parameters.map(item => item.binding + item.type + ' ' + item.variable).join(', ');
  const signature = parameters.map(item => item.type + ' ' + item.variable).join(', ');
  const args = parameters.map(item => item.variable).join(', ');
  const endpoint = 'handle' + (titleCase(operation.id ?? '') || titleCase(method + ' ' + path));
  const attributes = [`path = ${literal(path)}`, `method = RequestMethod.${method}`];
  if (requestBody) attributes.push('consumes = "application/json"');
  if (operation.responseBodies?.length) attributes.push('produces = "application/json"');
  return { endpoint, bindings, signature, args, mapping: `    @RequestMapping(${attributes.join(', ')})` };
}

function springServerSource(operations, { className = 'OpenApiController', packageName = '' } = {}) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 32) throw Error('Choose between 1 and 32 OpenAPI operations.');
  if (!validIdentifier(className) || reserved.has(className) || typeof packageName !== 'string' ||
      packageName && !packageName.split('.').every(validIdentifier)) throw Error('Enter valid Java controller and package names.');
  const routes = operations.map(route);
  if (new Set(routes.map(item => item.endpoint)).size !== routes.length) throw Error('Choose operations with distinct Java handler names.');
  const lines = [
    ...(packageName ? [`package ${packageName};`, ''] : []),
    'import java.math.BigDecimal;',
    'import java.util.Objects;',
    'import org.springframework.http.ResponseEntity;',
    ...['CookieValue', 'PathVariable', 'RequestBody', 'RequestHeader', 'RequestMapping', 'RequestMethod', 'RequestParam', 'RestController']
      .map(name => `import org.springframework.web.bind.annotation.${name};`),
    '',
    '@RestController',
    `public final class ${className} {`,
    '    public interface Handler {',
    ...routes.map(item => `        ResponseEntity<?> ${item.endpoint}(${item.signature});`),
    '    }',
    '',
    '    private final Handler handler;',
    '',
    `    public ${className}(Handler handler) {`,
    '        this.handler = Objects.requireNonNull(handler);',
    '    }',
    ...routes.flatMap(item => [
      '', item.mapping, `    public ResponseEntity<?> ${item.endpoint}(${item.bindings}) {`,
      `        return handler.${item.endpoint}(${item.args});`, '    }'
    ]),
    '}', ''
  ];
  const result = lines.join('\n');
  if (Buffer.byteLength(result) > 128 * 1024) throw Error('The generated Spring controller exceeds 128 KiB.');
  return result;
}

module.exports = { springServerSource };
