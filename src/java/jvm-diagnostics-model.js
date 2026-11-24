'use strict';

const PROFILE_EVENTS = ['jdk.ExecutionSample','jdk.NativeMethodSample','jdk.ObjectAllocationSample',
  'jdk.ObjectAllocationInNewTLAB','jdk.ObjectAllocationOutsideTLAB'];
const MAX_EVENTS = 16000;
const MAX_THREADS = 4000;
const MAX_STACK = 32;
const MAX_METHODS = 250;

function display(value, limit = 280) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0,limit) : '';
}

function parseJvmList(text) {
  const unique = new Map();
  for (const line of text.split(/\r?\n/)) {
    const item = /^(\d{1,10})(?:\s+(\S+))?/.exec(line);
    if (!item || item[2]?.endsWith('sun.tools.jcmd.JCmd')) continue;
    const pid = Number(item[1]);
    if (pid < 1 || unique.size >= 120) continue;
    // Retain only a class or JAR basename. The command line can contain secrets.
    const token = item[2]?.split(/[\\/]/).at(-1) || '';
    const label = /^[\w.$-]{1,160}$/.test(token) && !token.startsWith('-') ? token : '';
    unique.set(pid, { pid, label });
  }
  return [...unique.values()].sort((a,b) => a.pid - b.pid);
}

function json(text, label) {
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw Error('Invalid ' + label + ' JSON.'); }
}

function frameInfo(value) {
  const method = value?.method;
  const type = display(method?.type?.name, 300).replaceAll('/', '.');
  const name = display(method?.name, 200);
  if (!type || !name) return null;
  const line = Number.isInteger(value.lineNumber) && value.lineNumber > 0 ? value.lineNumber : null;
  return { type, method: name, signature: display(method.descriptor, 300), line };
}

function summarizeProfile(text) {
  const stream = json(text, 'flight recording').recording;
  const events = stream?.events;
  if (!Array.isArray(events) || events.length > MAX_EVENTS) throw Error('The recording contains an unsupported sample count.');
  const methods = new Map(), allocationTypes = new Map(), stacks = new Map();
  let cpuSamples = 0, allocationSamples = 0, estimatedAllocationBytes = 0, unattributedAllocationSamples = 0;
  let first = Infinity, last = -Infinity;
  for (const record of events) {
    if (!PROFILE_EVENTS.includes(record.type)) continue;
    const item = record.values || {};
    const time = Date.parse(item.startTime);
    if (Number.isFinite(time)) { first = Math.min(first, time); last = Math.max(last, time); }
    const frames = (Array.isArray(item.stackTrace?.frames) ? item.stackTrace.frames : []).slice(0, MAX_STACK)
      .map(frameInfo).filter(Boolean);
    const cpu = record.type === 'jdk.ExecutionSample' || record.type === 'jdk.NativeMethodSample';
    const amount = cpu ? 0 : [item.weight,item.allocationSize].find(value => Number.isSafeInteger(value) && value >= 0) || 0;
    if (cpu) {
      cpuSamples++;
    } else {
      allocationSamples++;
      if (!Number.isSafeInteger(estimatedAllocationBytes + amount)) throw Error('Flight recording allocation weights exceed the supported range.');
      estimatedAllocationBytes += amount;
      if (!amount) unattributedAllocationSamples++;
      const label = display(item.objectClass?.name || item.objectClass, 240).replaceAll('/', '.');
      if (label) {
        const previous = allocationTypes.get(label) || { type:label, samples:0, bytes:0 };
        previous.samples++;
        previous.bytes += amount;
        allocationTypes.set(label, previous);
      }
    }
    const included = new Set();
    for (const [index, frame] of frames.entries()) {
      const key = frame.type + '#' + frame.method + frame.signature;
      if (included.has(key)) continue;
      included.add(key);
      const entry = methods.get(key) || { ...frame, cpu:0, selfCpu:0, allocated:0, selfAllocated:0 };
      if (!entry.line && frame.line) entry.line = frame.line;
      if (cpu) { entry.cpu++; if (!index) entry.selfCpu++; }
      else { entry.allocated += amount; if (!index) entry.selfAllocated += amount; }
      methods.set(key, entry);
    }
    if (frames.length) {
      const key = frames.map(frame => frame.type + '#' + frame.method + frame.signature).join('\n');
      const stack = stacks.get(key) || { frames, cpu:0, allocated:0 };
      if (cpu) stack.cpu++;
      else stack.allocated += amount;
      stacks.set(key, stack);
    }
  }
  const entries = [...methods.values()];
  const count = (left,right) => left.type.localeCompare(right.type) || left.method.localeCompare(right.method);
  return {
    cpuSamples, allocationSamples, estimatedAllocationBytes, unattributedAllocationSamples,
    omittedEvents: Number.isSafeInteger(stream.omittedEvents) ? stream.omittedEvents : 0,
    observedSampleWindowMs: Number.isFinite(first) ? last - first : null,
    cpuMethods: entries.filter(entry => entry.cpu).sort((a,b) => b.selfCpu - a.selfCpu || b.cpu - a.cpu || count(a,b)).slice(0,MAX_METHODS),
    allocationMethods: entries.filter(entry => entry.allocated).sort((a,b) => b.selfAllocated - a.selfAllocated || b.allocated - a.allocated || count(a,b)).slice(0,MAX_METHODS),
    allocationTypes: [...allocationTypes.values()].sort((a,b) => b.bytes - a.bytes || a.type.localeCompare(b.type)).slice(0,MAX_METHODS),
    cpuStacks: [...stacks.values()].filter(stack => stack.cpu).sort((a,b) => b.cpu - a.cpu).slice(0,30),
    allocationStacks: [...stacks.values()].filter(stack => stack.allocated).sort((a,b) => b.allocated - a.allocated).slice(0,30)
  };
}

