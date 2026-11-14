import { PacketIds } from '../protocol/PacketIds.js';
import { GameMsgType } from '../protocol/packets/shared/GameMsgPacket.js';

const PACKET_ID_NAMES = invertIds(PacketIds);
const GAME_MSG_TYPE_NAMES = invertIds(GameMsgType);

function invertIds(source) {
  const names = new Map();
  for (const [name, id] of Object.entries(source)) names.set(id, name);
  return names;
}

export const PACKET_LOG_NAMES = Object.freeze([
  'NetRpc',
  'PlayerStateDelta',
  'Critters',
  'Affinity',
  'NetLevelDataElect',
  'NetLevelDataRevoke',
  'NetLevelDataRevokeAck',
  'NetLevelData',
  'NetLevelDataHeartbeat',
  'SnapshotAck',
  'MusicSync',
  'Metrics',
  'NetLevelElectionNominee',
  'LevelStateSideChannel',
  'JoinGame',
  'EnterGame',
  'LevelUpdate',
  'MoveGame',
  'MoveResult',
  'CancelMove',
  'Disconnect',
  'Kick',
  'PlayerLeft',
  'PlayerChangeLevel',
  'NetTimePing',
  'NetTimePong'
]);

export const NOISY_PACKET_NAMES = Object.freeze([
  'PlayerStateDelta',
  'NetLevelData',
  'SnapshotAck',
  'Affinity',
  'LevelStateSideChannel',
  'NetLevelDataHeartbeat',
  'Metrics',
  'Critters',
  'MusicSync'
]);

export const DEBUG_CHANNEL_NAMES = Object.freeze([
  'qwdCommand'
]);

/**
 * Resolve the log name for a decoded packet.
 *
 * The inner GameMsg type is preferred when there is one: `GameMsg` alone says
 * nothing useful, and it is the inner name that `debug.yml` switches.
 *
 * @param {object} packet decoded packet `{ id, payload }`
 * @returns {string|null} the name, or null when it cannot be determined
 */
export function packetLogName(packet) {
  const id = packet?.id;
  if (id === PacketIds.GameMsg) {
    return GAME_MSG_TYPE_NAMES.get(packet.payload?.type) ?? `GameMsg/${packet.payload?.type}`;
  }
  return PACKET_ID_NAMES.get(id) ?? (id === undefined ? null : `Packet${id}`);
}

/**
 * Parse `debug.yml`'s `packets` map into the set of enabled names.
 *
 * Unknown keys are reported rather than silently dropped: a typo in a switch
 * otherwise looks exactly like "that packet is not arriving".
 *
 * @param {Record<string, boolean>} [packets]
 * @param {{ onUnknown?: (name: string) => void }} [options]
 * @returns {Set<string>} the enabled packet names
 */
export function parsePacketSwitches(packets, { onUnknown } = {}) {
  return parseSwitches(packets, PACKET_LOG_NAMES, onUnknown);
}

/**
 * Parse `debug.yml`'s `channels` map — the `DEBUG_CHANNEL_NAMES` switches.
 *
 * @param {Record<string, boolean>} [channels]
 * @param {{ onUnknown?: (name: string) => void }} [options]
 * @returns {Set<string>} the enabled channel names
 */
export function parseChannelSwitches(channels, { onUnknown } = {}) {
  return parseSwitches(channels, DEBUG_CHANNEL_NAMES, onUnknown);
}

function parseSwitches(source, knownNames, onUnknown) {
  const known = new Set(knownNames);
  const enabled = new Set();

  for (const [name, value] of Object.entries(source ?? {})) {
    if (!known.has(name)) {
      onUnknown?.(name);
      continue;
    }
    if (value === true) enabled.add(name);
  }
  return enabled;
}

export class PacketFormatter {
  constructor({ maxBufferBytes = 128, maxDepth = 3 } = {}) {
    this.maxBufferBytes = maxBufferBytes;
    this.maxDepth = maxDepth;
  }

  bytes(data, { header } = {}) {
    const buffer = Buffer.from(data);
    return {
      bytes: buffer.length,
      head: buffer.subarray(0, this.maxBufferBytes).toString('hex'),
      ...(buffer.length > this.maxBufferBytes ? { truncated: true } : {}),
      ...(header ? { header } : {})
    };
  }

  packet(packet) {
    return {
      id: packet.id,
      name: packet.name ?? packetLogName(packet),
      sequence: packet.sequence,
      payload: this.value(packet.payload, 0)
    };
  }

  value(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'bigint') return value.toString();
    if (Buffer.isBuffer(value)) {
      return { bytes: value.length, hex: value.subarray(0, this.maxBufferBytes).toString('hex') };
    }
    if (Array.isArray(value)) {
      if (depth >= this.maxDepth) return `[${value.length} items]`;
      return value.map(item => this.value(item, depth + 1));
    }
    if (typeof value === 'object') {
      if (depth >= this.maxDepth) return '[max-depth]';
      const output = {};
      for (const [key, item] of Object.entries(value)) output[key] = this.value(item, depth + 1);
      return output;
    }
    return value;
  }
}

export class PacketDebugLog {
  /**
   * @param {object} options
   * @param {object} options.logger pino-compatible logger
   * @param {Set<string>} [options.enabled] packet names to log
   * @param {Set<string>} [options.channels] channel names to log
   * @param {PacketFormatter} [options.formatter]
   */
  constructor({ logger, enabled, channels, formatter = new PacketFormatter() } = {}) {
    this.logger = logger;
    this.enabled = enabled ?? new Set();
    this.channels = channels ?? new Set();
    this.formatter = formatter;
  }

  isEnabled(packet) {
    const name = packetLogName(packet);
    if (name === null) return false;
    return this.enabled.has(name);
  }

  isChannelEnabled(channel) {
    return this.channels.has(channel);
  }

  /**
   * Log through a named channel if its switch is on.
   *
   * Used for the streams that are one lens over many packets rather than a
   * single packet — for example, the manager's command feed.
   *
   * @returns {boolean} whether the line was emitted
   */
  logChannel(channel, fields, message) {
    if (!this.isChannelEnabled(channel)) return false;
    this.logger?.debug?.({ channel, ...fields }, message);
    return true;
  }

  /**
   * Log a packet if its switch is on.
   *
   * The decoded payload is included so the line is self-contained: reading
   * `NetLevelDataElect levelId=263580627 dataLength=0` beats reading an id and
   * then hunting for the bytes in a capture.
   *
   * @returns {boolean} whether the line was emitted
   */
  log(direction, packet, context = {}) {
    if (!this.isEnabled(packet)) return false;
    const name = packetLogName(packet);
    this.logger?.debug?.({
      direction,
      packet: name,
      ...context,
      decoded: this.formatter.packet(packet).payload
    }, 'packet');
    return true;
  }
}
