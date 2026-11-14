import test from 'node:test'
import assert from 'node:assert/strict'
import { PlayerStore } from '../src/domain/PlayerStore.js'
import { LevelStateStore } from '../src/domain/LevelStateStore.js'
import { ConnectionManager } from '../src/connection/ConnectionManager.js'
import { ConnectionState } from '../src/connection/states.js'
import { JoinService } from '../src/features/join/JoinService.js'
import { MoveService } from '../src/features/move/MoveService.js'
import { LevelService } from '../src/features/level/LevelService.js'
import { RoomReservations } from '../src/qwd/RoomReservations.js'
import { MigrationRosters } from '../src/qwd/MigrationRosters.js'
import { createPlayerLifecycle } from '../src/runtime/playerLifecycle.js'
import { PeerEventHandler } from '../src/runtime/PeerEventHandler.js'
import { dispatchQwdCommand } from '../src/runtime/QwdCommands.js'
import { PacketIds } from '../src/protocol/PacketIds.js'

const logger = { info () {}, warn () {}, debug () {}, error () {} }
const gauge = { set () {}, inc () {} }
const metrics = { onlinePlayers: gauge, connectedPeers: gauge, disconnects: gauge, packetErrors: gauge,
  packetBytes: gauge, packets: gauge, packetDuration: { startTimer: () => () => {} }, admissionRejections: gauge }
const uuid = value => ({ toString: () => value })
function fixture () {
  const events = []; const sent = []; const left = []; const disconnected = []
  const players = new PlayerStore({ maxPlayers: 8 }); const sessions = new ConnectionManager({ roomId: 'room' })
  const levels = new LevelStateStore({ roomId: 'room', logger })
  const broadcaster = { send (session, packet) { sent.push({ session, packet }); return 0 },
    broadcast (packet) { if (packet.id === PacketIds.PlayerLeft) left.push(packet) } }
  const transport = { disconnect: (...args) => disconnected.push(args) }
  const publish = (event, data) => events.push({ event, data })
  const identity = { id: 'room' }
  const reservations = new RoomReservations({ players, identity, publish })
  const migration = new MigrationRosters({ players, reservations, logger })
  const levelService = new LevelService({ players, levels, broadcaster, logger })
  const moves = new MoveService({ players, broadcaster, transport, levelService, logger })
  const lifecycle = createPlayerLifecycle({ identity, publish, players, levels, levelService, sessions, transport,
    broadcaster, moveService: moves, reservations, metrics })
  const joins = new JoinService({ players, levels, levelService, broadcaster, logger, metrics, reservations,
    migration, onPlayerJoined: lifecycle.joined, onEvict: lifecycle.evicted })
  moves.finalizeSession = lifecycle.finalizeSession
  const target = { id: 'target', uuid: '00000000-0000-0000-0000-000000000001',
    address: { host: '127.0.0.1', port: 7777, toApi () { return { host: this.host, port: this.port } } } }
  let nextPeer = 1
  function join (name, extra = {}) {
    const session = sessions.add(nextPeer++); session.transition(ConnectionState.PENDING)
    return joins.join(session, { uuid: uuid(name), levelId: 10, levelChangeCount: 1, ...extra })
  }
  return { players, sessions, levels, sent, left, disconnected, broadcaster, transport, events, reservations,
    migration, levelService, moves, joins, lifecycle, target, join, identity }
}

test('ordinary joins cannot steal prepared slots; reserved arrivals convert outstanding capacity once', () => {
  const f = fixture(); f.join('host'); f.reservations.create('move', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert.throws(() => f.join('intruder'), error => error.code === 'NO_CAPACITY')
  assert.equal(f.players.size, 1)
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    const player = f.join(name)
    assert.equal(player.session.state, ConnectionState.ACTIVE)
    assert.equal(f.players.size + f.reservations.reservedSlots(), 8)
  }
  assert.equal(f.events.filter(entry => entry.event === 'move.completed').length, 1)
  assert.equal(f.reservations.size, 0)
  assert.throws(() => f.join('full'), error => error.code === 'NO_CAPACITY')
})

test('ordinary friend/direct arrivals remain allowed in genuinely spare unreserved capacity', () => {
  const f = fixture(); f.join('host'); f.reservations.create('move', ['a', 'b'])
  f.join('friend'); assert.equal(f.players.size, 2); assert.equal(f.reservations.reservedSlots(), 2)
})

test('negative ENet EnterGame send rolls back admission and preserves reservation', () => {
  const f = fixture(); f.reservations.create('move', ['a', 'b'])
  f.broadcaster.send = () => -1
  assert.throws(() => f.join('a', { moving: true, move: { players: [uuid('a'), uuid('b')] } }), /send|queue/i)
  assert.equal(f.players.size, 0); assert.equal(f.reservations.reservedSlots(), 2)
  assert.equal(f.events.length, 0)
  f.broadcaster.send = () => 0
  f.join('a', { moving: true, move: { players: [uuid('a'), uuid('b')] } })
  f.join('b', { moving: true, move: { players: [uuid('a'), uuid('b')] } })
  assert.equal(f.events.filter(entry => entry.event === 'move.completed').length, 1)
})

