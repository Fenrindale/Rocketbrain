'use strict';

const path = require('node:path');
const { quote, integer, startNativeGdb } = require('./kmp-native-gdb');

const sourceFor = file => ({ name: path.basename(file), path: file });
const exitReasons = new Set(['exited-normally', 'exited', 'exited-signalled']);
const untargeted = entry => ({ verified: false, line: entry?.line, message: 'No exact reviewed Kotlin DWARF location.' });

function nativeLocals(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 128).flatMap(row => {
    const name = row?.name, value = row?.value;
    if (typeof name !== 'string' || !/^[A-Za-z_$][\w$]{0,119}$/u.test(name) ||
        !['int', 'Int', 'kotlin.Int', 'int32_t'].includes(row.type) ||
        typeof value !== 'string' || !/^-?\d{1,10}$/u.test(value) ||
        Number(value) < -2147483648 || Number(value) > 2147483647) return [];
    return [{ name, value, type: row.type, variablesReference: 0 }];
  });
}

function createKotlinNativeDebugAdapter({ review, send, openGdb = startNativeGdb }) {
  let driver, state = 'new', sequence = 0, handle = 0, pause, stepping, closing, launched = false;
  let queue = Promise.resolve();
  const breakpoints = new Map();
  const notify = (event, body) => send({ seq: ++sequence, type: 'event', event, body });
  const reply = (request, body, error) => send({ seq: ++sequence, type: 'response', request_seq: request.seq,
    command: request.command, success: !error, body, message: error?.message });

  function end(code) {
    if (state !== 'ended') {
      state = 'ended';
      pause = undefined;
      if (launched) {
        if (code !== undefined) notify('exited', { exitCode: code });
        notify('terminated');
      }
    }
    return closing ||= driver?.stop() || Promise.resolve();
  }
  function verify(full = false) {
    if (state === 'ended') throw Error('The owned Kotlin/Native debug session ended.');
    try { review.validate(full); }
    catch (error) { void end().catch(() => {}); throw error; }
  }
  function onStop(record) {
    if (state !== 'running') return;
    if (exitReasons.has(record.reason)) {
      const seconds = record['exit-code'];
      const code = record.reason === 'exited-normally' ? 0 :
        (/^[0-7]{1,5}$/u.test(seconds || '') ? Number.parseInt(seconds, 8) : 1);
      void end(code).catch(() => {});
      return;
    }
    try {
      verify();
      driver.validateInferior();
      const thread = integer(record['thread-id']), line = integer(record.frame?.line);
      const exactSource = thread && line && record.frame?.fullname === review.source;
      const installed = breakpoints.get(record.bkptno);
      const observed = record.reason === 'breakpoint-hit' && exactSource && installed === line;
      const advanced = stepping && exactSource && record.reason === 'end-stepping-range';
      const signal = /^SIG[A-Z0-9]+$/u.test(record['signal-name'] || '') ? record['signal-name'] : undefined;
      const rawReason = /^[a-z-]{1,40}$/u.test(record.reason || '') ? record.reason : 'unknown-stop';
      const breakpoint = integer(record.bkptno);
      const description = observed || advanced ? undefined : [
        'GDB ' + rawReason, signal, breakpoint && 'breakpoint ' + breakpoint,
        line && 'line ' + line, exactSource ? 'reviewed source' : 'source differs from the reviewed Kotlin file'
      ].filter(Boolean).join(' · ');
      stepping = false;
      if (!thread) throw Error('GDB did not report a single stopped Kotlin/Native thread.');
      pause = { thread, frame: exactSource ? { id: ++handle, line, column: 1, source: sourceFor(review.source),
        name: String(record.frame.func || 'Kotlin').slice(0, 240) } : undefined, scope: ++handle };
      state = 'paused';
      notify('stopped', { reason: observed ? 'breakpoint' : advanced ? 'step' : signal ? 'exception' : 'pause', description,
        threadId: thread, allThreadsStopped: true });
    } catch (error) {
      notify('output', { category: 'stderr', output: error.message + '\n' });
      void end().catch(() => {});
    }
  }
  async function setBreakpoints(args) {
    const requested = args.breakpoints ?? [];
    if (!Array.isArray(requested) || requested.length > 16) throw Error('Set up to 16 source breakpoints in the reviewed Kotlin file.');
    if (args.source?.path !== review.source) return { breakpoints: requested.map(untargeted) };
    if (!['configuration', 'paused'].includes(state)) throw Error('Pause before replacing Kotlin/Native breakpoints.');
    verify();
    for (const id of breakpoints.keys()) await driver.request('-break-delete ' + id);
    breakpoints.clear();
    if (args.sourceModified) return { breakpoints: requested.map(untargeted) };
    const results = [];
    for (const item of requested) {
      const line = item?.line;
      if (!Number.isSafeInteger(line) || line < 1 || line > 9999999 || item.condition || item.hitCondition || item.logMessage) {
        results.push(untargeted(item));
        continue;
      }
      if (![...breakpoints.values()].includes(line)) {
        let installed;
        try {
          ({ payload: { bkpt: installed } } = await driver.request('-break-insert --source ' + quote(review.source) + ' --line ' + line));
        } catch (error) {
          if (!error.gdbRejected) throw error;
        }
        if (installed) {
          if (!integer(installed.number)) throw Error('GDB returned an ambiguous breakpoint identifier.');
          if (installed.fullname === review.source && integer(installed.line) === line &&
              /^0x[0-9a-f]+$/iu.test(installed.addr || '') && !installed.locations) breakpoints.set(installed.number, line);
          else await driver.request('-break-delete ' + installed.number);
        }
      }
      results.push([...breakpoints.values()].includes(line) ?
        { verified: true, line, source: sourceFor(review.source) } : untargeted(item));
    }
    return { breakpoints: results };
  }

  async function advance(command) {
    const previous = pause;
    pause = undefined;
    state = 'running';
    try {
      const result = await driver.request(command);
      if (result.name !== 'running') throw Error('GDB did not resume the owned Kotlin/Native process.');
    } catch (error) {
      if (state !== 'ended') { pause = previous; state = previous ? 'paused' : 'configuration'; }
      throw error;
    }
  }

  async function dispatch(command, args) {
    if (command !== 'disconnect' && command !== 'terminate') verify();
    switch (command) {
      case 'initialize': return { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true };
      case 'launch':
        if (state !== 'new') throw Error('This Kotlin/Native launch is already configured.');
        driver = openGdb(review);
        driver.events.on('stopped', onStop);
        driver.events.once('closed', () => { void end().catch(() => {}); });
        driver.events.once('invalid', error => notify('output', { category: 'stderr', output: error.message + '\n' }));
        await driver.initialize();
        state = 'configuration';
        launched = true;
        return;
      case 'setExceptionBreakpoints': return { breakpoints: [] };
      case 'setBreakpoints': return setBreakpoints(args);
      case 'configurationDone':
        if (state !== 'configuration' || !breakpoints.size) throw Error('Set a verified breakpoint in the reviewed Kotlin source before launch.');
        verify(true);
        return advance('-exec-run');
      case 'threads':
        return { threads: pause ? [{ id: pause.thread, name: 'Kotlin/Native thread ' + pause.thread }] : [] };
      case 'stackTrace':
        return { stackFrames: pause?.frame && pause.thread === args.threadId && !args.startFrame ? [pause.frame] : [],
          totalFrames: pause?.frame && pause.thread === args.threadId ? 1 : 0 };
      case 'scopes':
        return { scopes: pause?.frame && pause.frame.id === args.frameId ?
          [{ name: 'Locals', variablesReference: pause.scope, expensive: false }] : [] };
      case 'variables': {
        if (!pause?.frame || pause.scope !== args.variablesReference) throw Error('Inspect locals in the current stopped Kotlin frame.');
        driver.validateInferior();
        const current = pause;
        const { payload } = await driver.request('-stack-list-variables --thread ' + pause.thread +
          ' --frame 0 --no-frame-filters --skip-unavailable --simple-values');
        verify();
        if (pause !== current) throw Error('The Kotlin/Native frame moved before locals were read.');
        return { variables: nativeLocals(payload.variables) };
      }
      case 'next':
      case 'continue':
        if (state !== 'paused' || pause.thread !== args.threadId || command === 'next' && !pause.frame) {
          throw Error('Select the paused Kotlin/Native thread before continuing.');
        }
        driver.validateInferior();
        stepping = command === 'next';
        await advance(stepping ? '-exec-next --thread ' + pause.thread : '-exec-continue');
        return { allThreadsContinued: true };
      case 'disconnect':
      case 'terminate':
        await end();
        return;
      default: throw Error('This Kotlin/Native debug action is unavailable.');
    }
  }

  return {
    handleMessage(request) {
      if (request?.type !== 'request' || !Number.isSafeInteger(request.seq)) return;
      queue = queue.then(async () => {
        try {
          const body = await dispatch(request.command, request.arguments || {});
          reply(request, body);
          if (request.command === 'launch') notify('initialized');
        } catch (error) {
          reply(request, undefined, error);
          if (request.command === 'launch' || request.command === 'configurationDone') await end().catch(() => {});
        }
      });
      return queue;
    },
    dispose: end
  };
}

module.exports = { createKotlinNativeDebugAdapter, nativeLocals };
