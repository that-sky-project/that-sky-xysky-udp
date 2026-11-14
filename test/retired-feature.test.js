import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { GameMessageService } from '../src/features/gamemsg/GameMessageService.js'
import { handleGameMsg } from '../src/connection/handlers/handleGameMsg.js'
import { GameMsgType } from '../src/protocol/packets/shared/GameMsgPacket.js'
import { PacketIds } from '../src/protocol/PacketIds.js'
import { PacketCodec } from '../src/protocol/PacketCodec.js'
import { RoomReservations } from '../src/qwd/RoomReservations.js'
import { QWD_COMMANDS, dispatchQwdCommand } from '../src/runtime/QwdCommands.js'
import { QwdTelemetry } from '../src/qwd/QwdTelemetry.js'
import { createPlayerLifecycle } from '../src/runtime/playerLifecycle.js'
import { RoomTick } from '../src/runtime/RoomTick.js'

const retiredTypes = [18, 19, 20, 21, 22, 24]
const retiredCommands = ['seat.assign', 'seat.release', 'audience.snapshot', 'audience.reaction',
  'audience.chatGlobal', 'performance.state', 'performance.decision', 'performance.deliver',
  'performance.gap', 'liveBroadcast.capability', 'liveBroadcast.deliver']

test('retired numeric GameMsg types are inert before any player lookup or mutation', () => {
  const service = new GameMessageService({
    players: { getBySession () { assert.fail('retired message touched player state') } },
    levels: {}, logger: {}, broadcaster: { send () { assert.fail('retired message relayed') } }
  })
  for (const type of retiredTypes) {
    handleGameMsg({}, { type, levelChangeCount: 0, payloadBytes: Buffer.from([1, 2]) }, { gameMessageService: service })
  }
  assert.equal('latestAcks' in service, false, 'write-only diagnostic ACK cache was removed')
  assert.equal(service.playerStates.decodeDumpSignatures.size, 0)
})

test('wire enum gaps remain unassigned and ordinary side channel stays 23', () => {
  for (const type of retiredTypes) assert.equal(Object.values(GameMsgType).includes(type), false)
  assert.equal(GameMsgType.LevelStateSideChannel, 23)
  for (const id of [18, 22, 23, 24, 25, 26, 27, 28, 29, 32, 33]) {
    assert.equal(Object.values(PacketIds).includes(id), false)
  }
})

test('retired outer packet ids retain existing unknown-packet decoding', () => {
  const codec = new PacketCodec()
  for (const id of [18, 22, 23, 24, 25, 26, 27, 28, 29, 32, 33]) {
    const wire = Buffer.from([1, 0, 0, 0, id, 7, 5, 6])
    const packet = codec.decodeClient(wire)
    assert.equal(packet.unknown, true)
    assert.equal(packet.id, id)
    assert.deepEqual(packet.payload.raw, Buffer.from([5, 6]))
  }
})

test('core room.reserve remains idempotent and honors eight-player capacity plus migration holds', () => {
  const players = { size: 6, maxPlayers: 8, getByUuid: () => undefined }
  const identity = { id: 'room' }
  const reservations = new RoomReservations({ players, identity, publish () {} })
  reservations.create('migration', ['migrating'])
  const context = { players, identity, reservations, telemetry: { version: 1 } }
  const command = { cmd: 'room.reserve', data: { roomId: 'room', playerId: 'joining' } }
  const result = dispatchQwdCommand(command, context)
  assert.equal(result.code, 0)
  assert.equal(reservations.reservedSlots(), 2)
  const repeated = dispatchQwdCommand(command, context)
  assert.equal(repeated.code, 0)
  assert.equal(repeated.data.reservationId, result.data.reservationId)
  assert.equal(repeated.data.idempotent, true)
  assert.ok(repeated.data.expiresAt >= result.data.expiresAt)
  assert.notEqual(dispatchQwdCommand({ ...command, data: { ...command.data, playerId: 'ninth' } }, context).code, 0)
  assert.equal(reservations.get('migration').playerIds.has('migrating'), true)
  assert.equal(reservations.reservedSlots(), 2)
})

