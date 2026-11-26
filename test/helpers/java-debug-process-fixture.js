'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { until } = require('./stdio-lsp');

function processFixture(packageName, className) {
  const source = [
    'package ' + packageName + ';',
    'import java.net.InetAddress;',
    'import java.net.ServerSocket;',
    'public final class ' + className + ' {',
    '    public static void main(String[] args) throws Exception {',
    '        if ("plain".equals(args[0])) {',
    '            try (var socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {',
    '                System.out.println("NON_JDWP_SOCKET:" + socket.getLocalPort());',
    '                System.in.read();',
    '            }',
    '            return;',
    '        }',
    '        int watched = 73;',
    '        System.out.println("DEBUG_FIXTURE_RESUMED:" + watched); // PICKER_BREAKPOINT',
    '        System.in.read();',
    '    }',
    '}',
    ''
  ].join('\n');
  return {
    source,
    mainClass: packageName + '.' + className,
    line: source.split('\n').findIndex(value => value.includes('PICKER_BREAKPOINT')) + 1
  };
}

function fixtureJvm(java, project, mainClass, classPaths, { debug = true, token = 'fixture-private-argument', vmArgs = [] } = {}) {
  const target = spawn(java, [...(debug ? ['-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0'] : []),
    ...vmArgs, '-cp', classPaths.join(path.delimiter), mainClass, debug ? 'attach' : 'plain', token],
  { cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let details = '', failure;
  const capture = chunk => { details = (details + chunk).slice(-32768); };
  target.stdout.on('data', capture);
  target.stderr.on('data', capture);
  target.stdin.on('error', () => {});
  target.on('error', error => { failure = error; });
  const readyPort = async () => {
    const pattern = debug ? /Listening for transport dt_socket at address:\s*(\d+)/ : /NON_JDWP_SOCKET:(\d+)/;
    return until(() => {
      if (failure) throw failure;
      const match = pattern.exec(details);
      return match ? Number(match[1]) : undefined;
    }, 15000);
  };
  const ended = () => target.exitCode !== null || target.signalCode !== null;
  async function leave() {
    if (ended() || !target.pid) return;
    const exiting = once(target, 'exit');
    target.stdin.end();
    let timer;
    try {
      await Promise.race([exiting, new Promise(resolve => { timer = setTimeout(resolve, 2500); })]);
      if (!ended()) { target.kill(); await exiting; }
    } finally { clearTimeout(timer); }
  }
  return { target, readyPort, output: () => details, ended, leave };
}

module.exports = { processFixture, fixtureJvm };