function monitorCycles(threads) {
  const owners = new Map(), edges = new Map();
  for (const thread of threads) {
    for (const lock of thread.monitors) {
      if (owners.has(lock) && owners.get(lock) !== thread.id) owners.set(lock, null);
      else owners.set(lock,thread.id);
    }
  }
  for (const thread of threads) {
    const owner = thread.blockedOn && owners.get(thread.blockedOn);
    if (owner && owner !== thread.id && thread.state === 'BLOCKED') edges.set(thread.id, owner);
  }
  const result = [], inspected = new Set();
  for (const start of edges.keys()) {
    const trail = [], seen = new Map();
    for (let current = start; current && !inspected.has(current); current = edges.get(current)) {
      if (seen.has(current)) {
        result.push(trail.slice(seen.get(current)));
        break;
      }
      seen.set(current,trail.length);
      trail.push(current);
    }
    for (const item of trail) inspected.add(item);
  }
  return result;
}

function parseThreadSnapshot(text) {
  const data = json(text,'thread dump').threadDump;
  if (!data || !Array.isArray(data.threadContainers)) throw Error('Use an OpenJDK structured thread dump.');
  const threads = [], ids = new Set();
  if (data.threadContainers.length > MAX_THREADS) throw Error('The thread container count exceeds its inspection limit.');
  for (const container of data.threadContainers) {
    if (!Array.isArray(container.threads)) continue;
    for (const record of container.threads) {
      const id = String(record.tid);
      if (!/^\d{1,24}$/.test(id) || ids.has(id)) throw Error('Invalid or duplicate Java thread identifier.');
      if (threads.length >= MAX_THREADS) throw Error('The thread dump exceeds its inspection limit.');
      ids.add(id);
      const stack = Array.isArray(record.stack) ? record.stack.slice(0,MAX_STACK).map(item => display(item, 512)) : [];
      const monitors = (Array.isArray(record.monitorsOwned) ? record.monitorsOwned : []).slice(0,MAX_STACK)
        .flatMap(group => Array.isArray(group.locks) ? group.locks.slice(0,MAX_STACK).map(lock => display(lock,200)) : []);
      threads.push({
        id, name:display(record.name), state:display(record.state,40), virtual:record.virtual === true,
        container:display(container.container,200), blockedOn:display(record.blockedOn,200),
        monitors, stack
      });
    }
  }
  const virtualThreads = threads.reduce((total,record) => total + Number(record.virtual),0);
  return { threads, platformThreads:threads.length - virtualThreads, virtualThreads, monitorCycles:monitorCycles(threads) };
}

