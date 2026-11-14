import test from 'node:test'
import assert from 'node:assert/strict'
import { GameMessageDelivery } from '../src/features/gamemsg/GameMessageDelivery.js'
import { PlayerStateReplication } from '../src/features/gamemsg/PlayerStateReplication.js'
import { LevelDataReplication } from '../src/features/gamemsg/LevelDataReplication.js'
import { RpcRelay } from '../src/features/gamemsg/RpcRelay.js'
import { PlayerSnapshotState } from '../src/features/gamemsg/PlayerSnapshotState.js'
import { LevelStateStore } from '../src/domain/LevelStateStore.js'
import { GameMsgType } from '../src/protocol/packets/shared/GameMsgPacket.js'
import { decodePlayerState, encodePlayerState } from '../src/protocol/types/PlayerState.js'
import { SnapshotWriter } from '../src/protocol/snapshot/SnapshotWriter.js'
import { SnapshotReader } from '../src/protocol/snapshot/SnapshotReader.js'
import { decodeNetLevelDataMsg } from '../src/protocol/types/NetLevelDataMsg.js'
import { RpcTap } from '../src/features/rpc/RpcTap.js'
import { sendPacket } from '../src/features/broadcast/sendPacket.js'
import { BroadcastService } from '../src/features/broadcast/BroadcastService.js'
import { activePlayers, activePlayersInLevel } from '../src/domain/playerQueries.js'

const logger = { debug () {}, warn () {}, info () {} }
const player = (id, levelId = 1) => ({ id, levelId, lvSeq: id, uuid: { toString: () => `p${id}` },
  session: { id: `s${id}`, isActive: () => true }, playerDelta: new PlayerSnapshotState(), levelDelta: new PlayerSnapshotState() })
function harness (peers) {
  const sent = []
  const players = { listActive: () => peers, listActiveInLevel: id => peers.filter(p => p.levelId === id) }
  const broadcaster = { send (session, packet) { sent.push({ session, packet }); return 0 } }
  return { delivery: new GameMessageDelivery({ players, broadcaster }), broadcaster, sent }
}
function upload (raw) {
  const bytes = new SnapshotWriter().write(raw)
  return { snapshot: { sequence: bytes[0], base: bytes[1], checksum: bytes[2] }, payload: bytes.subarray(3) }
}

test('replication components independently preserve full/lite decode without duplicating snapshot channels', () => {
  const source = player(1), h = harness([source])
  const replication = new PlayerStateReplication({ ...h, logger })
  const channel = source.playerDelta
  replication.receive(source, upload(encodePlayerState({ fields: {} })))
  assert.equal(source.playerDelta, channel)
  assert.equal(source.playerDelta.decodedState.complete, true)
  assert.equal(source.lastStateLayout, source.playerDelta.decodedState.layout)
  source.playerDelta.reset()
  replication.stateDecode = 'basic'
  replication.receive(source, upload(Buffer.alloc(128)))
  assert.equal(source.playerDelta.decodedState.minimal, true)
  assert.equal(source.playerDelta.decodedState.complete, false)
})

test('full decode failure falls back to lite without claiming a complete layout', () => {
  const source = player(1), h = harness([source])
  const replication = new PlayerStateReplication({ ...h, logger })
  const raw = Buffer.alloc(128)
  replication.receive(source, upload(raw))
  assert.equal(source.playerDelta.decodedState.minimal, true)
  assert.equal(source.playerDelta.decodedState.complete, false)
  assert.equal(source.lastStateLayout, undefined)
  assert.deepEqual(source.playerDelta.rawState, raw)
})

test('real gift handler keeps both record framings intact through the RPC component', () => {
  const source = player(1), target = player(2), h = harness([source, target])
  source.uuid.bytes = Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab', 'hex')
  const rpc = new RpcRelay({ delivery: h.delivery, logger, tap: new RpcTap() })
  for (const slot of [false, true]) {
    const header = Buffer.alloc(slot ? 8 : 7)
    const offset = slot ? 1 : 0
    if (slot) header[0] = source.id
    header.writeUInt32LE(0x20d9b9b3, offset)
    header[offset + 4] = 0
    header.writeUInt16LE(36, offset + 5)
    const body = Buffer.alloc(36)
    body[2] = 1
    const input = Buffer.concat([header, body])
    rpc.receive(source, source.session, { type: GameMsgType.NetRpc, rpcData: input })
    const output = h.sent.at(-1).packet.payload.rpcData
    assert.deepEqual(output.subarray(0, header.length), header)
    assert.deepEqual(output.subarray(header.length + 11, header.length + 27), source.uuid.bytes)
    assert.deepEqual(output.subarray(header.length + 27), body.subarray(27))
    assert.deepEqual(input.subarray(header.length), body, 'router never mutates input')
  }
})

