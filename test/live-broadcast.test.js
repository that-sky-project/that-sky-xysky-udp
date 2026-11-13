import test from 'node:test'
import assert from 'node:assert/strict'
import { AudienceService } from '../src/features/audience/AudienceService.js'
import { PerformanceAuthority } from '../src/features/audience/PerformanceAuthority.js'
import { LiveBroadcastService } from '../src/features/audience/LiveBroadcastService.js'
import { dispatchQwdCommand } from '../src/runtime/QwdCommands.js'
import { QwdClient } from '../src/qwd/QwdClient.js'
import { BinaryReader, BinaryWriter, SocialBroadcastDownPacket } from '../src/protocol/packets/server/AudiencePackets.js'

const L = 263580627, H = 1559613961
const A = '79a9c25c-be60-4da5-9f80-ea24c04cd268', B = '0d17e2c6-cdbd-40a5-983d-b9deb380dd00', C = '7f75f1b5-c3d2-4ed5-9bb7-f13133f08047'
const log = { info () {}, warn () {}, debug () {} }
const cap = (extra = {}) => ({ authorityEpoch: 'epoch', capabilityId: 'cap', revision: 1, levelId: L,
  allowedPlayerIds: [A], serverNowMs: 100000, expiresAtMs: 105000, ...extra })
const delivery = (extra = {}) => ({ authorityEpoch: 'epoch', capabilityId: 'cap', levelId: L, playerId: A,
  streamId: 'stream', eventId: 'event', eventSeq: 1, serverNowMs: 100000, expiresAtMs: 103000,
  timestamp: 100.25, actionId: 0, payloadBase64: Buffer.from('{"opaque":"原字节"}').toString('base64'), ...extra })
async function setup ({ skew = 0, ids = [A, B], allowed = [A] } = {}) {
  const time = { wall: 100000 + skew, mono: 0 }, sessions = new Map(), output = [], upstream = []
  const audience = new AudienceService({ logger: log, clock: () => time.wall, barnClock: () => time.wall / 1000,
    currentLevelOf: id => sessions.get(id)?.player.levelId,
    sendToClient: async (playerId, packet) => { output.push({ playerId, packet }); return 0 } })
  const common = { audience, clock: () => time.wall, monotonic: () => time.mono, logger: log, roomId: () => 'room',
    sessionOf: id => sessions.get(id), levels: () => [...sessions.values()].map(s => s.player.levelId),
    publish: (event, data) => { upstream.push({ event, data }); return true } }
  const authority = audience.performance = new PerformanceAuthority(common)
  let serial = 0
  const live = new LiveBroadcastService({ ...common, id: () => `random-${++serial}` })
  for (const [index, id] of ids.entries()) {
    sessions.set(id, { closed: false, isActive: () => true, player: { uuid: { toString: () => id }, levelId: L, lvSeq: 3 } })
    await audience.seatPlayer({ playerId: id, levelId: L, benchId: 1, seatId: index, position: [index, 0, 0], levelTime: time.wall / 1000 })
  }
  authority.connected(); live.connected()
  await authority.state({ authorityEpoch: 'epoch', revision: 1, levelId: L, serverNowMs: 100000, current: null, preparing: null, queue: [], lastEnded: null })
  const cmd = (cmd, data) => dispatchQwdCommand({ cmd, data }, { audienceService: audience, liveBroadcastService: live })
  assert.equal((await cmd('liveBroadcast.capability', cap({ allowedPlayerIds: allowed }))).code, 0)
  output.length = 0
  return { time, sessions, output, upstream, audience, authority, live, cmd }
}
const content = n => n.output.filter(row => row.packet.id === 24)
const request = extra => ({ timestamp: 100.25, actionId: 0, generation: 3, payload: Buffer.from('{"x":1}'), ...extra })

test('capability canonical UUID allowlist enables only exact live local source and copies flags', async () => {
  const n = await setup({ allowed: [A.toUpperCase()] })
  assert(n.live.canPublish(A, L)); assert(!n.live.canPublish(B, L)); assert(!n.live.canPublish(A, H))
  n.audience.streamInfo = { ...n.audience.idleStreamInfo, flags: [true, true, false, true, true] }
  await n.audience.sendPerformanceInfo(L)
  const infos = n.output.filter(row => row.packet.id === 28)
  assert.deepEqual(infos.find(row => row.playerId === A).packet.payload.flags, [true, true, true, true, false])
  assert.deepEqual(infos.find(row => row.playerId === B).packet.payload.flags, [true, true, false, true, false])
  assert.deepEqual(n.audience.streamInfo.flags, [true, true, false, true, true])
  n.sessions.get(A).closed = true; assert(!n.live.canPublish(A, L))
})

