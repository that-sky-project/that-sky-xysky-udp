import test from 'node:test';
import assert from 'node:assert/strict';

import { PacketIds } from '../src/protocol/PacketIds.js';
import { GameMsgType } from '../src/protocol/packets/shared/GameMsgPacket.js';
import {
  DEBUG_CHANNEL_NAMES,
  NOISY_PACKET_NAMES,
  PACKET_LOG_NAMES,
  PacketDebugLog,
  PacketFormatter,
  parseChannelSwitches,
  parsePacketSwitches,
  packetLogName
} from '../src/observability/debugPackets.js';

test('a GameMsg is named by its inner type, not by the outer envelope', () => {
  // The outer id is 14 for every GameMsg; only the inner type says what it is,
  // and the inner name is what debug.yml switches.
  assert.equal(
    packetLogName({ id: PacketIds.GameMsg, payload: { type: GameMsgType.PlayerStateDelta } }),
    'PlayerStateDelta'
  );
  assert.equal(
    packetLogName({ id: PacketIds.GameMsg, payload: { type: GameMsgType.NetLevelData } }),
    'NetLevelData'
  );
  assert.equal(
    packetLogName({ id: PacketIds.GameMsg, payload: { type: GameMsgType.NetLevelDataElect } }),
    'NetLevelDataElect'
  );
});

test('an unknown outer id still gets a stable, greppable name', () => {
  assert.equal(packetLogName({ id: 200 }), 'Packet200');
  assert.equal(packetLogName({}), null);
});

test('every name the defaults mention is a real packet name', () => {
  const known = new Set(PACKET_LOG_NAMES);
  const missing = NOISY_PACKET_NAMES.filter((name) => !known.has(name));
  assert.deepEqual(missing, [], 'a name in NOISY_PACKET_NAMES would silently never match');
});

test('switches only enable the names set to true, and report typos', () => {
  const unknown = [];
  const enabled = parsePacketSwitches(
    { PlayerStateDelta: false, JoinGame: true, NotAPacket: true },
    { onUnknown: (name) => unknown.push(name) }
  );

  assert.equal(enabled.has('JoinGame'), true);
  assert.equal(enabled.has('PlayerStateDelta'), false);
  assert.deepEqual(unknown, ['NotAPacket'], 'a typo must be surfaced, not swallowed');
});

test('the packet log stays quiet for a packet whose switch is off', () => {
  const lines = [];
  const log = new PacketDebugLog({
    logger: { debug: (data, message) => lines.push({ data, message }) },
    enabled: new Set(['JoinGame'])
  });

  assert.equal(log.log('c2s', { id: PacketIds.JoinGame }), true);
  assert.equal(log.log('c2s', { id: PacketIds.GameMsg, payload: { type: GameMsgType.PlayerStateDelta } }), false);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'packet');
  assert.equal(lines[0].data.packet, 'JoinGame');
});

test('a periodic GameMsg is silent while a control one is not', () => {
  const lines = [];
  const log = new PacketDebugLog({
    logger: { debug: () => lines.push(1) },
    enabled: new Set(['NetLevelDataElect'])
  });

  log.log('s2c', { id: PacketIds.GameMsg, payload: { type: GameMsgType.NetLevelData } });
  assert.equal(lines.length, 0, 'the per-tick level snapshot must not spam');

  log.log('s2c', { id: PacketIds.GameMsg, payload: { type: GameMsgType.NetLevelDataElect } });
  assert.equal(lines.length, 1);
});

test('the formatter truncates buffers instead of dumping kilobytes of hex', () => {
  const formatter = new PacketFormatter({ maxBufferBytes: 8 });
  const out = formatter.bytes(Buffer.alloc(4096, 0xab));

  assert.equal(out.bytes, 4096);
  assert.equal(out.head.length, 16, 'eight bytes of hex');
  assert.equal(out.truncated, true);
});

test('the formatter summarises a packet payload and stops at max depth', () => {
  const formatter = new PacketFormatter({ maxDepth: 2 });
  const out = formatter.packet({
    id: PacketIds.GameMsg,
    name: 'GameMsgPacket',
    sequence: 7,
    payload: { type: 3, nested: { deeper: { tooDeep: 1 } } }
  });

  assert.equal(out.id, PacketIds.GameMsg);
  assert.equal(out.sequence, 7);
  assert.equal(out.payload.type, 3);
  assert.equal(out.payload.nested.deeper, '[max-depth]');
});

test('channel switches are independent of packet switches', () => {
  const unknown = [];
  const channels = parseChannelSwitches(
    { qwdCommand: true, NotAChannel: true },
    { onUnknown: (name) => unknown.push(name) }
  );

  assert.equal(channels.has('qwdCommand'), true);
  assert.deepEqual(unknown, ['NotAChannel']);
  // A packet name is not a channel name: the two maps must not bleed together.
  assert.equal(channels.has('JoinGame'), false);
});

test('no channel name collides with a packet name', () => {
  assert.deepEqual(
    DEBUG_CHANNEL_NAMES.filter((name) => PACKET_LOG_NAMES.includes(name)),
    [],
    'a shared name would make one switch do two unrelated things'
  );
});

test('a channel log line only prints when its own switch is on', () => {
  const lines = [];
  const log = new PacketDebugLog({
    logger: { debug: (data, message) => lines.push({ data, message }) },
    enabled: new Set(['JoinGame']),
    channels: new Set(['qwdCommand'])
  });

  assert.equal(log.logChannel('qwdCommand', { cmd: 'room.reserve' }, 'qwd command'), true);
  // A packet switch must not turn a channel on, nor the reverse.
  assert.equal(log.isChannelEnabled('JoinGame'), false);
  assert.equal(log.isEnabled({ id: PacketIds.JoinGame }), true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].data.channel, 'qwdCommand');
  assert.equal(lines[0].message, 'qwd command');
});
