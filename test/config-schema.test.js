import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import { loadConfig } from '../src/config/index.js';
import { configSchema, debugFileSchema } from '../src/config/schema.js';

const fixture = (t, config = '{}\n', debug) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'xysky-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.yml');
  writeFileSync(file, config);
  if (debug !== undefined) writeFileSync(path.join(directory, 'debug.yml'), debug);
  return { directory, file };
};

test('default config is explicit, reusable, serializable and excludes runtime identity', () => {
  const raw = configSchema.parse({});
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), raw);
  const config = loadConfig({});
  assert.deepEqual(Object.keys(config), ['file', 'logging', 'room', 'qwd', 'metrics', 'debug']);
  assert.equal(config.file, null);
  assert.deepEqual(config.logging, { level: 'info', pretty: false });
  assert.deepEqual(config.room, {
    host: '0.0.0.0', port: 19132, publicUri: '127.0.0.1:19132', publicHost: '127.0.0.1', publicPort: 19132,
    maxPeers: 64, channels: 2, tickRate: 10, maxPacketBytes: 16384,
    badPacketLimit: 8, moveTimeoutMs: 20000, playerStateDecode: 'full'
  });
  assert.deepEqual(config.qwd, { url: '' });
  assert.deepEqual(config.metrics, { enabled: false, host: '127.0.0.1', port: 9100 });
  assert.deepEqual(config.debug, { packets: new Set(), channels: new Set(), warnings: [] });
});

test('loads YAML at a relative path and finds only its adjacent debug.yml', t => {
  const { file } = fixture(t, 'room:\n  port: 7777\n  public_uri: "udp://[::1]:7777"\nlogging:\n  pretty: true\n',
    'packets:\n  JoinGame: true\n  NetRpc: false\n  Typo: true\nchannels:\n  qwdCommand: true\n  Unknown: false\n');
  const config = loadConfig(path.relative(process.cwd(), file));
  assert.equal(config.file, path.resolve(file));
  assert.equal(config.room.port, 7777);
  assert.equal(config.room.publicHost, '::1');
  assert.equal(config.room.publicPort, 7777);
  assert.equal(config.room.publicUri, 'udp://[::1]:7777');
  assert.equal(config.logging.pretty, true);
  assert.deepEqual(config.debug.packets, new Set(['JoinGame']));
  assert.deepEqual(config.debug.channels, new Set(['qwdCommand']));
  assert.equal(config.debug.warnings.length, 2);
  assert.ok(config.debug.warnings.every(warning => warning.includes(path.join(path.dirname(file), 'debug.yml'))));
  assert.match(config.debug.warnings[0], /unknown packet "Typo"/u);
});

test('omitted config path resolves cwd/config.yml', t => {
  const { directory, file } = fixture(t);
  const previous = process.cwd();
  process.chdir(directory);
  try { assert.equal(loadConfig().file, file); }
  finally { process.chdir(previous); }
});

test('missing debug file enables no switches', t => {
  assert.deepEqual(loadConfig(fixture(t).file).debug, { packets: new Set(), channels: new Set(), warnings: [] });
});

test('null, scalar and empty configuration documents fail instead of silently defaulting', t => {
  for (const value of [null, [], true, 1, '', 'room']) assert.throws(() => loadConfig(value), /configuration/u);
  for (const text of ['', '# comment only\n', 'null\n', '[]\n', 'true\n']) {
    const { file } = fixture(t, text);
    assert.throws(() => loadConfig(file), error => error.message.includes(file) && /configuration/u.test(error.message));
  }
  for (const section of ['room', 'logging', 'qwd', 'metrics']) {
    assert.throws(() => loadConfig({ [section]: null }), new RegExp(section, 'u'));
  }
});

test('strict config and debug root shapes reject unknown keys and removed aliases', t => {
  for (const source of [{ typo: true }, { room: { id: 'a' } }, { room: { qwdUrl: '' } },
    { room: { debugPackets: [] } }, { logging: { levle: 'info' } }, { metrics: { uri: 'a' } }, { qwd: { enabled: true } }]) {
    assert.throws(() => loadConfig(source), /Unrecognized key/u);
  }
  const { file } = fixture(t, '{}\n', 'packet:\n  JoinGame: true\n');
  assert.throws(() => loadConfig(file), /Unrecognized key/u);
});