test('invalid UUIDs, conflicting revisions and same id allowlist mutation reject without authority change', async () => {
  const n = await setup()
  for (const extra of [{ allowedPlayerIds: ['bad'] }, { allowedPlayerIds: Array(2049).fill(A) }, { expiresAtMs: 105001 },
    { revision: -1 }, { authorityEpoch: 'other' }, { revision: 1, capabilityId: 'new' }, { revision: 2, allowedPlayerIds: [B] },
    { revision: 1, serverNowMs: 100001, expiresAtMs: 105001 }]) assert.notEqual((await n.live.capability(cap(extra))).code, 0)
  assert(n.live.canPublish(A, L)); assert(!n.live.canPublish(B, L))
  assert.equal((await n.live.capability(cap({ revision: 2, capabilityId: 'new', allowedPlayerIds: [B] }))).code, 0)
  assert(!n.live.canPublish(A, L)); assert(n.live.canPublish(B, L))
})

test('leases expire on monotonic time despite rollback; replay and reconnect require a new lease', async () => {
  const n = await setup()
  n.time.wall -= 10000; n.time.mono = 4999
  assert.equal((await n.live.capability(cap({ serverNowMs: 100001 }))).code, 0)
  n.output.length = 0
  n.time.mono = 5000; await n.live.tick()
  assert(!n.live.canPublish(A, L)); assert.equal(n.live.capabilities.size, 0)
  assert(n.output.filter(row => row.packet.id === 28).every(row => !row.packet.payload.flags[2]))
  assert.notEqual((await n.live.capability(cap())).code, 0)
  await n.live.disconnected(); n.live.connected()
  assert.notEqual((await n.live.capability(cap())).code, 0)
  assert.equal((await n.live.capability(cap({ revision: 2, serverNowMs: 100100, expiresAtMs: 105100 }))).code, 0)
  assert(n.live.canPublish(A, L))
})

test('failed capability ACK output retries do not renew same-revision lease during wall rollback', async () => {
  const n = await setup(), send = n.audience.sendToClient
  n.audience.sendToClient = async () => -1
  const next = cap({ revision: 2, serverNowMs: 100100, expiresAtMs: 105100 })
  assert.notEqual((await n.live.capability(next)).code, 0)
  const deadline = n.live.capabilities.get(L).deadline
  n.time.wall -= 20000; n.time.mono = 4000
  n.audience.sendToClient = send
  assert.equal((await n.live.capability({ ...next, serverNowMs: 104000 })).code, 0)
  assert.equal(n.live.capabilities.get(L).deadline, deadline)
  n.time.mono = deadline; await n.live.tick()
  assert(!n.live.canPublish(A, L))
})

test('epoch mismatch retries until performance ready; disconnect clears ephemeral state without clear10145', async () => {
  const n = await setup()
  assert.notEqual((await n.live.capability(cap({ authorityEpoch: 'next' }))).code, 0)
  await n.authority.state({ authorityEpoch: 'next', revision: 1, levelId: L, serverNowMs: 100000,
    current: null, preparing: null, queue: [], lastEnded: null })
  assert(!n.live.canPublish(A, L))
  assert.equal((await n.live.capability(cap({ authorityEpoch: 'next' }))).code, 0)
  n.output.length = 0; await n.live.disconnected()
  assert(!n.live.canPublish(A, L)); assert.equal(n.live.pending.size, 0); assert.equal(n.live.streams.size, 0)
  assert(n.output.every(row => row.packet.id === 28 && row.packet.payload.flags[2] === false))
})