function parseThreadLocks(text) {
  const entries = [], waitEdges = [];
  let current, inSynchronizers = false, deadlockThread;
  const deadlock = /^Found \d+ deadlocks?\.\s*$/m.exec(text);
  for (const line of text.split(/\r?\n/)) {
    const name = /^"([^"]{1,280})" #([\d]{1,24})(?:\s|$)/.exec(line);
    if (name) {
      if (entries.length >= MAX_THREADS) throw Error('The lock dump exceeds its inspection limit.');
      current = { name:display(name[1]), id:name[2], state:'', locks:[], awaiting:[], synchronizers:[] };
      entries.push(current);
      inSynchronizers = false;
      continue;
    }
    const headline = /^"([^"]{1,280})":\s*$/.exec(line);
    if (headline && deadlock) { deadlockThread = display(headline[1]); continue; }
    const holder = /^\s+which is held by "([^"]{1,280})"/.exec(line);
    if (deadlockThread && holder) {
      waitEdges.push({ thread:deadlockThread, heldBy:display(holder[1]) });
      continue;
    }
    if (!current) continue;
    const state = /^\s+java\.lang\.Thread\.State:\s+([A-Z_]+)/.exec(line);
    if (state) current.state = state[1];
    if (/^\s*Locked ownable synchronizers:/.test(line)) inSynchronizers = true;
    const locked = /^\s*- locked <(0x[\da-f]+)>/i.exec(line);
    const waiting = /^\s*- (?:waiting to lock|parking to wait for)\s+<(0x[\da-f]+)>/i.exec(line);
    const synchronizer = inSynchronizers && /^\s*- <(0x[\da-f]+)>/i.exec(line);
    if (locked && current.locks.length < MAX_STACK) current.locks.push(locked[1]);
    if (waiting && current.awaiting.length < MAX_STACK) current.awaiting.push(waiting[1]);
    if (synchronizer && current.synchronizers.length < MAX_STACK) current.synchronizers.push(synchronizer[1]);
  }
  if (!entries.length) throw Error('Use an OpenJDK Thread.print lock dump.');
  return { platformThreads:entries.length, threads:entries, jvmDeadlocks:deadlock ? Number(/\d+/.exec(deadlock[0])[0]) : 0, waitEdges };
}

function parseHeapHistogram(text) {
  const rows = [];
  let total;
  for (const line of text.split(/\r?\n/)) {
    const values = /^\s*\d+:\s+(\d+)\s+(\d+)\s+(\S{1,360})(?:\s+\(([^\r\n]{1,180})\))?\s*$/.exec(line);
    if (values && rows.length < 500) rows.push({ instances:Number(values[1]), bytes:Number(values[2]),
      type:display(values[3], 360), module:display(values[4], 180) });
    const sum = /^Total\s+(\d+)\s+(\d+)\s*$/i.exec(line);
    if (sum) total = { instances:Number(sum[1]), bytes:Number(sum[2]) };
  }
  if (!rows.length || !total || ![...rows,total].every(item => Number.isSafeInteger(item.instances) && Number.isSafeInteger(item.bytes))) {
    throw Error('Use an OpenJDK class histogram with valid counts.');
  }
  return { rows,total,includesUnreachable:true };
}

module.exports = { PROFILE_EVENTS, parseJvmList, summarizeProfile, parseThreadSnapshot, parseThreadLocks, parseHeapHistogram };