test('boolean values must actually be booleans; debug maps validate every value', t => {
  for (const value of [null, 0, 1, 'true', 'false', 'yes', [], {}]) {
    assert.throws(() => loadConfig({ logging: { pretty: value } }), /pretty/u);
    assert.throws(() => loadConfig({ metrics: { enabled: value } }), /enabled/u);
  }
  for (const text of ['packets: null\n', 'channels: []\n', 'packets:\n  JoinGame: "true"\n',
    'channels:\n  qwdCommand: 1\n', 'packets:\n  Unknown: null\n', 'null\n', '']) {
    const { file } = fixture(t, '{}\n', text);
    assert.throws(() => loadConfig(file), /debug.yml/u);
  }
  assert.deepEqual(debugFileSchema.parse({}), { packets: {}, channels: {} });
});

test('all numeric fields have explicit bounds and reject coercible non-numbers', () => {
  for (const [key, min, max] of [
    ['port', 1, 65535], ['max_peers', 1, 4095], ['channels', 1, 255], ['tick_rate', 1, 1000],
    ['max_packet_bytes', 1, 33554432], ['bad_packet_limit', 1, 1000000], ['move_timeout_ms', 1, 2147483647]
  ]) {
    for (const value of [min, max]) assert.equal(configSchema.parse({ room: { [key]: value } }).room[key], value);
    for (const value of [min - 1, max + 1, 1.5, null, true, false, '10', '', NaN, Infinity]) {
      assert.throws(() => loadConfig({ room: { [key]: value } }), new RegExp(key, 'u'));
    }
  }
  for (const value of [0, 65536, null, true, '9100']) assert.throws(() => loadConfig({ metrics: { port: value } }), /port/u);
});

test('log levels, host values and PlayerState modes are validated', () => {
  for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']) {
    assert.equal(loadConfig({ logging: { level } }).logging.level, level);
  }
  assert.throws(() => loadConfig({ logging: { level: 'verbose' } }), /level/u);
  assert.throws(() => loadConfig({ room: { player_state_decode: 'compat' } }), /player_state_decode/u);
  for (const host of ['', '   ', null, 123, 'http://localhost', 'name with space']) assert.throws(() => loadConfig({ room: { host } }), /host/u);
});

test('public UDP endpoint supports domains, IPv4 and bracketed IPv6, with port bounds', () => {
  for (const [uri, host, port] of [
    ['127.0.0.1:1', '127.0.0.1', 1], ['udp://example.com:65535', 'example.com', 65535],
    ['[2001:db8::1]:19132', '2001:db8::1', 19132], ['udp://[::1]:7777', '::1', 7777]
  ]) {
    const config = loadConfig({ room: { public_uri: uri } });
    assert.equal(config.room.publicHost, host);
    assert.equal(config.room.publicPort, port);
    assert.equal(config.room.publicUri, uri);
  }
  for (const uri of ['example.com', 'localhost:0', 'localhost:65536', 'localhost:abc',
    'http://localhost:7777', 'ws://localhost:7777', 'udp://user:pass@localhost:7777',
    'udp://localhost:7777/', 'localhost:7777/path', 'localhost:7777?x=1', 'localhost:7777?',
    'localhost:7777#fragment', 'localhost:7777#', '::1:7777', '', null, true]) {
    assert.throws(() => loadConfig({ room: { public_uri: uri } }), /public_uri/u, String(uri));
  }
});

test('QWD is empty standalone or a ws/wss URL without credentials', () => {
  for (const url of ['', 'ws://localhost:1234', 'wss://qwd.example.com/path?token=test']) {
    assert.equal(loadConfig({ qwd: { url } }).qwd.url, url);
  }
  for (const url of ['https://qwd.example.com', 'qwd.example.com', 'ws://user:pass@localhost',
    'wss://localhost:65536', 'ws://localhost/#fragment', '', null, false].filter(value => value !== '')) {
    assert.throws(() => loadConfig({ qwd: { url } }), /url/u);
  }
});

test('YAML and validation errors contain the source path and useful locations', t => {
  for (const text of ['room:\n  port: [\n', 'room: {}\nroom: {}\n', '{}\n---\n{}\n']) {
    const { file } = fixture(t, text);
    assert.throws(() => loadConfig(file), error => error.message.includes(file) && /line|column|document/u.test(error.message));
  }
  const { file } = fixture(t, 'room:\n  port: null\n');
  assert.throws(() => loadConfig(file), error => error.message.includes(file) && error.message.includes('room.port'));
  const missing = path.join(path.dirname(file), 'missing.yml');
  assert.throws(() => loadConfig(missing), error => error.message.includes(missing));
});

test('checked-in JSON schemas match native generation from the single schema source', () => {
  for (const [schema, filename] of [[configSchema, 'config.schema.json'], [debugFileSchema, 'debug.schema.json']]) {
    const actual = JSON.parse(readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8'));
    assert.deepEqual(actual, z.toJSONSchema(schema, { io: 'input' }));
    assert.equal(actual.additionalProperties, false);
    assert.ok(actual.description);
  }
});
