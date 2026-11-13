import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { parseDocument } from 'yaml';
import { parseChannelSwitches, parsePacketSwitches } from '../observability/debugPackets.js';
import { configSchema, configOverridesSchema, debugFileSchema, publicEndpointUrl } from './schema.js';

/** Read exactly one YAML document, retaining line/column diagnostics and source path. */
function readYaml(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read configuration ${file}: ${error.message}`, { cause: error });
  }
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length) {
    throw new Error(`Invalid YAML in ${file}:\n${document.errors.map(error => error.message).join('\n')}`, {
      cause: document.errors[0]
    });
  }
  try {
    return document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new Error(`Invalid YAML in ${file}: ${error.message}`, { cause: error });
  }
}

function validate(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid configuration in ${label}:\n${z.prettifyError(result.error)}`, { cause: result.error });
  }
  return result.data;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Merge only explicitly supplied keys; malformed sections are never repaired silently. */
function applyOverrides(source, overrides) {
  if (!isObject(source)) return source;
  const merged = { ...source };
  for (const [section, values] of Object.entries(overrides)) {
    if (values === undefined) continue;
    if (source[section] !== undefined && !isObject(source[section])) continue;
    merged[section] = { ...source[section], ...values };
  }
  return merged;
}

/**
 * Load YAML from a path (default: cwd/config.yml), or a serializable inline object.
 * CLI/programmatic overrides use the same nested snake_case shape as the YAML.
 * Merge precedence: explicit overrides > file values > schema defaults.
 * Null/empty documents are invalid; an explicit {} is a valid all-default config.
 * No environment variables, runtime identity, network listeners or logging side effects.
 *
 * @param {string|object} configFile YAML path or inline object
 * @param {object} overrides Partial nested YAML-shaped overrides
 * @returns {object} Runtime-facing configuration with camelCase room fields and debug Sets
 */
export function loadConfig(configFile = path.resolve(process.cwd(), 'config.yml'), overrides = {}) {
  const file = typeof configFile === 'string' ? path.resolve(configFile) : null;
  const source = file ? readYaml(file) : configFile;
  const checkedOverrides = validate(configOverridesSchema, overrides, 'command-line/programmatic overrides');
  const parsed = validate(configSchema, applyOverrides(source, checkedOverrides), file ?? '<inline configuration>');
  const endpoint = publicEndpointUrl(parsed.room.public_uri);
  const debugFile = file ? path.join(path.dirname(file), 'debug.yml') : null;
  const debugSource = debugFile && existsSync(debugFile) ? readYaml(debugFile) : {};
  const switches = validate(debugFileSchema, debugSource, debugFile ?? '<inline debug defaults>');
  const warnings = [];
  const packets = parsePacketSwitches(switches.packets, {
    onUnknown: name => warnings.push(`${debugFile ?? 'debug.yml'}: unknown packet "${name}"`)
  });
  const channels = parseChannelSwitches(switches.channels, {
    onUnknown: name => warnings.push(`${debugFile ?? 'debug.yml'}: unknown channel "${name}"`)
  });

  return {
    file,
    logging: parsed.logging,
    room: {
      host: parsed.room.host,
      port: parsed.room.port,
      publicUri: parsed.room.public_uri,
      publicHost: endpoint.hostname.replace(/^\[|\]$/gu, ''),
      publicPort: Number(endpoint.port),
      maxPeers: parsed.room.max_peers,
      channels: parsed.room.channels,
      tickRate: parsed.room.tick_rate,
      maxPacketBytes: parsed.room.max_packet_bytes,
      badPacketLimit: parsed.room.bad_packet_limit,
      moveTimeoutMs: parsed.room.move_timeout_ms,
      playerStateDecode: parsed.room.player_state_decode
    },
    qwd: parsed.qwd,
    metrics: parsed.metrics,
    debug: { packets, channels, warnings }
  };
}
