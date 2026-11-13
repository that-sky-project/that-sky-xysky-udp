import test from 'node:test';
import assert from 'node:assert/strict';
import { createCli, parseCliArgs } from '../src/config/cli.js';
import { loadConfig } from '../src/config/index.js';

const output = callback => {
  const original = process.stdout.write;
  let text = '';
  process.stdout.write = chunk => { text += chunk; return true; };
  try { return { value: callback(), text }; }
  finally { process.stdout.write = original; }
};

test('no flags creates no overrides or injected boolean defaults', () => {
  assert.deepEqual(parseCliArgs([]), { configFile: undefined, overrides: {}, help: false, version: false });
});

test('every CLI field maps to nested YAML-shaped overrides', () => {
  const cli = parseCliArgs([
    '--config', 'deploy/config.yml', '--host', '0.0.0.0', '--port=7777',
    '--public-uri', 'udp://203.0.113.10:5413', '--qwd-url', 'wss://qwd.example.com',
    '--log-level', 'debug', '--pretty', '--max-peers', '100', '--channels', '3',
    '--tick-rate', '20', '--max-packet-bytes', '10000', '--bad-packet-limit', '10',
    '--move-timeout-ms', '30000', '--player-state-decode', 'basic',
    '--metrics', '--metrics-host', '10.0.0.2', '--metrics-port', '9200'
  ]);
  assert.equal(cli.configFile, 'deploy/config.yml');
  assert.deepEqual(cli.overrides, {
    room: { host: '0.0.0.0', public_uri: 'udp://203.0.113.10:5413', player_state_decode: 'basic',
      port: 7777, max_peers: 100, channels: 3, tick_rate: 20, max_packet_bytes: 10000,
      bad_packet_limit: 10, move_timeout_ms: 30000 },
    qwd: { url: 'wss://qwd.example.com' }, logging: { level: 'debug', pretty: true },
    metrics: { enabled: true, host: '10.0.0.2', port: 9200 }
  });
});

test('numeric-looking string options stay strings, including leading zeros', () => {
  const cli = parseCliArgs(['--host=00123', '--config=0007', '--metrics-host', '123']);
  assert.equal(cli.configFile, '0007');
  assert.equal(cli.overrides.room.host, '00123');
  assert.equal(cli.overrides.metrics.host, '123');
});

test('explicit boolean negation and an empty QWD URL work in both value forms', () => {
  assert.deepEqual(parseCliArgs(['--no-pretty', '--no-metrics', '--qwd-url=']).overrides,
    { qwd: { url: '' }, logging: { pretty: false }, metrics: { enabled: false } });
  assert.equal(parseCliArgs(['--qwd-url', '']).overrides.qwd.url, '');
  assert.equal(loadConfig({}, parseCliArgs(['--qwd-url=']).overrides).qwd.url, '');
  assert.equal(loadConfig({}, parseCliArgs([]).overrides).logging.pretty, true);
  assert.equal(loadConfig({}, parseCliArgs(['--no-pretty']).overrides).logging.pretty, false);
  assert.equal(loadConfig({ logging: { pretty: false } }, parseCliArgs([]).overrides).logging.pretty, false);
});

test('generated help and version return booleans without loading configuration', () => {
  for (const flag of ['--help', '-h']) {
    const { value, text } = output(() => parseCliArgs([flag]));
    assert.deepEqual(value, { configFile: undefined, overrides: {}, help: true, version: false });
    assert.match(text, /Usage: xysky-udp \[options\]/u);
    for (const option of createCli().options) assert.ok(text.includes(option.long), `${option.long} in generated help`);
  }
  for (const flag of ['--version', '-v']) {
    const { value, text } = output(() => parseCliArgs([flag]));
    assert.equal(value.version, true);
    assert.equal(value.help, false);
    assert.match(text, /\d+\.\d+\.\d+/u);
  }
});

test('library rejects unknown options, positionals and missing required values', () => {
  for (const argv of [['--nonsense'], ['extra'], ['--', 'extra'], ['--host'], ['--port'], ['--qwd-url']]) {
    assert.throws(() => parseCliArgs(argv));
  }
  assert.throws(() => parseCliArgs(['--config=']), /non-empty path/u);
});

test('port limits and types are enforced by the shared schema, not a CLI whitelist', () => {
  for (const value of ['abc', '0', '70000', '1.5', '', ' ', 'false', 'null', 'Infinity', '1e3', '0x10']) {
    const cli = parseCliArgs([`--port=${value}`]);
    assert.throws(() => loadConfig({}, cli.overrides), /port/u, value);
  }
  for (const value of ['1', '65535', '07777']) {
    const cli = parseCliArgs([`--port=${value}`]);
    assert.equal(loadConfig({}, cli.overrides).room.port, Number(value));
  }
});

test('CLI values override file values without touching unspecified fields', () => {
  const source = { room: { host: '10.0.0.1', port: 19133, public_uri: '10.0.0.1:19133' },
    logging: { pretty: true }, qwd: { url: 'wss://old.example.com' }, metrics: { enabled: true } };
  const config = loadConfig(source, parseCliArgs(['--host=0.0.0.0', '--port=7777', '--qwd-url=']).overrides);
  assert.equal(config.room.host, '0.0.0.0');
  assert.equal(config.room.port, 7777);
  assert.equal(config.room.publicUri, '10.0.0.1:19133');
  assert.equal(config.qwd.url, '');
  assert.equal(config.logging.pretty, true);
  assert.equal(config.metrics.enabled, true);
  assert.equal(source.room.port, 19133);
});

test('override precedence applies before complete source validation', () => {
  assert.equal(loadConfig({ room: { port: 'bad' } }, { room: { port: 7777 } }).room.port, 7777);
  assert.throws(() => loadConfig({ room: { typo: true } }, { room: { port: 7777 } }), /typo/u);
  assert.throws(() => loadConfig({ room: null }, { room: { port: 7777 } }), /room/u);
  assert.throws(() => loadConfig({}, { port: 7777 }), /port/u);
  assert.throws(() => loadConfig({}, { room: { port: true } }), /port/u);
});
