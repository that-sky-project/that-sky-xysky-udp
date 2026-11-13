import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics } from '../src/observability/metrics.js';
import { createMetricsServer } from '../src/observability/metricsServer.js';

const logger = { info() {}, error() {} };

test('metric instances use isolated registries without global collisions', async () => {
  const first = createMetrics();
  const second = createMetrics();
  first.onlinePlayers.set(3);
  second.onlinePlayers.set(7);
  assert.match(await first.registry.metrics(), /xysky_online_players 3/);
  assert.match(await second.registry.metrics(), /xysky_online_players 7/);
  first.registry.clear();
  second.registry.clear();
});

test('metrics endpoint serves Prometheus content and closes idempotently', async t => {
  const metrics = createMetrics();
  const server = createMetricsServer({ registry: metrics.registry, host: '127.0.0.1', port: 0, logger });
  t.after(async () => { await server.stop(); metrics.registry.clear(); });
  assert.equal(server.address, null);
  assert.equal(server.start(), server.start());
  await server.start();
  const url = `http://127.0.0.1:${server.address.port}`;
  const response = await fetch(`${url}/metrics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.match(await response.text(), /xysky_online_players/);
  const missing = await fetch(`${url}/missing`);
  assert.equal(missing.status, 404);
  await missing.text();
  const wrongMethod = await fetch(`${url}/metrics`, { method: 'POST' });
  assert.equal(wrongMethod.status, 404);
  await wrongMethod.text();
  assert.equal(server.stop(), server.stop());
  await server.stop();
  assert.equal(server.address, null);
  await assert.rejects(server.start(), /stopped/);
});

test('failed scraping returns 500 without an unhandled rejection', async t => {
  const logged = [];
  const server = createMetricsServer({
    registry: { metrics: async () => { throw new Error('collector failed'); } },
    host: '127.0.0.1', port: 0,
    logger: { info() {}, error: (...args) => logged.push(args) }
  });
  t.after(() => server.stop());
  await server.start();
  const response = await fetch(`http://127.0.0.1:${server.address.port}/metrics`);
  assert.equal(response.status, 500);
  await response.text();
  assert.equal(logged.length, 1);
});

test('a failed metrics bind can still be cleaned up', async t => {
  const metrics = createMetrics();
  const first = createMetricsServer({ registry: metrics.registry, host: '127.0.0.1', port: 0, logger });
  t.after(async () => { await first.stop(); metrics.registry.clear(); });
  await first.start();
  const second = createMetricsServer({ registry: metrics.registry, host: '127.0.0.1', port: first.address.port, logger });
  await assert.rejects(second.start(), { code: 'EADDRINUSE' });
  await second.stop();
});

test('an unstarted metrics exporter can be stopped without binding', async () => {
  const server = createMetricsServer({ registry: {}, host: '127.0.0.1', port: 0, logger });
  await server.stop();
  assert.equal(server.address, null);
  await assert.rejects(server.start(), /stopped/);
});
