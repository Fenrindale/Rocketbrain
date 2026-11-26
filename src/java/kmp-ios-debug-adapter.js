'use strict';

const path = require('node:path');

const threadId = 1, frameId = 1, scopeId = 1, breakpointId = 1;

function createKmpIosDebugAdapter({ service, review, send }) {
  let sequence = 1, configuration = 'created', armed = false, closed = false, launched, paused, closing;
  const source = { name: path.basename(review.source), path: review.source };
  const event = (name, body) => send({ seq: sequence++, type: 'event', event: name, body });
  const response = (request, body, error) => send({ seq: sequence++, type: 'response', request_seq: request.seq,
    command: request.command, success: !error, body, ...(error && { message: error.message }) });
  function stop() {
    if (!closed) {
      closed = true;
      paused = undefined;
      closing = service.stop();
    }
    return closing;
  }
  async function boot() {
    try {
      launched = await service.start(review.token, true);
      if (closed) return;
      event('breakpoint', { reason: 'changed', breakpoint: { id: breakpointId, verified: true, line: review.line, source } });
      const observed = await launched.waitForStop();
      if (!closed) {
        paused = observed;
        event('stopped', { reason: 'breakpoint', threadId, allThreadsStopped: true, hitBreakpointIds: [breakpointId] });
      }
    } catch (error) {
      if (closed) return;
      event('output', { category: 'stderr', output: error.message + '\n' });
      try { await stop(); }
      catch (failure) { event('output', { category: 'stderr', output: failure.message + '\n' }); }
      event('terminated');
    }
  }
  async function dispatch(request) {
    const args = request.arguments || {};
    switch (request.command) {
      case 'initialize':
        return { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true };
      case 'launch':
        if (configuration !== 'created') throw Error('The reviewed simulator launch is already configured.');
        configuration = 'configuring';
        return;
      case 'setBreakpoints': {
        const sites = args.breakpoints || [];
        if (!Array.isArray(sites) || sites.length > 100) throw Error('Too many simulator breakpoints.');
        const approvedPath = args.source?.path === review.source;
        const exactFile = approvedPath && !args.sourceModified;
        const answers = sites.map(site => {
          if (exactFile && site.line === review.line && !site.condition && !site.hitCondition && !site.logMessage) {
            return { id: breakpointId, verified: Boolean(launched), source, line: review.line,
              ...(!launched && { message: 'Pending the reviewed Kotlin framework and line table.' }) };
          }
          return { verified: false, message: 'Only the approved Kotlin source breakpoint is bound in this session.' };
        });
        const approvedBreakpoint = answers.some(item => item.id === breakpointId);
        if (approvedPath && configuration === 'configuring') armed = approvedBreakpoint;
        if (approvedPath && configuration === 'starting' && !approvedBreakpoint && !closed) {
          void stop().then(() => event('terminated'), error => {
            event('output', { category: 'stderr', output: error.message + '\n' });
            event('terminated');
          });
        }
        return { breakpoints: answers };
      }
      case 'setExceptionBreakpoints': return { breakpoints: [] };
      case 'configurationDone':
        if (!armed || configuration !== 'configuring') throw Error('Set the approved plain Kotlin source breakpoint before starting.');
        configuration = 'starting';
        return;
      case 'threads':
        return { threads: launched && !closed ? [{ id: threadId, name: 'Kotlin Simulator' }] : [] };
      case 'stackTrace':
        return { stackFrames: paused && args.threadId === threadId ?
          [{ id: frameId, name: paused.name, line: paused.line, column: 1, source }] : [], totalFrames: paused ? 1 : 0 };
      case 'scopes':
        return { scopes: paused && args.frameId === frameId ? [{ name: 'Locals', variablesReference: scopeId, expensive: false }] : [] };
      case 'variables':
        return { variables: paused && args.variablesReference === scopeId ?
          paused.locals.map(item => ({ ...item, variablesReference: 0 })) : [] };
      case 'continue':
        if (!paused || args.threadId !== threadId) throw Error('Wait for the approved Kotlin breakpoint before continuing.');
        paused = undefined;
        await launched.resume();
        return { allThreadsContinued: true };
      case 'disconnect':
      case 'terminate':
        await stop();
        return;
      default: throw Error('This command is unavailable in the reviewed iOS simulator session.');
    }
  }
  return {
    async handleMessage(request) {
      if (request.type !== 'request') return;
      try {
        response(request, await dispatch(request));
        if (request.command === 'launch') event('initialized');
        if (request.command === 'configurationDone') void boot();
        if (request.command === 'continue') event('continued', { threadId, allThreadsContinued: true });
        if (['disconnect', 'terminate'].includes(request.command)) event('terminated');
      } catch (error) { response(request, undefined, error); }
    },
    dispose: stop
  };
}

module.exports = { createKmpIosDebugAdapter };
