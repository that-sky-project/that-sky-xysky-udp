import test from 'node:test'
import assert from 'node:assert/strict'
import { PlayerStore } from '../src/domain/PlayerStore.js'
import { LevelStateStore } from '../src/domain/LevelStateStore.js'
import { GameMessageService } from '../src/features/gamemsg/GameMessageService.js'
import { GameMsgType } from '../src/protocol/packets/shared/GameMsgPacket.js'
import { PacketIds } from '../src/protocol/PacketIds.js'
import { SnapshotReader } from '../src/protocol/snapshot/SnapshotReader.js'
import { SnapshotWriter } from '../src/protocol/snapshot/SnapshotWriter.js'
import { PLAYER_STATE_MAX_BYTES, SNAPSHOT_MAX_DATA_BYTES } from '../src/protocol/snapshot/constants.js'
import { rpcTap } from '../src/features/rpc/RpcTap.js'

const logger = { warn () {}, info () {}, debug () {} }
function fixture () {
  const players = new PlayerStore()
  const levels = new LevelStateStore({ roomId: 'room', logger })
  const sent = []
  const broadcaster = { send (session, packet) { sent.push({ session, packet }); return 0 } }
  const service = new GameMessageService({ players, levels, broadcaster, logger })
  function add (id, levelId, lvSeq = 1) {
    const session = { id: `session-${id}`, isActive: () => true }
    const player = players.add({ session, uuid: { toString: () => `uuid-${id}` }, levelId, levelChangeCount: lvSeq })
    session.player = player
    return player
  }
  return { players, levels, sent, broadcaster, service, add }
}
function upload (raw, type = GameMsgType.PlayerStateDelta, generation = 1) {
  const buffer = new SnapshotWriter().write(raw)
  return { type, levelChangeCount: generation,
    snapshot: { sequence: buffer[0], base: buffer[1], checksum: buffer[2] }, payload: buffer.subarray(3) }
}
function stateEntries (buffer) {
  const result = []
  let offset = 0
  while (offset < buffer.length) {
    const id = buffer[offset]
    const length = buffer.readUInt32LE(offset + 1)
    result.push({ id, raw: buffer.subarray(offset + 5, offset + 5 + length) })
    offset += 5 + length
  }
  assert.equal(offset, buffer.length)
  return result
}

test('stale generations are rejected before touch and ordinary forwarding', () => {
  const f = fixture(), source = f.add('a', 1, 9)
  let touches = 0
  source.touch = () => touches++
  f.service.handle(source.session, { type: GameMsgType.Critters, levelChangeCount: 8, payloadBytes: Buffer.from([1]) })
  assert.equal(touches, 0)
  assert.equal(source.lastOpaqueGameMsg, undefined)
  assert.equal(f.sent.length, 0)
})

test('opaque relay is level-scoped, excludes source and stamps recipient generation', () => {
  const f = fixture(), source = f.add('a', 1, 2), target = f.add('b', 1, 8)
  f.add('c', 2, 3)
  const bytes = Buffer.from([7, 8, 9])
  f.service.handle(source.session, { type: GameMsgType.MusicSync, levelChangeCount: 2, payloadBytes: bytes })
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].session, target.session)
  assert.equal(f.sent[0].packet.payload.levelChangeCount, 8)
  assert.equal(f.sent[0].packet.payload.sourcePlayer, source.id)
  assert.deepEqual(f.sent[0].packet.payload.payloadBytes, bytes)
})

test('raw PlayerState is repeatedly relayed across levels without echoing the source', () => {
  const f = fixture(), source = f.add('a', 1), target = f.add('b', 2, 7)
  const raw = Buffer.from([1, 2, 3, 4])
  source.playerDelta.rawState = raw
  source.playerDelta.decodedState = { partial: true }
  const reader = new SnapshotReader()
  for (let index = 0; index < 3; index++) {
    f.service.syncPlayerStates()
    const entry = f.sent.at(-1)
    assert.equal(entry.session, target.session)
    assert.equal(entry.packet.payload.levelChangeCount, 7)
    const frame = reader.read({ ...entry.packet.payload.snapshot, payload: entry.packet.payload.payload })
    assert.equal(frame.ok, true)
    assert.deepEqual(stateEntries(frame.data), [{ id: source.id, raw }])
  }
  assert.equal(f.sent.length, 3, 'unchanged raw state is not deduplicated out')
})

test('state decode failure preserves raw input and falls back to partial fields', () => {
  const f = fixture(), source = f.add('a', 1)
  const raw = Buffer.alloc(13)
  raw[0] = 1
  raw.writeFloatLE(1, 1); raw.writeFloatLE(2, 5); raw.writeFloatLE(3, 9)
  f.service.handle(source.session, upload(raw))
  assert.deepEqual(source.playerDelta.rawState, raw)
  assert.equal(source.playerDelta.decodedState.partial, true)
  assert.deepEqual(source.playerDelta.decodedState.fields.position, [1, 2, 3])
  assert.equal(source.lastStateLayout, undefined)
})

