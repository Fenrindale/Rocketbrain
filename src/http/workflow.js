'use strict';

const { splitRequests, requestAt, resolveRequest, jsonValue, jsonPathPattern } = require('./client');

const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const prefix = 'capture.';
const previewValue = 'rocketbrain-capture';
const maxCaptures = 16;
const maxSteps = 8;

function parseWorkflow(text) {
  const names = new Set(), captures = new Set(), steps = [];
  for (const block of splitRequests(text)) {
    let name, declarations = [];
    for (const line of block.source.split(/\r?\n/)) {
      const content = line.trim();
      if (!content || content.startsWith('@') || content.startsWith('//')) continue;
      if (!content.startsWith('#')) break;
      if (/^#\s*@step(?:\s|$)/i.test(content)) {
        const marker = /^#\s*@step\s+(\S+)$/i.exec(content);
        if (name || !marker || !namePattern.test(marker[1]) || names.has(marker[1])) {
          throw Error('Choose distinct workflow step names before the requests.');
        }
        name = marker[1];
      }
      if (/^#\s*@capture(?:\s|$)/i.test(content)) {
        const marker = /^#\s*@capture\s+(\S+)\s+(\S+)$/i.exec(content);
        if (!marker || !namePattern.test(marker[1]) || !jsonPathPattern.test(marker[2]) ||
            captures.has(marker[1]) || captures.size>=maxCaptures) {
          throw Error('Use at most 16 distinct workflow captures with simple JSON paths.');
        }
        declarations.push({ name: marker[1], path: marker[2] });
        captures.add(marker[1]);
      }
    }
    if (!name) {
      if (declarations.length) throw Error('Use @capture in a named workflow step.');
      continue;
    }
    const request = requestAt(text,block.start);
    if (!methods.has(request.method) || request.oauth) {
      throw Error('Use ordinary HTTP methods in a workflow. OAuth client credentials use an individual request.');
    }
    if (steps.length>=maxSteps) throw Error('Choose at most eight named HTTP workflow steps.');
    names.add(name);
    steps.push({ name, request, declarations });
  }
  if (steps.length<2) throw Error('Choose at least two named HTTP workflow steps in this document.');
  return steps;
}

async function previewWorkflow(text,environment,{readBodyFile}={}) {
  const steps = parseWorkflow(text);
  const values = new Map(), destinations = [];
  let origin;
  for (const step of steps) {
    const request = await resolveRequest(step.request,environment,()=>previewValue,{
      readBodyFile,captureValues:values
    });
    origin ??= request.url.origin;
    if (request.url.origin!==origin) throw Error('An HTTP workflow uses a single origin.');
    if (request.url.pathname.includes(previewValue)) {
      throw Error('Use workflow captures in a query, header or body and keep each reviewed URL path fixed.');
    }
    step.path = request.url.pathname;
    destinations.push({name:step.name,method:request.method,path:request.url.pathname,
      captureNames:step.declarations.map(item=>item.name)});
    for (const item of step.declarations) values.set(prefix+item.name,previewValue);
  }
  return {steps,origin,destinations};
}

function captureResponse(step,response,values) {
  if (!step.declarations.length) return true;
  if (response.truncated) return false;
  let json;
  try { json = JSON.parse(response.body); } catch { return false; }
  const replacement = [];
  for (const {name,path} of step.declarations) {
    const source = jsonValue(json,path);
    const exact = typeof source==='number' && Number.isFinite(source) &&
      (!Number.isInteger(source) || Number.isSafeInteger(source));
    if (!exact && typeof source!=='string' && typeof source!=='boolean') return false;
    const value = String(source);
    if (Buffer.byteLength(value)>8192 || value.includes('[redacted]') || value.includes('\0')) return false;
    replacement.push([prefix+name,value]);
  }
  for (const [name,value] of replacement) values.set(name,value);
  return true;
}

async function runWorkflow(plan,{prepare,send,assertFresh,signal}) {
  const values = new Map(), executed = [];
  for (const step of plan.steps) {
    assertFresh();
    signal.throwIfAborted();
    const ready = await prepare(step.request,values);
    assertFresh();
    signal.throwIfAborted();
    if (ready.url.origin!==plan.origin || ready.url.pathname!==step.path) {
      throw Error('A resolved workflow request left its reviewed origin or path.');
    }
    const response = await send(ready);
    const checks = response.assertions.map(({kind,name,passed})=>({kind,name,passed}));
    const item = {name:step.name,status:response.status,checks,captured:0};
    executed.push(item);
    if (response.status<200 || response.status>=300 || checks.some(check=>!check.passed)) {
      return {state:'stopped',reason:'response-check',executed};
    }
    if (!captureResponse(step,response,values)) return {state:'stopped',reason:'capture-invalid',executed};
    item.captured=step.declarations.length;
  }
  return {state:'completed',executed};
}

module.exports = {previewWorkflow,runWorkflow};
