import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

const numberFrom = (fallback) => z.coerce.number().int().positive().default(fallback);
const booleanFrom = (fallback) => z.preprocess(value => {
  if (typeof value !== 'string') return value;
  if (value.toLowerCase() === 'true' || value === '1') return true;
  if (value.toLowerCase() === 'false' || value === '0') return false;
  return value;
}, z.boolean().default(fallback));

const configSchema = z.object({
  env: z.enum(['development', 'test', 'production']).default('development'),
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
    move_targets: z.array(z.record(z.unknown())).default([])
  }).default({}),
  http: z.object({ host: z.string().default('0.0.0.0'), port: numberFrom(19132) }).default({}),
  // Empty url => standalone node, no manager connection. See config.yml.
  qwd: z.object({ url: z.string().trim().default('') }).default({})
});

export function loadConfig(configFile = path.resolve(process.cwd(), 'config.yml')) {
  const source = typeof configFile === 'string'
    ? parseYaml(readFileSync(configFile, 'utf8'))
    : configFile;
  const parsed = configSchema.parse(source ?? {});
  const publicEndpoint = parsePublicUri(parsed.room.public_uri);
  const roomId = randomUUID();

  return {
    env: parsed.env,
    logging: { level: parsed.logging.level, pretty: parsed.logging.pretty || parsed.env === 'development' },
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
      moveTargets: parsed.room.move_targets,
      qwdUrl: parsed.qwd.url
    },
    http: { host: parsed.http.host, port: parsed.http.port }
  };
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