test('state encoding failure falls back to original bytes', () => {
  const f = fixture(), source = f.add('a', 1)
  f.add('b', 1)
  const raw = Buffer.from([9, 8, 7])
  source.playerDelta.rawState = raw
  source.playerDelta.decodedState = { get fields () { throw new Error('encode fixture') } }
  f.service.syncPlayerStates()
  const payload = f.sent[0].packet.payload
  const result = new SnapshotReader().read({ ...payload.snapshot, payload: payload.payload })
  assert.deepEqual(stateEntries(result.data), [{ id: source.id, raw }])
})

test('oversized input is not retained or serialized', () => {
  const f = fixture(), source = f.add('a', 1)
  f.add('b', 1)
  f.service.handle(source.session, upload(Buffer.alloc(PLAYER_STATE_MAX_BYTES + 1)))
  assert.equal(source.playerDelta.rawState, null)
  f.service.syncPlayerStates()
  assert.equal(f.sent.length, 0)
})

test('maximum eight-player batches stay within snapshot bounds and carry seven other players', () => {
  const f = fixture()
  for (let index = 0; index < 8; index++) {
    const player = f.add(String(index), index % 2)
    player.playerDelta.rawState = Buffer.alloc(PLAYER_STATE_MAX_BYTES, index)
    player.playerDelta.decodedState = { partial: true }
  }
  f.service.syncPlayerStates()
  assert.equal(f.sent.length, 16, 'seven maximum records require two frames per recipient')
  for (const player of f.players.list()) {
    const reader = new SnapshotReader()
    const entries = []
    for (const { packet } of f.sent.filter(entry => entry.session === player.session)) {
      const frame = reader.read({ ...packet.payload.snapshot, payload: packet.payload.payload })
      assert.equal(frame.ok, true)
      assert.ok(frame.data.length <= SNAPSHOT_MAX_DATA_BYTES)
      entries.push(...stateEntries(frame.data))
    }
    assert.equal(entries.length, 7)
    assert.ok(entries.every(entry => entry.id !== player.id && entry.raw.length === PLAYER_STATE_MAX_BYTES))
  }
})

test('ACK messages apply to both existing channel writers and advertise reader acknowledgements', () => {
  const f = fixture(), source = f.add('a', 1, 4)
  const calls = []
  source.playerDelta.ack = seq => calls.push(['player', seq])
  source.levelDelta.ack = seq => calls.push(['level', seq])
  f.service.handle(source.session, { type: GameMsgType.SnapshotAck, levelChangeCount: 4, playerAckSeq: 7, levelAckSeq: 8 })
  assert.deepEqual(calls, [['player', 7], ['level', 8]])
  source.playerDelta.readAckSequence = 0
  source.levelDelta.readAckSequence = 3
  f.service.sendSnapshotAcks()
  assert.deepEqual(f.sent[0].packet.payload, { type: GameMsgType.SnapshotAck, levelChangeCount: 4, sourcePlayer: 0, playerAckSeq: 0, levelAckSeq: 3 })
})

test('resync signalling retains both-channel checks and does not repeat cleared requests', () => {
  const f = fixture(), source = f.add('a', 1)
  f.add('b', 1)
  source.playerDelta.resyncRequired = true
  source.levelDelta.resyncRequired = true
  f.service.syncPlayerStates()
  assert.equal(f.sent.filter(entry => entry.packet.id === PacketIds.SnapshotResync).length, 2)
  assert.equal(source.playerDelta.resyncRequired, false)
  assert.equal(source.levelDelta.resyncRequired, false)
  f.service.syncPlayerStates()
  assert.equal(f.sent.length, 2)
})

test('RPC remains routed through the existing router and records stale drops', () => {
  const f = fixture(), source = f.add('a', 1), target = f.add('b', 1, 8)
  f.add('c', 2)
  const bytes = Buffer.from([1, 2, 3])
  const previous = rpcTap.enabled
  rpcTap.setEnabled(true); rpcTap.clear()
  try {
    f.service.handle(source.session, { type: GameMsgType.NetRpc, levelChangeCount: 0, rpcData: bytes })
    assert.equal(rpcTap.stats().staleDrops, 1)
    assert.equal(f.sent.length, 0)
    f.service.handle(source.session, { type: GameMsgType.NetRpc, levelChangeCount: 1, rpcData: bytes })
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].session, target.session)
    assert.deepEqual(f.sent[0].packet.payload.rpcData, bytes)
    assert.equal(f.sent[0].packet.payload.levelChangeCount, 8)
  } finally { rpcTap.clear(); rpcTap.setEnabled(previous) }
})