test('encoding cache belongs to player objects, not reused native IDs', () => {
  const first = player(1), h = harness([first])
  const replication = new PlayerStateReplication({ ...h, logger })
  const raw = encodePlayerState({ fields: {} })
  first.playerDelta.rawState = raw
  first.playerDelta.decodedState = decodePlayerState(raw)
  const serialized = replication.serializedState(first)
  assert.strictEqual(replication.serializedState(first), serialized)
  assert.equal(replication.encodedStates.has(first), true)
  const replacement = player(1)
  assert.equal(replication.encodedStates.has(replacement), false)
  replacement.playerDelta.rawState = Buffer.from([5, 6])
  replacement.playerDelta.decodedState = { partial: true }
  assert.deepEqual(replication.serializedState(replacement), Buffer.from([5, 6]))
})

test('level component preserves revoke-before-elect order and recipient epoch', () => {
  const a = player(1), b = player(2), h = harness([a, b])
  const levels = new LevelStateStore({ roomId: 'room', logger })
  levels.setAuthority(1, a)
  const component = new LevelDataReplication({ levels, delivery: h.delivery, logger })
  component.sendRevokeAndElect(1, a, b, undefined, 3)
  assert.deepEqual(h.sent.map(entry => entry.packet.payload.type), [9, 8, 9, 8])
  for (const entry of h.sent) {
    const target = entry.session === a.session ? a : b
    assert.equal(entry.packet.payload.levelChangeCount, target.lvSeq)
    if (entry.packet.payload.type !== GameMsgType.NetLevelDataElect) continue
    const payload = entry.packet.payload
    const frame = new SnapshotReader().read({ ...payload.snapshot, payload: payload.payload })
    const message = decodeNetLevelDataMsg(frame.data)
    assert.equal(message.authorityVersion, levels.getAuthorityVersion(1))
    assert.equal(message.electedPlayer, b.id)
  }
})

test('RPC component reuses supplied router and keeps per-recipient delivery separate from tap', () => {
  const source = player(1), target = player(2), other = player(3, 2), h = harness([source, target, other])
  const tap = new RpcTap()
  let calls = 0
  const rpc = new RpcRelay({ delivery: h.delivery, logger, tap, router: { process (bytes, context) {
    calls++; assert.equal(context.source, source); return Buffer.from([...bytes, 9])
  } } })
  rpc.receive(source, source.session, { type: GameMsgType.NetRpc, rpcData: Buffer.from([1, 2, 3]) })
  assert.equal(calls, 1)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].session, target.session)
  assert.deepEqual(h.sent[0].packet.payload.rpcData, Buffer.from([1, 2, 3, 9]))
  assert.equal(tap.list()[0].action, 'patched')
})

test('shared checked send accepts ENet zero, rejects negative, and preserves thrown failures/options', () => {
  const session = {}, packet = {}, options = { reliable: false }
  assert.equal(sendPacket({ send (s, p, o) { assert.equal(s, session); assert.equal(p, packet); assert.equal(o, options); return 0 } }, session, packet, options), 0)
  assert.throws(() => sendPacket({ send: () => -1 }, session, packet), /failed to queue/)
  assert.throws(() => sendPacket({ send () { throw new Error('transport closed') } }, session, packet), /transport closed/)
})

test('broadcast uses the same codec/log/metric send path for each eligible session', () => {
  const a = { peerId: 1, id: 'a', isActive: () => true }, b = { peerId: 2, id: 'b', isActive: () => true }
  const inactive = { peerId: 3, isActive: () => false }
  const writes = [], logs = [], sizes = []
  const service = new BroadcastService({ sessions: { list: () => [a, b, inactive] },
    codec: { encodeServer: (_packet, session) => Buffer.from([session.peerId]) },
    transport: { send: (...args) => writes.push(args) },
    metrics: { packetBytes: { inc: (_labels, size) => sizes.push(size) } },
    packetDebug: { log: (...args) => logs.push(args) } })
  service.broadcast({ id: 2 }, { exceptSession: a, channel: 1, reliable: false })
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], 2)
  assert.deepEqual(writes[0][2], { channel: 1, reliable: false })
  assert.equal(logs.length, 1)
  assert.deepEqual(sizes, [1])
})

test('shared player queries retain active and level policies for stores and test doubles', () => {
  const a = player(1), b = player(2), c = player(3, 2)
  b.session.isActive = () => false
  const store = { list: () => [a, b, c], listInLevel: level => [a, b, c].filter(p => p.levelId === level) }
  assert.deepEqual(activePlayers(store), [a, c])
  assert.deepEqual(activePlayersInLevel(store, 1), [a])
})
