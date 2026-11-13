import { readFileSync } from 'node:fs';
import { Command } from 'commander';

// Executable builds inline metadata; ordinary source runs still read package.json.
const version = typeof __XYSKY_VERSION__ === 'string'
  ? __XYSKY_VERSION__
  : JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/** Fresh Commander instance; option declarations generate help/version and strict parsing. */
export function createCli() {
  const cli = new Command('xysky-udp').description('Run one XYSKY UDP room').usage('[options]').exitOverride();
  for (const [flag, description] of [
    ['--config <PATH>', 'YAML config path (default: ./config.yml); debug.yml is adjacent'],
    ['--host <HOST>', 'ENet UDP bind hostname or IP address'],
    ['--port <PORT>', 'ENet UDP port (1-65535)'],
    ['--public-uri <URI>', 'Advertised host:port or udp://host:port'],
    ['--qwd-url <URL>', 'QWD ws:// or wss:// URL; empty string runs standalone'],
    ['--log-level <LEVEL>', 'fatal | error | warn | info | debug | trace | silent'],
    ['--max-peers <COUNT>', 'ENet connection slots (1-4095; joined players capped at 8)'],
    ['--channels <COUNT>', 'ENet channel count (1-255)'],
    ['--tick-rate <HZ>', 'Synchronization ticks per second (1-1000)'],
    ['--max-packet-bytes <BYTES>', 'Maximum client packet bytes (1-33554432)'],
    ['--bad-packet-limit <COUNT>', 'Malformed packets before closing a session (1-1000000)'],
    ['--move-timeout-ms <MS>', 'Stuck-MOVING timeout (1-2147483647 ms)'],
    ['--player-state-decode <MODE>', 'full | basic'],
    ['--metrics-host <HOST>', 'Prometheus HTTP bind hostname or IP address'],
    ['--metrics-port <PORT>', 'Prometheus HTTP TCP port (1-65535)']
  ]) cli.option(flag, description);
  cli.option('--pretty', 'Enable human-readable logs').option('--no-pretty', 'Emit structured JSON logs');
  cli.option('--metrics', 'Enable Prometheus HTTP listener').option('--no-metrics', 'Disable Prometheus HTTP listener');
  cli.helpOption('-h, --help', 'Display this message').version(version, '-v, --version', 'Display version number');
  // The main entry point reports thrown errors; do not duplicate them on stderr.
  cli.configureOutput({ writeErr: () => {} });
  return cli;
}

const numericValue = value => {
  // Deliberately reject empty strings, whitespace and booleans.
  // Bounds/integrality remain the reusable Zod schema's responsibility.
  if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/u.test(value)) return value;
  return Number(value);
};

/**
 * @param {string[]} argv Arguments without the node executable/script entries
 * @returns {{configFile: string|undefined, overrides: object, help: boolean, version: boolean}}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const cli = createCli();
  try {
    cli.parse(argv, { from: 'user' });
  } catch (error) {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
      return { configFile: undefined, overrides: {}, help: error.code === 'commander.helpDisplayed', version: error.code === 'commander.version' };
    }
    throw error;
  }
  const options = cli.opts();
  if (options.config !== undefined && options.config.trim() === '') {
    throw new Error('--config requires a non-empty path');
  }

  const overrides = {};
  const set = (section, key, value) => {
    if (value !== undefined) (overrides[section] ??= {})[key] = value;
  };
  for (const [option, key] of [
    ['host', 'host'], ['publicUri', 'public_uri'], ['playerStateDecode', 'player_state_decode']
  ]) set('room', key, options[option]);
  for (const [option, key] of [
    ['port', 'port'], ['maxPeers', 'max_peers'], ['channels', 'channels'],
    ['tickRate', 'tick_rate'], ['maxPacketBytes', 'max_packet_bytes'],
    ['badPacketLimit', 'bad_packet_limit'], ['moveTimeoutMs', 'move_timeout_ms']
  ]) set('room', key, options[option] === undefined ? undefined : numericValue(options[option]));
  set('qwd', 'url', options.qwdUrl);
  set('logging', 'level', options.logLevel);
  set('logging', 'pretty', options.pretty);
  set('metrics', 'enabled', options.metrics);
  set('metrics', 'host', options.metricsHost);
  set('metrics', 'port', options.metricsPort === undefined ? undefined : numericValue(options.metricsPort));
  return { configFile: options.config, overrides, help: false, version: false };
}