test('upload preserves bytes, maps timestamp, rotates streams after idle, peer/generation and disconnect', async () => {
  const n = await setup({ skew: 20000 })
  const session = n.sessions.get(A)
  assert(await n.audience.handleSocialBroadcast(session, request({ timestamp: 120.25 })))
  const first = n.upstream.at(-1)
  assert.equal(first.event, 'liveBroadcast.publish'); assert.equal(first.data.timestamp, 100.25)
  assert.equal(first.data.payloadBase64, request().payload.toString('base64'))
  assert(await n.audience.handleSocialBroadcast(session, request()))
  assert.equal(n.upstream.at(-1).data.sourceStreamId, first.data.sourceStreamId)
  assert(!await n.audience.handleSocialBroadcast(n.sessions.get(B), request()))
  assert(!await n.audience.handleSocialBroadcast(session, request({ generation: 2 })))
  assert(!await n.audience.handleSocialBroadcast(session, request({ payload: Buffer.alloc(49153) })))
  n.time.wall += 5001; n.time.mono += 5001
  await n.live.capability(cap({ revision: 2, serverNowMs: 105001, expiresAtMs: 110001 }))
  await n.audience.handleSocialBroadcast(session, request())
  assert.notEqual(n.upstream.at(-1).data.sourceStreamId, first.data.sourceStreamId)
  const previous = n.upstream.at(-1).data.sourceStreamId
  session.player.lvSeq++; await n.audience.handleSocialBroadcast(session, request({ generation: 4 }))
  assert.notEqual(n.upstream.at(-1).data.sourceStreamId, previous)
  const old = session; n.sessions.set(A, { ...old, player: { ...old.player } })
  assert(!await n.audience.handleSocialBroadcast(old, request({ generation: 4 })))
  await n.live.disconnected(); n.live.connected()
  await n.live.capability(cap({ revision: 3, serverNowMs: 105002, expiresAtMs: 110002 }))
  await n.audience.handleSocialBroadcast(n.sessions.get(A), request({ generation: 4 }))
  assert.notEqual(n.upstream.at(-1).data.sourceStreamId, previous)
})

test('formal self never falls through after failed publish, ordinary stream is forgotten', async () => {
  const n = await setup()
  await n.audience.handleSocialBroadcast(n.sessions.get(A), request())
  const first = n.upstream.at(-1).data.sourceStreamId
  const state = { authorityEpoch: 'epoch', revision: 2, levelId: L, serverNowMs: 100000, preparing: null, queue: [], lastEnded: null,
    current: { sessionId: 'formal', performerId: A, startedAtMs: 100000, expiresAtMs: 160000, durationMs: 60000 } }
  await n.authority.state(state)
  n.authority.publishContent = async () => false
  const before = n.upstream.length
  assert(!await n.audience.handleSocialBroadcast(n.sessions.get(A), request())); assert.equal(n.upstream.length, before)
  await n.authority.state({ ...state, revision: 3, current: null })
  await n.audience.handleSocialBroadcast(n.sessions.get(A), request())
  assert.notEqual(n.upstream.at(-1).data.sourceStreamId, first)
})

test('delivery accepts empty receiving allowlist, identity first, opaque bytes and QWD time mapping, no replay', async () => {
  const n = await setup({ allowed: [], skew: 20000 })
  const data = delivery()
  assert.equal((await n.cmd('liveBroadcast.deliver', data)).code, 0)
  assert.equal(content(n).length, 2)
  assert(n.output.findIndex(row => row.packet.id === 23) < n.output.findIndex(row => row.packet.id === 24))
  for (const row of content(n)) {
    assert.equal(row.packet.payload.sessionId, n.audience.performanceIdentity(A))
    assert.equal(row.packet.payload.time, 120.25); assert.equal(row.packet.payload.counter, 0)
    assert.deepEqual(row.packet.payload.json, Buffer.from(data.payloadBase64, 'base64'))
    assert.deepEqual(row.packet.payload.prefix, Buffer.alloc(0))
  }
  assert(n.output.every(row => row.packet.id === 23 || row.packet.id === 24))
  assert.equal((await n.live.deliver(data)).code, 0); await n.live.tick(); assert.equal(content(n).length, 2)
})

test('partial negative/false client sends retain submitted peers and retry remaining only', async () => {
  for (const failed of [-1, false]) {
    const n = await setup(), send = n.audience.sendToClient
    let fail = true
    n.audience.sendToClient = async (id, packet) => id === B && packet.id === 24 && fail ? failed : send(id, packet)
    assert.notEqual((await n.live.deliver(delivery())).code, 0)
    assert.deepEqual(content(n).map(row => row.playerId), [A])
    fail = false; await n.live.tick()
    assert.deepEqual(content(n).map(row => row.playerId), [A], 'local tick cannot replay source content')
    await n.live.deliver(delivery())
    assert.deepEqual(content(n).map(row => row.playerId), [A, B])
    assert.equal((await n.live.deliver(delivery())).code, 0)
    assert.equal(content(n).length, 2)
  }
})

