import { createRoomId } from '../domain/RoomId.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { parseChannelSwitches, parsePacketSwitches } from '../observability/debugPackets.js';

const numberFrom = (fallback) => z.coerce.number().int().positive().default(fallback);
const booleanFrom = (fallback) => z.preprocess(value => {
  if (typeof value !== 'string') return value;
  if (value.toLowerCase() === 'true' || value === '1') return true;
  if (value.toLowerCase() === 'false' || value === '0') return false;
  return value;
}, z.boolean().default(fallback));

const configSchema = z.object({
  logging: z.object({ level: z.string().default('info'), pretty: z.boolean().default(false) }).default({}),
  room: z.object({
    host: z.string().default('0.0.0.0'),
    port: numberFrom(19132),
    public_uri: z.string().trim().min(1).default('127.0.0.1:19132'),
    max_peers: numberFrom(64),
    channels: numberFrom(2),
    tick_rate: numberFrom(10),
    max_packet_bytes: numberFrom(16384),
    bad_packet_limit: numberFrom(8),
    move_timeout_ms: numberFrom(20000),
    player_state_decode: z.enum(['full', 'basic']).default('full')
  }).default({}),
  qwd: z.object({ url: z.string().trim().default('') }).default({})
});

export function loadConfig(configFile = path.resolve(process.cwd(), 'config.yml')) {
  const source = typeof configFile === 'string'
    ? parseYaml(readFileSync(configFile, 'utf8'))
    : configFile;
  const parsed = configSchema.parse(source ?? {});
  const publicEndpoint = parsePublicUri(parsed.room.public_uri);
  const roomId = createRoomId();
  const debug = loadDebugConfig(configFile);

  return {
    debug,
    logging: { level: parsed.logging.level, pretty: parsed.logging.pretty },
    room: {
      id: roomId,
      host: parsed.room.host,
      port: parsed.room.port,
      publicUri: parsed.room.public_uri,
      publicHost: publicEndpoint.host,
      publicPort: publicEndpoint.port,
      maxPeers: parsed.room.max_peers,
      channels: parsed.room.channels,
      tickRate: parsed.room.tick_rate,
      maxPacketBytes: parsed.room.max_packet_bytes,
      badPacketLimit: parsed.room.bad_packet_limit,
      moveTimeoutMs: parsed.room.move_timeout_ms,
      playerStateDecode: parsed.room.player_state_decode,
      qwdUrl: parsed.qwd.url,
      debugPackets: debug.enabled,
      debugChannels: debug.channels
    }
  };
}

/**
 * Load `debug.yml`, the packet-logging switches.
 *
 * It sits beside `config.yml` and is optional: a missing file means "defaults",
 * which log nothing but the packets that are not routine. Keeping it separate
 * from `config.yml` means a debugging session does not dirty the deploy config,
 * and the file can be handed around on its own.
 *
 * @param {string|object} configFile the path, or an inline config object
 * @returns {{ enabled: Set<string>, channels: Set<string>, warnings: string[] }}
 */
function loadDebugConfig(configFile) {
  const debugFile = typeof configFile === 'string'
    ? path.join(path.dirname(configFile), 'debug.yml')
    : null;

  let source = {};
  if (debugFile && existsSync(debugFile)) {
    source = parseYaml(readFileSync(debugFile, 'utf8')) ?? {};
  }

  const warnings = [];
  const enabled = parsePacketSwitches(source.packets ?? {}, {
    onUnknown: name => warnings.push(`debug.yml: unknown packet "${name}"`)
  });
  const channels = parseChannelSwitches(source.channels ?? {}, {
    onUnknown: name => warnings.push(`debug.yml: unknown channel "${name}"`)
  });

  return { enabled, channels, warnings, file: debugFile };
}

function parsePublicUri(value) {
  const raw = String(value || '').trim();
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `udp://${raw}`);
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('must include a valid port');
    return { host: url.hostname, port };
  } catch (error) {
    throw new Error(`invalid room.public_uri: ${error.message}`);
  }
}
