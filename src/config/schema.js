import { z } from 'zod/v4';
import { DEBUG_CHANNEL_NAMES, PACKET_LOG_NAMES } from '../observability/debugPackets.js';

const boundedInteger = (min, max, fallback, description) =>
  z.number().int().min(min).max(max).default(fallback).describe(description);
const host = z.string().trim().min(1).max(253)
  .refine(value => !/[\s/?#@]/u.test(value), 'Expected a bind hostname or IP address, without whitespace or URL components');

/** Parse with WHATWG URL, not an independent host/port grammar. */
export function publicEndpointUrl(value) {
  return new URL(value.includes('://') ? value : `udp://${value}`);
}

const publicUri = z.string().trim().min(1).superRefine((value, ctx) => {
  try {
    const url = publicEndpointUrl(value);
    if (url.protocol !== 'udp:' || !url.hostname || !url.port
      || Number(url.port) < 1 || Number(url.port) > 65535
      || url.username || url.password || url.pathname || url.search || url.hash
      || value.includes('?') || value.includes('#')) {
      throw new Error();
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected host:port or udp://host:port (port 1-65535), without credentials, path, query or fragment; bracket IPv6 addresses' });
  }
}).default('127.0.0.1:19132').describe('Public UDP endpoint advertised to clients/QWD. Use host:port or udp://host:port; IPv6 must be bracketed. No credentials, path, query or fragment. Port: 1-65535.');

const qwdUrl = z.string().trim().superRefine((value, ctx) => {
  if (value === '') return;
  try {
    const url = new URL(value);
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || value.includes('#')) {
      throw new Error();
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected an empty string (standalone) or a ws:// / wss:// URL without credentials or fragment' });
  }
}).default('').describe('QWD WebSocket URL (ws:// or wss://), without credentials or fragment. Empty string disables QWD and runs standalone. Paths and queries are allowed.');

export const loggingSchema = z.strictObject({
  level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info').describe('Pino minimum log level. Packet diagnostics require debug or trace.'),
  pretty: z.boolean().default(true).describe('Human-readable logs using pino-pretty; false emits structured JSON.')
}).describe('Logging settings. No environment-variable overrides.');

export const roomSchema = z.strictObject({
  host: host.default('0.0.0.0').describe('ENet UDP bind hostname or IP address; independent of the advertised public endpoint.'),
  port: boundedInteger(1, 65535, 19132, 'ENet UDP listening port, 1-65535.'),
  public_uri: publicUri,
  max_peers: boundedInteger(1, 4095, 64, 'ENet connection slots, 1-4095 (ENet peer-ID limit). Joined players remain capped at 8.'),
  channels: boundedInteger(1, 255, 2, 'ENet channel count, 1-255 (ENet limit).'),
  tick_rate: boundedInteger(1, 1000, 10, 'Synchronization ticks per second, 1-1000. Upper bound prevents sub-millisecond timers.'),
  max_packet_bytes: boundedInteger(1, 33554432, 16384, 'Maximum accepted client packet bytes, 1-33554432 (32 MiB ENet packet ceiling).'),
  bad_packet_limit: boundedInteger(1, 1000000, 8, 'Malformed-packet count before closing a session, 1-1000000.'),
  move_timeout_ms: boundedInteger(1, 2147483647, 20000, 'Milliseconds before reverting a stuck MOVING session to ACTIVE, 1-2147483647 (Node timer limit).'),
  player_state_decode: z.enum(['full', 'basic']).default('full').describe('PlayerState decode depth: full reads the complete record; basic reads stateKind, position and velocity. First frame is always full for layout detection.')
}).describe('Immutable room configuration. Room identity is created and managed by the runtime, not stored in config.');

export const qwdSchema = z.strictObject({ url: qwdUrl }).describe('Optional QWD room-manager connection.');

export const metricsSchema = z.strictObject({
  enabled: z.boolean().default(false).describe('Enable the separate Prometheus HTTP listener. Disabled by default: no metrics listener is opened.'),
  host: host.default('127.0.0.1').describe('Metrics HTTP bind hostname or IP address. Loopback is the safe default; use a trusted network for remote scraping.'),
  port: boundedInteger(1, 65535, 9100, 'Metrics HTTP TCP port, 1-65535; separate from the ENet UDP listener.')
}).describe('Optional Prometheus metrics service, owned and stopped by the application lifecycle.');

/** Serializable YAML schema; endpoint derivation and Sets belong to loadConfig. */
export const configSchema = z.strictObject({
  logging: loggingSchema.prefault({}),
  room: roomSchema.prefault({}),
  qwd: qwdSchema.prefault({}),
  metrics: metricsSchema.prefault({})
}).describe('XYSKY UDP configuration. All sections are optional and defaulted. Unknown keys and null values are errors; numbers and booleans must be native YAML values. CLI overrides are merged before validation.');

const switchMap = (names, description) => z.object(Object.fromEntries(
  names.map(name => [name, z.boolean().optional().describe(`Enable debug logging for ${name}. Omitted switches are disabled.`)])
)).catchall(z.boolean()).describe(description);

export const debugFileSchema = z.strictObject({
  packets: switchMap(PACKET_LOG_NAMES, 'Boolean packet switches. Known names are listed in this schema; unknown names warn and are ignored.').prefault({}),
  channels: switchMap(DEBUG_CHANNEL_NAMES, 'Boolean diagnostic-channel switches. Unknown names warn and are ignored.').prefault({})
}).describe('Optional debug.yml beside the selected config.yml. Top-level keys are strict, switch values must be booleans. Missing file or omitted switches means no debug switches enabled; log level must also permit debug.');

/** Strict partial schema for programmatic/CLI overrides; absent fields have no defaults. */
const partialSection = schema => z.strictObject(Object.fromEntries(
  Object.entries(schema.shape).map(([key, field]) => [key, field.removeDefault().optional()])
));
export const configOverridesSchema = z.strictObject({
  logging: partialSection(loggingSchema).optional(),
  room: partialSection(roomSchema).optional(),
  qwd: partialSection(qwdSchema).optional(),
  metrics: partialSection(metricsSchema).optional()
}).describe('Partial configuration overrides in the same snake_case shape as config.yml.');