test('missing entity returns pending nonzero then retries up to fixed TTL', async () => {
  const n = await setup({ ids: [B], allowed: [] })
  assert.notEqual((await n.live.deliver(delivery())).code, 0); assert.equal(n.live.pending.size, 1)
  n.audience.applyRemoteSnapshot(L, [{ playerId: A, benchId: 0, seatId: 0, position: [0, 0, 0], levelTime: 100 }])
  await n.live.tick(); assert.equal(content(n).length, 0)
  await n.live.deliver(delivery()); assert.equal(content(n).length, 1)
  const m = await setup({ ids: [B], allowed: [] })
  await m.live.deliver(delivery()); m.time.mono = 3000; m.time.wall -= 10000; await m.live.tick()
  m.audience.applyRemoteSnapshot(L, [{ playerId: A, benchId: 0, seatId: 0, position: [0, 0, 0], levelTime: 100 }])
  await m.live.tick(); assert.equal(content(m).length, 0); assert.notEqual((await m.live.deliver(delivery())).code, 0)
})

test('captured recipients exclude replaced peers and changed generations during awaited identity send', async () => {
  const n = await setup(), send = n.audience.sendToClient
  n.audience.sendToClient = async (id, packet) => {
    if (id === A && packet.id === 23) n.sessions.get(B).player.lvSeq++
    return send(id, packet)
  }
  assert.equal((await n.live.deliver(delivery())).code, 0)
  assert.deepEqual(content(n).map(row => row.playerId), [A])
})

test('source entity disappearing during profile output cannot produce applied ACK', async () => {
  const n = await setup(), send = n.audience.sendToClient
  n.audience.sendToClient = async (id, packet) => { const result = await send(id, packet); if (packet.id === 23) n.audience.barn.forgetPlayer(A); return result }
  assert.notEqual((await n.live.deliver(delivery())).code, 0); assert.equal(content(n).length, 0)
})

test('streams monotonic sequence, retired source streams and bounded pending memory', async () => {
  const n = await setup()
  assert.equal((await n.live.deliver(delivery({ eventSeq: 2 }))).code, 0)
  assert.notEqual((await n.live.deliver(delivery({ eventId: 'late', eventSeq: 1 }))).code, 0)
  assert.equal((await n.live.deliver(delivery({ streamId: 'next', eventId: 'next' }))).code, 0)
  assert.notEqual((await n.live.deliver(delivery({ eventId: 'old', eventSeq: 3 }))).code, 0)
  const m = await setup({ ids: [B] })
  for (let i = 1; i <= 40; i++) await m.live.deliver(delivery({ eventId: `pending-${i}`, eventSeq: i }))
  assert.equal(m.live.pending.size, 32)
})

test('invalid, noncanonical base64, expired and wrong capability deliveries fail closed', async () => {
  const n = await setup()
  for (const extra of [{ payloadBase64: 'YQ' }, { payloadBase64: 'YR==' }, { payloadBase64: 'YQ==\n' },
    { playerId: 'bad' }, { payloadBase64: Buffer.alloc(49153).toString('base64') }, { capabilityId: 'other' },
    { eventSeq: 0 }, { expiresAtMs: 103001 }, { expiresAtMs: 99999 }]) assert.notEqual((await n.live.deliver(delivery(extra))).code, 0)
  assert.equal(content(n).length, 0)
})

test('live control never queues while offline', () => {
  const client = new QwdClient({ room: {}, identity: { id: 'room' }, logger: log })
  for (const event of ['liveBroadcast.sync', 'liveBroadcast.publish']) assert.equal(client.publish(event, {}), false)
  assert.equal(client.queue.length, 0)
})

test('social broadcast prefix roundtrip, empty golden and every truncation strictly rejected', () => {
  const packet = { sessionId: 0x0807060504030201n, prefix: Buffer.from([0, 255, 65]), time: 1.5, counter: 9, json: Buffer.from([0xff, 0, 123, 125]) }
  const writer = new BinaryWriter(); SocialBroadcastDownPacket.encode(writer, packet)
  const wire = writer.toBuffer(), decoded = SocialBroadcastDownPacket.decode(new BinaryReader(wire))
  assert.deepEqual(decoded.prefix, packet.prefix); assert.deepEqual(decoded.json, packet.json)
  assert.equal(decoded.time, 1.5); assert.equal(decoded.counter, 9)
  for (let i = 0; i < wire.length; i++) assert.throws(() => SocialBroadcastDownPacket.decode(new BinaryReader(wire.subarray(0, i))))
  const empty = new BinaryWriter(); SocialBroadcastDownPacket.encode(empty, { sessionId: packet.sessionId, time: 1.5, counter: 9, json: '{}' })
  assert.equal(empty.toBuffer().toString('hex'), '010203040506070800000000000000000000f83f09000000020000007b7d')
  assert.throws(() => SocialBroadcastDownPacket.encode(new BinaryWriter(), { flags: 1 }), /flags/)
  assert.throws(() => SocialBroadcastDownPacket.encode(new BinaryWriter(), { json: '{}', length: 3 }), /length/)
})
