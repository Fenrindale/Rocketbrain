'use strict';

const identifier = '[A-Za-z_$][A-Za-z0-9_$]{0,127}';
const entity = new RegExp('^' + identifier + '(?:\\.' + identifier + '){0,31}$');
const path = new RegExp('^' + identifier + '(?:\\.' + identifier + '){0,7}$');
const javaType = new RegExp('^' + identifier + '(?:\\.' + identifier + '){0,31}(?:\\[\\]){0,3}$');
const factory = /^factory-[1-9][0-9]{0,15}$/u;
const kinds = new Set(['BASIC', 'EMBEDDED', 'ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_ONE', 'MANY_TO_MANY', 'ELEMENT_COLLECTION']);

function matches(value, expression) {
  return typeof value === 'string' && value.length <= 256 && expression.test(value);
}

function attributeTarget(value) {
  if (!matches(value?.factoryId, factory) || !matches(value.entityJavaType, entity) || !matches(value.propertyPath, path)) {
    throw Error('Select an observed JPA factory, entity and attribute path.');
  }
  const { factoryId, entityJavaType, propertyPath } = value;
  return { factoryId, entityJavaType, propertyPath };
}

function boundedLabel(value) {
  return typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function attributeBindingReport(value, target) {
  const fail = () => { throw Error('Invalid JPA attribute binding metadata.'); };
  if (!value || typeof value !== 'object' ||
      Object.keys(target).some(name => value[name] !== target[name]) ||
      !['observed', 'partial', 'unknown'].includes(value.state) ||
      value.observerExecutedSql !== false || value.valuesRetained !== false || value.applicationCallbacksInvoked !== false) fail();
  const result = { ...target, state: value.state, observerExecutedSql: false, valuesRetained: false, applicationCallbacksInvoked: false };
  if (value.state !== 'observed') {
    if (!matches(value.reason, /^[a-z_]{1,60}$/u) || value.mapping !== undefined) fail();
    result.reason = value.reason;
  }
  if (value.state !== 'unknown') {
    const declared = value.declaration;
    if (declared?.basis !== 'jakarta-persistence-metamodel' || !kinds.has(declared.kind) || !matches(declared.javaType, javaType)) fail();
    result.declaration = { basis: declared.basis, kind: declared.kind, javaType: declared.javaType };
  }
  if (value.state !== 'observed') return result;

  const mapping = value.mapping, conversion = mapping?.conversion;
  if (mapping?.basis !== 'hibernate-runtime-mapping' || result.declaration.kind !== 'BASIC' ||
      !boundedLabel(mapping.table) || !boundedLabel(mapping.column) ||
      !matches(mapping.domainJavaType, javaType) || !matches(mapping.relationalJavaType, javaType) ||
      !Number.isInteger(mapping.jdbcTypeCode) || Math.abs(mapping.jdbcTypeCode) > 32767 ||
      !matches(mapping.jdbcType, /^[A-Z][A-Z0-9_]{1,40}$/u) ||
      !matches(mapping.binderClass, entity) || !mapping.binderClass.startsWith('org.hibernate.type.descriptor.jdbc.') ||
      !['attribute-converter', 'no-registered-converter'].includes(conversion?.kind) ||
      (conversion.kind === 'attribute-converter' ? !matches(conversion.javaType, entity) : conversion.javaType !== undefined)) fail();
  result.mapping = {
    basis: mapping.basis, table: mapping.table, column: mapping.column, domainJavaType: mapping.domainJavaType,
    relationalJavaType: mapping.relationalJavaType, jdbcTypeCode: mapping.jdbcTypeCode, jdbcType: mapping.jdbcType,
    binderClass: mapping.binderClass, conversion: { kind: conversion.kind,
      ...(conversion.kind === 'attribute-converter' && { javaType: conversion.javaType }) }
  };
  return result;
}

function observedPropertyPaths(value) {
  const paths = new Map();
  const attributes = Array.isArray(value.attributes) ? value.attributes : [];
  for (const attr of attributes) {
    if (matches(attr?.name, path)) paths.set(attr.name, attr.kind);
  }
  const mappings = Array.isArray(value.physicalMappings) ? value.physicalMappings : [];
  for (const mapping of mappings) {
    const property = mapping?.property;
    const index = typeof property === 'string' ? property.indexOf('.') : -1;
    if (index >= 0 && matches(property, path) && paths.get(property.slice(0, index)) === 'EMBEDDED') {
      paths.set(property, 'Embedded attribute');
    }
  }
  return [...paths].sort(([a], [b]) => a.localeCompare(b));
}

module.exports = { attributeTarget, attributeBindingReport, observedPropertyPaths };