test('expired roster rebuild reuses already live UUID net IDs', () => {
  const f = fixture(); const group = [uuid('a'), uuid('b')]
  const a = f.join('a', { moving: true, move: { players: group } })
  f.migration.expire(Date.now() + 100_000); f.reservations.expire(Date.now() + 100_000)
  const b = f.join('b', { moving: true, move: { players: group } })
  const roster = f.sent.at(-1).packet.payload.players
  assert.equal(roster.find(entry => entry.uuid.toString() === 'a').netId, a.id)
  assert.notEqual(a.id, b.id)
})

test('native companion-only join rosters include self internally and reuse reciprocal arrivals', () => {
  const f = fixture()
  const a = f.join('a', { moving: true, move: { players: [uuid('b')] } })
  const first = f.sent.at(-1).packet.payload.players
  assert.equal(first.length, 2)
  assert.equal(first.find(entry => entry.uuid.toString() === 'a').netId, a.id)
  const reservedB = first.find(entry => entry.uuid.toString() === 'b').netId
  assert.equal(f.reservations.reservedSlots(), 1)
  const b = f.join('b', { moving: true, move: { players: [uuid('a')] } })
  assert.equal(b.id, reservedB)
  assert.equal(f.players.size, 2)
  assert.equal(f.migration.size, 0)
  assert.equal(f.reservations.reservedSlots(), 0)
})

test('seven companions plus self fit eight room slots without widening the wire roster bound', () => {
  const f = fixture()
  const group = Array.from({ length: 8 }, (_, index) => `member-${index}`)
  const first = f.join(group[0], { moving: true, move: { players: group.slice(1).map(uuid) } })
  const advertised = new Map(f.sent.at(-1).packet.payload.players.map(entry => [entry.uuid.toString(), entry.netId]))
  assert.equal(advertised.size, 8)
  assert.equal(advertised.get(group[0]), first.id)
  for (const name of group.slice(1)) {
    const current = f.join(name, { moving: true, move: { players: group.filter(other => other !== name).map(uuid) } })
    assert.equal(current.id, advertised.get(name))
  }
  assert.equal(f.players.size, 8)
  assert.equal(f.reservations.reservedSlots(), 0)
  assert.equal(f.migration.size, 0)
  const invalid = fixture()
  assert.throws(() => invalid.join('a', { moving: true, move: { players: [uuid('b'), uuid('b')] } }), /invalid migration roster/)
  assert.throws(() => invalid.join('a', { moving: true, move: { players: group.map(uuid) } }), /invalid migration roster/)
  assert.equal(invalid.players.size, 0)
})

test('all-member move preflight refuses silent subset dragging and negative sends', () => {
  const f = fixture(); const a = f.join('a'); const b = f.join('b'); b.session.transition(ConnectionState.MOVING)
  const before = f.sent.length
  assert.equal(f.moves.movePlayersAtomic([a, b], f.target).accepted, false)
  assert.equal(f.sent.length, before); assert.equal(a.session.state, ConnectionState.ACTIVE)
  b.session.transition(ConnectionState.ACTIVE); f.broadcaster.send = () => -1
  assert.equal(f.moves.movePlayersAtomic([a, b], f.target).accepted, false)
  assert.equal(f.moves.listPending().length, 0); assert.equal(a.session.state, ConnectionState.ACTIVE)
})

test('source success ACK keeps cleanup deadline; disconnectNow finalizes domain exactly once', () => {
  const f = fixture(); const a = f.join('a'); const b = f.join('b')
  assert.equal(f.moves.movePlayersAtomic([a], f.target, { moveId: 'tx' }).accepted, true)
  f.moves.handleMoveResult(a.session, { result: 0 }); f.moves.handleMoveResult(a.session, { result: 0 })
  assert.equal(f.moves.listPending().length, 1)
  f.moves.expireStuckMoves(Date.now() + 20_001)
  assert.equal(f.players.size, 1); assert.equal(f.sessions.get(a.session.peerId), undefined)
  assert.equal(f.players.getByUuid('b'), b)
  f.lifecycle.finalizeSession(a.session, 'duplicate', { disconnect: 'now' })
  assert.equal(f.events.filter(entry => entry.event === 'player.leave').length, 1)
  assert.equal(f.left.length, 1); assert.equal(f.moves.listPending().length, 0)
})

