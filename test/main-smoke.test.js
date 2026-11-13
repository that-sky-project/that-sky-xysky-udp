import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function freeTcpPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function freeUdpPort() {
  const socket = createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('real CLI boots ENet, exports metrics, and gracefully stops on SIGTERM', { timeout: 15_000 }, async t => {
  const udpPort = await freeUdpPort();
  const metricsPort = await freeTcpPort();
  // Windows kill(SIGTERM) terminates a process without dispatching Node handlers.
  // A test-only preload forwards IPC to the real signal handler instead.
  const preload = 'data:text/javascript,' + encodeURIComponent("process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); });");
  const child = spawn(process.execPath, ['--import', preload, 'src/main.js',
    '--host', '127.0.0.1', '--port', String(udpPort), '--public-uri', `127.0.0.1:${udpPort}`,
    '--qwd-url=', '--no-pretty', '--metrics', '--metrics-host', '127.0.0.1', '--metrics-port', String(metricsPort)
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  let errors = '';
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Exited before ready (${code}): ${output}\n${errors}`)));
    child.stdout.on('data', data => {
      output += data;
      if (output.includes('"msg":"server started"')) resolve();
    });
  });
  child.stderr.on('data', data => { errors += data; });
  await ready;
  const response = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /xysky_connected_peers 0/);
  child.send('shutdown');
  const exit = await exited;
  assert.equal(exit.code, 0, output + '\n' + errors);
  assert.match(output, /shutdown complete/);
  assert.equal(errors, '');
});