test('only core QWD allocation and move commands remain; retired commands cannot access context', () => {
  assert.deepEqual([...QWD_COMMANDS.keys()], ['room.reserve', 'room.sync', 'move.prepare', 'move.renew', 'move.cancel', 'move.commit', 'player.redirect'])
  const context = new Proxy({}, { get () { assert.fail('retired command accessed room state') } })
  for (const cmd of retiredCommands) assert.equal(dispatchQwdCommand({ cmd, data: {} }, context).code, 4000)
})

test('telemetry emits only ordinary player facts, never seat fields or seat callbacks', () => {
  const player = { id: 1, uuid: { toString: () => 'player' }, levelId: 7, lastSeenAt: 0,
    benchId: 12, seatId: 4, playerDelta: { decodedState: { fields: { position: [1, 2, 3] } }, stats: {} } }
  let now = 0
  const frames = []
  const telemetry = new QwdTelemetry({ players: { listActive: () => [player] }, now: () => now,
    seatOf () { assert.fail('removed seat callback invoked') },
    publishTelemetry: (players, seq, framing) => frames.push({ players, seq, framing }) })
  telemetry.publish()
  player.benchId++; player.seatId++; now = 1000; telemetry.publish()
  assert.equal(frames.length, 1, 'seat changes do not produce a telemetry delta')
  player.playerDelta.decodedState.fields.position[0]++; now = 2000; telemetry.publish()
  assert.equal(frames.length, 2)
  for (const frame of frames) {
    assert.equal('benchId' in frame.players[0], false)
    assert.equal('seatId' in frame.players[0], false)
  }
})

test('composition has no retired feature dependencies and deleted modules stay absent', () => {
  const composition = readFileSync(new URL('../src/runtime/composition.js', import.meta.url), 'utf8')
  assert.doesNotMatch(composition, /audience|performance|liveBroadcast|seatOf/i)
  assert.match(composition, /const ROOM_CAPACITY = 8/)
  for (const path of ['src/features/audience/AudienceService.js', 'src/runtime/audiencePorts.js',
    'src/protocol/AudienceCodec.js', 'src/protocol/types/Audience.js',
    'src/protocol/packets/client/AudienceRequests.js', 'src/protocol/packets/server/AudiencePackets.js',
    'src/protocol/identityHash.js']) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, path)
  }
})

test('ordinary player join/eviction preserves reservation, move, disconnect and PlayerLeft ownership', () => {
  const events = [], actions = []
  const player = { id: 2, uuid: { toString: () => 'player' }, levelId: 7, session: { id: 'session', peerId: 5 } }
  const lifecycle = createPlayerLifecycle({ identity: { id: 'room' },
    publish: (event, data) => events.push({ event, data }),
    reservations: { consume: id => actions.push(['consume', id]) },
    moveService: { forgetPlayerMoves: value => actions.push(['moves', value.id]) },
    sessions: { get: () => player.session, remove: peerId => actions.push(['remove', peerId]) },
    transport: { disconnect: (...args) => actions.push(['disconnect', ...args]) },
    broadcaster: { broadcast: (packet, options) => actions.push(['broadcast', packet.id, packet.payload.playerId, options.playerOnly]) } })
  lifecycle.joined(player); lifecycle.evicted(player)
  assert.deepEqual(events.map(item => item.event), ['player.join', 'player.leave'])
  assert.deepEqual(actions, [['consume', 'player'], ['remove', 5], ['moves', 2], ['broadcast', PacketIds.PlayerLeft, 2, true], ['disconnect', 5, 'now']])
})

test('core tick synchronizes players and level data, expires holds, and stops without feature lanes', async () => {
  const calls = []
  const record = name => () => calls.push(name)
  const tick = new RoomTick({ players: { size: 2 }, sessions: { size: 3 },
    metrics: { connectedPeers: { set: value => calls.push(value) }, onlinePlayers: { set: value => calls.push(value) } },
    migrationRosters: { expire: record('migration') }, reservations: { expire: record('reservations') },
    moveService: { expireStuckMoves: record('moves') },
    gameMessageService: { syncPlayerStates: record('players'), syncLevelData: record('levels'), sendSnapshotAcks: record('acks') },
    telemetry: { publish: record('telemetry') } })
  tick.tick()
  assert.deepEqual(calls, ['migration', 'reservations', 'moves', 3, 2, 'players', 'levels', 'acks', 'telemetry'])
  await tick.stop(); tick.tick()
  assert.equal(calls.length, 9)
})