test('late old-session move result/finalization cannot remove reused pointer replacement', () => {
  const f = fixture(); const a = f.join('a'); f.moves.movePlayersAtomic([a], f.target, { moveId: 'tx' })
  const old = a.session
  const replacement = f.sessions.add(old.peerId); replacement.transition(ConnectionState.PENDING)
  const current = f.joins.join(replacement, { uuid: uuid('a'), levelId: 10, levelChangeCount: 2 })
  f.moves.handleMoveResult(old, { result: 1 }); f.lifecycle.finalizeSession(old, 'late', { disconnect: 'now' })
  assert.equal(f.players.getByUuid('a'), current); assert.equal(f.sessions.get(old.peerId), replacement)
  assert.equal(current.session.state, ConnectionState.ACTIVE)
  assert.equal(f.disconnected.length, 0, 'never disconnect a recycled pointer belonging to another session')
})

test('u8 level generations reject stale/equal conflicting levels, accept wrap and duplicate init', () => {
  const f = fixture(); const a = f.join('a', { levelChangeCount: 254 })
  f.levelService.changeLevel(a.session, { levelId: 10, levelChangeCount: 254 })
  assert.equal(a.levelReady, true)
  f.levelService.changeLevel(a.session, { levelId: 11, levelChangeCount: 255 })
  f.levelService.changeLevel(a.session, { levelId: 12, levelChangeCount: 0 })
  const version = f.levels.getAuthorityVersion(12)
  f.levelService.changeLevel(a.session, { levelId: 99, levelChangeCount: 255 })
  f.levelService.changeLevel(a.session, { levelId: 99, levelChangeCount: 0 })
  assert.equal(a.levelId, 12); assert.equal(a.lvSeq, 0)
  assert.equal(f.levels.getAuthorityVersion(12), version)
})

test('commit expected participant session/level/generation guard fails before sending', () => {
  const f = fixture(); const a = f.join('a'); const before = f.sent.length
  const context = { ...f, moveService: f.moves, telemetry: { version: 3 }, qwd: { publish () {} } }
  for (const wrong of [{ sessionId: 'replaced' }, { levelId: 11 }, { lvSeq: 2 }]) {
    const result = dispatchQwdCommand({ cmd: 'move.commit', data: { moveId: 'tx', toRoomId: 'target',
      toRoomUuid: f.target.uuid, udpHost: '127.0.0.1', udpPort: 7777, playerIds: ['a'],
      expectedParticipants: [{ playerId: 'a', sessionId: a.session.id, levelId: 10, lvSeq: 1, ...wrong }] } }, context)
    assert.equal(result.code, 4090)
  }
  assert.equal(f.sent.length, before)
})

test('reservation ACK validates leases, physical MOVING occupancy, token ownership and room.sync', () => {
  const f = fixture(); const a = f.join('a'); a.session.transition(ConnectionState.MOVING)
  let syncs = 0
  const context = { ...f, moveService: f.moves, telemetry: { version: 7, forceFull () { syncs++ } }, qwd: { publish () {} } }
  const command = { cmd: 'move.prepare', data: { moveId: 'tx', reservationToken: 'owner', playerIds: ['b', 'c'], ttlMs: 35_000 } }
  const result = dispatchQwdCommand(command, context)
  assert.equal(result.code, 0); assert.equal(result.data.capacity, 8); assert.equal(result.data.physicalPlayers, 1)
  assert.equal(result.data.activePlayers, 0); assert.equal(result.data.reservedSlots, 2); assert.equal(result.data.version, 7)
  assert.ok(Number.isFinite(result.data.expiresAt))
  assert.equal(dispatchQwdCommand({ cmd: 'move.cancel', data: { moveId: 'tx', reservationToken: 'wrong' } }, context).code, 4009)
  assert.equal(f.reservations.size, 1)
  assert.equal(dispatchQwdCommand({ ...command, data: { ...command.data, ttlMs: NaN } }, context).code, 4000)
  assert.equal(dispatchQwdCommand({ cmd: 'room.sync', data: {} }, context).code, 0); assert.equal(syncs, 1)
})

test('full-room join business rejection does not increment bad packets or warning flood', () => {
  const f = fixture(); for (let i = 0; i < 8; i++) f.join(`p${i}`)
  let warnings = 0
  const handler = new PeerEventHandler({ config: { maxPeers: 32, maxPacketBytes: 100, badPacketLimit: 3 }, ...f,
    moveService: f.moves, metrics, logger: { ...logger, warn () { warnings++ } },
    codec: { decodeClient: () => ({ id: PacketIds.JoinGame, token: 1, name: 'JoinGame', payload: { uuid: uuid('full') } }) },
    dispatcher: { dispatch: (session, packet) => f.joins.join(session, packet.payload) },
    finalizeSession: f.lifecycle.finalizeSession })
  handler.onConnect(90); const session = f.sessions.get(90)
  for (let i = 0; i < 100; i++) handler.onMessage(90, Buffer.alloc(6))
  assert.equal(session.badPackets, 0); assert.equal(session.closed, true)
  assert.equal(f.sessions.get(90), undefined); assert.ok(warnings <= 1)
})
