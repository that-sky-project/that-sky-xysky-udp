import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomServer } from '../src/runtime/RoomServer.js';
import { EnetServer } from '../src/transport/EnetServer.js';

const logger = { info() {}, warn() {}, error() {} };

function fixture() {
  const order = [];
  const transport = new EventEmitter();
  transport.start = async () => order.push('transport start');
  transport.stop = async () => order.push('transport stop');
  const qwd = { start: () => order.push('qwd start'), stop: () => order.push('qwd stop') };
  const lane = name => ({ enqueue: fn => Promise.resolve().then(fn), disconnected: () => order.push(name) });
  const app = new RoomServer({
    identity: { id: 'room-id' }, transport, qwd, logger,
    tickLoop: { start: () => order.push('tick start'), stop: () => order.push('tick stop') },
    tick: { stop: () => order.push('lanes stop') },
    audienceChatGlobalService: { stop: () => order.push('chat stop') },
    audienceReactionService: lane('reactions stop'),
    liveBroadcastService: lane('live stop'), performanceAuthority: lane('performance stop'),
    peerHandler: { onConnect() {}, onMessage() {}, onDisconnect: () => order.push('peer cleanup') },
    sessions: { list: () => [{ peerId: 1 }], remove: () => order.push('session cleanup') },
    players: { removeBySession: () => order.push('player cleanup') },
    reservations: { clear: () => order.push('reservations cleanup') },
    migrationRosters: { clear: () => order.push('rosters cleanup') }
  });
  return { app, transport, qwd, order };
}

test('room starts listening before registration, shared lifecycle tasks do not duplicate listeners', async () => {
  const { app, order, transport } = fixture();
  assert.equal(app.roomId, 'room-id');
  assert.equal(app.start(), app.start());
  await app.start();
  assert.deepEqual(order, ['transport start', 'qwd start', 'tick start']);
  assert.equal(transport.listenerCount('peer:message'), 1);
  assert.equal(app.stop(), app.stop());
  await app.stop();
  assert.ok(order.indexOf('qwd stop') < order.indexOf('session cleanup'));
  assert.equal(order.at(-1), 'transport stop');
  assert.equal(transport.listenerCount('peer:message'), 0);
  await assert.rejects(app.start(), /single-use/);
});

test('room shutdown aggregates failures but still releases transport and all state', async () => {
  const { app, transport, order } = fixture();
  await app.start();
  app.audienceChatGlobalService.stop = () => { throw new Error('chat error'); };
  await assert.rejects(app.stop(), AggregateError);
  assert.ok(order.includes('session cleanup'));
  assert.ok(order.includes('rosters cleanup'));
  assert.ok(order.includes('reservations cleanup'));
  assert.equal(order.at(-1), 'transport stop');
  assert.equal(transport.listenerCount('error'), 0);
});

test('room startup failure does not leave a registration, host, or tick behind', async () => {
  const { app, transport, order } = fixture();
  transport.start = async () => { throw new Error('bind failed'); };
  await assert.rejects(app.start(), /bind failed/);
  assert.equal(order.includes('qwd start'), false);
  assert.equal(order.includes('tick start'), false);
  assert.equal(order.at(-1), 'transport stop');
});

test('unexpected runtime transport error reaches the process owner only once', async () => {
  const { app, transport } = fixture();
  let failures = 0;
  // Constructor callback is captured, so build a second fixture from explicit ports.
  const owned = new RoomServer({ ...app, onFatalError: () => { failures++; } });
  await owned.start();
  transport.emit('error', new Error('poll loop ended'));
  transport.emit('error', new Error('duplicate'));
  assert.equal(failures, 1);
  await owned.stop();
  await app.stop();
});

function nativeFixture({ ready = true } = {}) {
  const order = [];
  let resolveListen;
  const native = new EventEmitter();
  native.listen = () => {
    if (ready) queueMicrotask(() => native.emit('ready'));
    return new Promise(resolve => { resolveListen = resolve; });
  };
  native.stop = () => { order.push('stop'); resolveListen?.(); };
  native.destroy = () => order.push('destroy');
  const transport = new EnetServer({ host: '127.0.0.1', port: 0, channels: 1, maxPeers: 8, logger, createServer: async () => native });
  return { transport, native, order, end: () => resolveListen() };
}

test('ENet host waits for the native poll loop before destroying it', async () => {
  const { transport, native, order } = nativeFixture();
  await transport.start();
  assert.equal(transport.stop(), transport.stop());
  await transport.stop();
  assert.deepEqual(order, ['stop', 'destroy']);
  assert.equal(native.listenerCount('receive'), 0);
  assert.equal(transport.server, null);
});

test('unexpected ENet listen completion is surfaced as a failure', async () => {
  const { transport, end } = nativeFixture();
  const errors = [];
  transport.on('error', error => errors.push(error));
  await transport.start();
  end();
  await transport.listenTask;
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /unexpectedly/);
  await transport.stop();
});

test('stopping ENet before readiness cancels startup and releases host', async () => {
  const { transport, order } = nativeFixture({ ready: false });
  const startup = transport.start();
  const rejected = assert.rejects(startup, /cancelled/);
  await Promise.resolve();
  await transport.stop();
  await rejected;
  assert.deepEqual(order, ['stop', 'destroy']);
});
