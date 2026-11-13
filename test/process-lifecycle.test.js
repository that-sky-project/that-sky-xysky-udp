import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProcessLifecycle } from '../src/processLifecycle.js';

function fixture(timeoutMs = 1000) {
  const process = new EventEmitter();
  const exits = [];
  const errors = [];
  process.stderr = { write: text => errors.push(text) };
  process.exit = code => exits.push(code);
  const log = [];
  const logger = Object.fromEntries(['info', 'error', 'fatal'].map(level => [level, (...args) => log.push({ level, args })]));
  const lifecycle = createProcessLifecycle({ logger, closeLogging: async () => log.push({ level: 'flush' }), process, timeoutMs });
  return { process, lifecycle, exits, errors, log };
}

test('shutdown closes resources in reverse order and then flushes logging', async () => {
  const { lifecycle, process, exits, log } = fixture();
  const order = [];
  lifecycle.add('first', async () => order.push('first'));
  lifecycle.add('second', async () => order.push('second'));
  const task = lifecycle.shutdown('test');
  assert.equal(lifecycle.shutdown('again'), task);
  await task;
  assert.deepEqual(order, ['second', 'first']);
  assert.deepEqual(exits, [0]);
  assert.equal(log.at(-1).level, 'flush');
  assert.equal(process.listenerCount('SIGINT'), 0);
  assert.equal(process.listenerCount('uncaughtException'), 0);
  assert.throws(() => lifecycle.add('late', () => {}), /during shutdown/);
});

test('a failing resource is logged without skipping remaining cleanup', async () => {
  const { lifecycle, exits, log } = fixture();
  let closed = false;
  lifecycle.add('first', () => { closed = true; });
  lifecycle.add('broken', () => { throw new Error('cannot close'); });
  await lifecycle.shutdown('test');
  assert.equal(closed, true);
  assert.deepEqual(exits, [1]);
  assert.ok(log.some(row => row.level === 'error' && row.args[0].resource === 'broken'));
});

test('a fatal error during ongoing shutdown upgrades the exit code', async () => {
  const { lifecycle, exits } = fixture();
  let release;
  lifecycle.add('blocked', () => new Promise(resolve => { release = resolve; }));
  const task = lifecycle.shutdown('SIGTERM');
  await Promise.resolve();
  assert.equal(lifecycle.fatal(new Error('fatal')), task);
  release();
  await task;
  assert.deepEqual(exits, [1]);
});

test('a second process signal exits immediately instead of waiting', async () => {
  const { lifecycle, process, exits, errors } = fixture();
  let release;
  lifecycle.add('blocked', () => new Promise(resolve => { release = resolve; }));
  process.emit('SIGINT');
  await Promise.resolve();
  process.emit('SIGTERM');
  assert.deepEqual(exits, [1]);
  assert.match(errors[0], /Second shutdown signal/);
  release();
  await lifecycle.shutdown('join');
});

test('shutdown deadline forces failure exit for a stuck resource', async () => {
  const { lifecycle, exits, errors } = fixture(15);
  let release;
  lifecycle.add('blocked', () => new Promise(resolve => { release = resolve; }));
  const task = lifecycle.shutdown('test');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(exits, [1]);
  assert.match(errors[0], /timed out/);
  release();
  await task;
});
