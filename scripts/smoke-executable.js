import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, message, timeout = 15_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeout) throw new Error(message());
    await delay(25);
  }
};
const tcpListener = async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
};
const udpPort = async () => {
  const socket = createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
};

export async function smokeExecutable(directory, version) {
  const exe = path.join(directory, process.platform === 'win32' ? 'xysky-udp.exe' : 'xysky-udp');
  accessSync(exe, constants.X_OK);
  // Remove PATH: successful startup must not depend on finding a separate Node.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path' && key !== 'NODE_OPTIONS'));
  env.PATH = '';
  for (const [args, pattern] of [[['--help'], /--public-uri/], [['--version'], new RegExp(version.replaceAll('.', '\\.'))]]) {
    const result = spawnSync(exe, args, { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, pattern);
  }
  const run = args => {
    const child = spawn(exe, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errorOutput = '', exit = null;
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errorOutput += data; });
    child.on('error', error => { errorOutput += error.message; });
    child.on('exit', (code, signal) => { exit = { code, signal }; });
    return { child, output: () => output, diagnostics: () => output + '\n' + errorOutput, exit: () => exit };
  };
  const base = async () => {
    const port = await udpPort();
    return ['--host', '127.0.0.1', '--port', String(port), '--public-uri', `127.0.0.1:${port}`, '--qwd-url='];
  };

  for (const pretty of [false, true]) {
    const probe = await tcpListener();
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const app = run([...(await base()), pretty ? '--pretty' : '--no-pretty', '--metrics', '--metrics-host', '127.0.0.1', '--metrics-port', String(port)]);
    try {
      await waitFor(() => app.output().includes('server started') || app.exit(), () => `Executable did not start: ${app.diagnostics()}`);
      assert.equal(app.exit(), null, app.diagnostics());
      const response = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /xysky_connected_peers 0/);
      if (process.platform === 'linux') {
        app.child.kill('SIGTERM');
        await waitFor(() => app.exit(), () => `SIGTERM did not exit: ${app.diagnostics()}`);
        assert.equal(app.exit().code, 0, app.diagnostics());
        assert.match(app.output(), /shutdown complete/);
      }
    } finally {
      if (!app.exit()) app.child.kill('SIGKILL');
      await waitFor(() => app.exit(), () => `Cannot terminate smoke process: ${app.diagnostics()}`);
    }
  }

  // Windows does not deliver POSIX kill(SIGTERM) to Node. A bind failure after ENet
  // startup exercises the real fatal teardown and logger flushing on both systems.
  const occupied = await tcpListener();
  const app = run([...(await base()), '--pretty', '--metrics', '--metrics-host', '127.0.0.1', '--metrics-port', String(occupied.address().port)]);
  try {
    await waitFor(() => app.exit(), () => `Startup failure did not clean up: ${app.diagnostics()}`);
    assert.equal(app.exit().code, 1, app.diagnostics());
    assert.match(app.output(), /startup failed/);
    assert.match(app.output(), /shutdown complete/);
  } finally {
    if (!app.exit()) app.child.kill('SIGKILL');
    await new Promise(resolve => occupied.close(resolve));
  }
  console.log('Executable smoke passed: help/version, moved resources, JSON/pretty logging, native ENet, metrics and fatal cleanup.');
}
