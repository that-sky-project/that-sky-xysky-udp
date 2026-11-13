import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AudienceService } from '../src/features/audience/AudienceService.js'
import { PerformanceAuthority } from '../src/features/audience/PerformanceAuthority.js'
import { AudienceCodec } from '../src/protocol/AudienceCodec.js'
import { AudiencePacketId as IDs, AudienceChatEntityId } from '../src/protocol/types/Audience.js'
import { dispatchQwdCommand } from '../src/runtime/QwdCommands.js'
import { QwdClient } from '../src/qwd/QwdClient.js'

const L = 263580627, H = 1559613961
const A = '79a9c25c-be60-4da5-9f80-ea24c04cd268'
const B = '0d17e2c6-cdbd-40a5-983d-b9deb380dd00'
const C = '7f75f1b5-c3d2-4ed5-9bb7-f13133f08047'
const log = { info () {}, warn () {}, debug () {} }
const initial = () => ({ authorityEpoch: 'epoch-1', levelId: L, revision: 1, serverNowMs: 100000, preparing: null,
  current: { sessionId: 'session-1', performerId: A, startedAtMs: 100000, expiresAtMs: 160000, durationMs: 60000 },
  queue: [], lastEnded: null })

async function node (roomId, ids, { skew = 0 } = {}) {
  const time = { wall: 100000 + skew, mono: 0 }
  const sessions = new Map(), sent = [], upstream = []
  const service = new AudienceService({ logger: log, clock: () => time.wall, barnClock: () => time.wall / 1000,
    currentLevelOf: id => sessions.get(id)?.player.levelId,
    sendToClient: async (playerId, packet) => { sent.push({ playerId, packet }) } })
  let nextId = 0
  const authority = service.performance = new PerformanceAuthority({ audience: service, roomId: () => roomId,
    sessionOf: id => sessions.get(id), levels: () => [...sessions.values()].map(s => s.player.levelId),
    clock: () => time.wall, monotonic: () => time.mono, logger: log, id: () => `${roomId}-${++nextId}`,
    publish: (event, data) => { upstream.push({ event, data }); return true } })
  for (const [index, id] of ids.entries()) {
    const session = { id: `${roomId}-${index}`, closed: false, isActive: () => true,
      player: { uuid: { toString: () => id }, levelId: L, lvSeq: 3 } }
    sessions.set(id, session)
    await service.seatPlayer({ playerId: id, levelId: L, benchId: roomId === 'A' ? 0 : 1, seatId: index,
      position: [index, 0, 0], levelTime: time.wall / 1000 })
  }
  authority.connected(); sent.length = 0
  return { time, sessions, service, authority, sent, upstream,
    cmd: async (cmd, data) => dispatchQwdCommand({ cmd, data }, { audienceService: service, performanceAuthority: authority }) }
}
const response = n => n.sent.filter(s => s.packet.id === IDs.AudienceSpotlightResponse)
const content = n => n.sent.filter(s => s.packet.id === IDs.SocialBroadcastDown)
const info = (n, id) => n.sent.filter(s => s.playerId === id && s.packet.id === IDs.AudienceStreamInfo).at(-1)?.packet.payload
const message = (state, seq, extra = {}) => ({ state, sessionId: state.current.sessionId, playerId: state.current.performerId,
  eventId: `event-${seq}`, eventSeq: seq, timestamp: 123.25, actionId: 7, payloadBase64: Buffer.from('{"x":"原字节"}').toString('base64'), ...extra })

test('decision latency, rejection, offline and FIFO queue never grant locally', async () => {
  const n = await node('A', [A, B, C])
  await n.service.handleSpotlightRequest(n.sessions.get(A), { requested: true, generation: 3 })
  assert.equal(response(n).length, 0); assert.equal(n.service.spotlightPerformers.size, 0)
  const request = n.upstream.at(-1).data
  await n.cmd('performance.decision', { ...request, playerId: A, status: 'rejected', state: { ...initial(), current: null } })
  assert.deepEqual(response(n).at(-1).packet.payload, { valid: false, accepted: false, released: false })
  await n.cmd('performance.state', { ...initial(), revision: 2 })
  for (const id of [B, C]) {
    await n.service.handleSpotlightRequest(n.sessions.get(id), { requested: true, generation: 3 })
    const request = n.upstream.at(-1).data
    const queue = id === B ? [B] : [B, C]
    await n.cmd('performance.decision', { ...request, playerId: id, status: 'queued',
      state: { ...initial(), revision: id === B ? 3 : 4, queue: queue.map(playerId => ({ playerId, enqueuedAtMs: 100000 })) } })
    assert.equal(response(n).at(-1).packet.payload.accepted, true)
  }
  assert.equal(n.authority.current(L).performerId, A)
  assert.equal(info(n, B).stageEnd, 0); assert.equal(info(n, C).stageEnd, 1); assert.equal(info(n, A).stageEnd, 0xffff)
  await n.service.handleSpotlightRequest(n.sessions.get(B), { requested: false, generation: 3 })
  const cancel = n.upstream.at(-1).data
  await n.cmd('performance.decision', { ...cancel, playerId: B, status: 'cancelled', state: { ...initial(), revision: 5,
    queue: [{ playerId: C, enqueuedAtMs: 100000 }] } })
  assert.equal(n.authority.current(L).performerId, A); assert.equal(info(n, C).stageEnd, 0)
  assert.equal(info(n, B).stageEnd, 0xffff); assert.equal(response(n).at(-1).packet.payload.released, true)
  await n.authority.disconnected(); n.sent.length = 0
  await n.service.handleSpotlightRequest(n.sessions.get(A), { requested: true, generation: 3 })
  assert.equal(response(n).at(-1).packet.payload.valid, false)
})

test('deadline is fixed, own +5 seconds, clock skew and wall rollback cannot extend session', async () => {
  for (const skew of [-20000, 20000]) {
    const n = await node('A', [A, B], { skew })
    await n.cmd('performance.state', initial())
    assert.equal(info(n, A).startTime, (160000 + skew + 5000) / 1000)
    assert.equal(info(n, B).startTime, (160000 + skew) / 1000)
    n.time.wall += 10000; n.time.mono += 10000
    await n.cmd('performance.state', initial())
    await n.cmd('performance.state', { ...initial(), revision: 2, serverNowMs: 101000 })
    assert.equal(info(n, B).startTime, (160000 + skew) / 1000)
    await n.authority.disconnected(); n.authority.connected()
    await n.cmd('performance.state', { ...initial(), revision: 3, serverNowMs: 101000 })
    assert.equal(info(n, B).startTime, (160000 + skew) / 1000)
    n.time.wall -= 100000; n.time.mono = 60001
    await n.authority.tick()
    assert.equal(n.authority.current(L), null); assert.equal(info(n, B).hasSession, false)
    const deadline = info(n, B).startTime
    n.time.wall += 50000; await n.service.broadcastFrame(n.time.wall / 1000)
    assert.equal(info(n, B).startTime, deadline, 'idle deadline remains stable')
  }
})

test('fake manager delivers to two rooms including source exactly once, profile first, raw bytes preserved', async () => {
  const a = await node('A', [A]), b = await node('B', [B])
  const state = initial()
  b.service.applyRemoteSnapshot(L, [{ playerId: A, benchId: 0, seatId: 0, position: [0, 0, 0], levelTime: 100 }])
  await a.cmd('performance.state', state); await b.cmd('performance.state', state)
  a.sent.length = 0; b.sent.length = 0
  const payload = Buffer.from('{"ver":1,"payload":"原字节"}')
  await a.service.handleSocialBroadcast(a.sessions.get(A), { timestamp: 123.25, actionId: 7, payload, generation: 3 })
  assert.equal(content(a).length, 0, 'no local shortcut')
  const uploaded = a.upstream.at(-1)
  assert.equal(uploaded.event, 'performance.publish')
  const delivery = { state, ...uploaded.data, playerId: A, eventSeq: 1 }
  for (const n of [a, b]) {
    await n.cmd('performance.deliver', delivery); await n.cmd('performance.deliver', delivery)
    assert.equal(content(n).length, 1)
    assert.deepEqual(content(n)[0].packet.payload.json, payload)
    assert.equal(content(n)[0].packet.payload.counter, 7)
    assert.equal(content(n)[0].packet.payload.time, 123.25)
    assert(n.sent.findIndex(s => s.packet.id === IDs.AudienceReliableData) < n.sent.findIndex(s => s.packet.id === IDs.SocialBroadcastDown))
    const profile = n.sent.find(s => s.packet.id === IDs.AudienceReliableData).packet.payload.entries[0].profile
    assert.equal(profile.f0, n.service.performanceIdentity(A))
  }
  b.service.applyRemoteSnapshot(L, [{ playerId: A, benchId: 0, seatId: 0, position: [0, 0, 0], levelTime: 100, spotlight: false }])
  assert.equal(b.authority.current(L).performerId, A, 'seat diff cannot extinguish authority')
  assert.equal(b.service.barn.getEntityForPlayer(A).type, 0, 'authority never synthesizes an orientation event')
})

test('strict live peer, generation and same-level routing; obsolete snapshot never restores authority', async () => {
  const n = await node('A', [A, B]); await n.cmd('performance.state', initial()); n.sent.length = 0
  for (const generation of [undefined, 2]) await n.service.handleSpotlightRequest(n.sessions.get(A), { requested: true, generation })
  const old = n.sessions.get(A); n.sessions.set(A, { ...old, id: 'replacement' })
  await n.service.handleSpotlightRequest(old, { requested: true, generation: 3 })
  assert.equal(response(n).length, 0)
  n.sessions.get(B).player.levelId = H
  await n.cmd('performance.deliver', message(initial(), 1))
  assert.deepEqual(content(n).map(s => s.playerId), [A])
  await n.cmd('audience.snapshot', { levelId: L, seats: [], spotlightSession: { performerId: B } })
  assert.equal(n.authority.current(L).performerId, A)
})

test('sequence reorder buffers and syncs; gap clears with reliable 10145, then replays in order', async () => {
  const n = await node('A', [A]); await n.cmd('performance.state', initial()); n.sent.length = 0
  await n.cmd('performance.deliver', message(initial(), 2))
  assert.equal(content(n).length, 0)
  await n.cmd('performance.deliver', message(initial(), 1))
  assert.deepEqual(content(n).map(s => s.packet.payload.counter), [7, 7], 'same actionId is not a duplicate event')
  await n.cmd('performance.deliver', message(initial(), 4))
  await n.cmd('performance.gap', { authorityEpoch: 'epoch-1', levelId: L, sessionId: 'session-1', requestedCursor: 2,
    oldestAvailableSeq: 4, latestEventSeq: 4, reason: 'journal_gap' })
  assert.equal(n.authority.cursors.get('session-1'), 4)
  const clear = n.sent.find(s => s.packet.id === IDs.AudienceChatDownReliable).packet
  assert.equal(clear.payload.messages[0].entityId, AudienceChatEntityId.ClearBroadcast)
  // IDA sub_113068C: reliable id26 + entity10145 clears objects; the parser
  // still reads a length-prefixed string, whose content the control ignores.
  const codec = new AudienceCodec(); const wire = codec.encode(clear)
  assert.equal(wire[0], 26); assert(wire.length > 5)
})

test('ended sessions and retired epochs never resurrect; new epoch clears cursors', async () => {
  const n = await node('A', [A]); await n.cmd('performance.state', initial())
  await n.cmd('performance.deliver', message(initial(), 1))
  const ended = { ...initial(), revision: 2, serverNowMs: 110000, current: null, lastEnded: { sessionId: 'session-1', performerId: A,
    endedAtMs: 110000, reason: 'released', revision: 2 } }
  await n.cmd('performance.state', ended); n.sent.length = 0
  await n.cmd('performance.deliver', message(initial(), 2)); assert.equal(content(n).length, 0)
  await n.cmd('performance.state', { ...initial(), authorityEpoch: 'epoch-2', current: { ...initial().current, sessionId: 'session-2' } })
  assert.equal(n.authority.cursors.has('session-1'), false)
  await n.cmd('performance.state', { ...initial(), revision: 999 })
  assert.equal(n.authority.authorityEpoch, 'epoch-2')
})

test('other-level full snapshot cannot delete the current performer or block JSON', async () => {
  const n = await node('B', [B])
  n.service.applyRemoteSnapshot(L, [{ playerId: A, benchId: 0, seatId: 0, position: [0, 0, 0], levelTime: 100 }], { full: true })
  n.service.applyRemoteSnapshot(H, [], { full: true })
  assert(n.service.barn.getEntityForPlayer(A))
  await n.cmd('performance.deliver', message(initial(), 1))
  assert.equal(content(n).length, 1)
})

test('old gap and conflicting state cannot clear a newer session; stale decision rejects its pending request', async () => {
  const n = await node('A', [A, B])
  await n.cmd('performance.state', initial())
  const next = { ...initial(), revision: 2, current: { ...initial().current, sessionId: 'session-2' } }
  await n.cmd('performance.state', next); n.sent.length = 0
  const ack = await n.cmd('performance.gap', { authorityEpoch: 'epoch-1', levelId: L, sessionId: 'session-1', requestedCursor: 0,
    oldestAvailableSeq: 1, latestEventSeq: 3, reason: 'journal_gap' })
  assert.notEqual(ack.code, 0); assert.equal(ack.data.applied, false); assert.equal(n.sent.length, 0)
  await assert.rejects(n.cmd('performance.state', { ...next, current: { ...next.current, performerId: B } }), /conflicting/)
  await n.service.handleSpotlightRequest(n.sessions.get(B), { requested: true, generation: 3 })
  const request = n.upstream.at(-1).data
  await n.cmd('performance.decision', { ...request, playerId: B, status: 'queued', state: initial() })
  assert.equal(response(n).at(-1).packet.payload.valid, false)
})

test('partial viewer send failure retries only viewers not already submitted', async () => {
  const n = await node('A', [A, B]); await n.cmd('performance.state', initial()); n.sent.length = 0
  const output = n.service.sendToClient
  let fail = true
  n.service.sendToClient = async (playerId, packet) => {
    if (playerId === B && packet.id === IDs.SocialBroadcastDown && fail) { fail = false; throw new Error('ENet send refused') }
    return output(playerId, packet)
  }
  await assert.rejects(n.cmd('performance.deliver', message(initial(), 1)), /refused/)
  assert.deepEqual(content(n).map(s => s.playerId), [A])
  await n.cmd('performance.deliver', message(initial(), 1))
  assert.deepEqual(content(n).map(s => s.playerId), [A, B])
  assert.equal(n.authority.cursors.get('session-1'), 1)
})

// Exercise the production callback and ENet adapter without opening sockets.
// sky-enet/src/enet_addon.cpp returns enet_peer_send's status unchanged:
// 0 queues successfully, negative codes fail. A void callback misses this bug.
async function runtimeSender (n, nativeSend) {
  const { EnetServer } = await import('../src/transport/EnetServer.js')
  const { createAudienceSender } = await import('../src/runtime/audiencePorts.js')
  const transport = new EnetServer({ host: '127.0.0.1', port: 0, maxPeers: 64, channels: 1, logger: log })
  let peer = 0n
  for (const session of n.sessions.values()) session.peerId = ++peer
  transport.server = { send: nativeSend }
  const audienceService = { sendToClient: createAudienceSender({
    players: { getByUuid: playerId => {
      const session = n.sessions.get(playerId)
      return session ? { session } : undefined
    } },
    transport, codec: new AudienceCodec(), packetDebug: { log () {} }
  }) }
  n.service.sendToClient = audienceService.sendToClient
  return { transport, audienceService }
}

test('ENet zero success advances cursor and never replays counter zero on each tick', async () => {
  const n = await node('A', [A, B]), sent = []
  const codec = new AudienceCodec()
  await runtimeSender(n, (peerId, channel, wire, reliable) => {
    if (wire[0] === IDs.SocialBroadcastDown) {
      assert.equal(channel, 0); assert.equal(reliable, true)
      sent.push({ peerId, payload: codec.decode(wire[0], wire.subarray(3)).payload })
    }
    return 0
  })
  const first = message(initial(), 1, { actionId: 0, timestamp: 1794461892.8624053,
    payloadBase64: Buffer.from(JSON.stringify({ ver: 1, data: 'x'.repeat(1051) })).toString('base64') })
  const ack = await n.cmd('performance.deliver', first)
  assert.equal(ack.code, 0); assert.equal(ack.data.eventCursor, 1); assert.equal(ack.data.buffered, 0)
  assert.equal(sent.length, 2)
  for (let i = 0; i < 8; i++) { n.time.wall += 100; n.time.mono += 100; await n.authority.tick() }
  await n.cmd('performance.deliver', first)
  assert.equal(sent.length, 2, 'ticks and duplicate manager delivery do not resubmit successful ENet sends')
  await n.cmd('performance.deliver', message(initial(), 2, { actionId: 4 }))
  assert.equal(n.authority.cursors.get('session-1'), 2)
  assert.deepEqual(sent.map(row => row.payload.counter), [0, 0, 4, 4])
})

test('ENet negative result retries only failed viewer and preserves applied cursor', async () => {
  const n = await node('A', [A, B]), attempts = [], sent = []
  let fail = true
  await runtimeSender(n, (peerId, channel, wire) => {
    if (wire[0] !== IDs.SocialBroadcastDown) return 0
    attempts.push(peerId)
    if (peerId === 2n && fail) { fail = false; return -1 }
    sent.push(peerId); return 0
  })
  await assert.rejects(n.cmd('performance.deliver', message(initial(), 1)), /client send rejected/)
  assert.equal(n.authority.cursors.get('session-1'), 0)
  assert.deepEqual(sent, [1n])
  await n.authority.tick()
  assert.equal(n.authority.cursors.get('session-1'), 1)
  assert.deepEqual(attempts, [1n, 2n, 2n])
  assert.deepEqual(sent, [1n, 2n], 'already submitted viewer is not sent twice')
})

test('unstarted ENet and absent runtime sessions are failures, not zero-success aliases', async () => {
  const n = await node('A', [A])
  const runtime = await runtimeSender(n, () => 0)
  runtime.transport.server = null
  assert.equal(runtime.transport.send(1n, Buffer.alloc(0)), -1)
  assert.equal(await runtime.audienceService.sendToClient('missing', { id: IDs.SocialBroadcastDown, payload: {} }), false)
  await assert.rejects(n.cmd('performance.deliver', message(initial(), 1)), /client send rejected/)
  assert.equal(n.authority.cursors.has('session-1'), false, 'failed state projection cannot establish an applied content cursor')
  assert.equal(n.authority.buffers.has('session-1'), false, 'content is not accepted before state output succeeds')
  runtime.transport.server = { send: () => 0 }
  await n.cmd('performance.deliver', message(initial(), 1))
  assert.equal(n.authority.cursors.get('session-1'), 1)
})

test('explicit boolean send rejection still leaves content available for retry', async () => {
  const n = await node('A', [A]), output = n.service.sendToClient
  n.service.sendToClient = async (playerId, packet) => packet.id === IDs.SocialBroadcastDown ? false : output(playerId, packet)
  await assert.rejects(n.cmd('performance.deliver', message(initial(), 1)), /client send rejected/)
  assert.equal(n.authority.cursors.get('session-1'), 0)
  n.service.sendToClient = output
  await n.authority.tick()
  assert.equal(n.authority.cursors.get('session-1'), 1)
  assert.equal(content(n).length, 1)
})

test('missing profile buffers without false cursor; later snapshot drains once', async () => {
  const n = await node('B', [B]); const result = await n.cmd('performance.deliver', message(initial(), 1))
  assert.equal(result.data.eventCursor, 0); assert.equal(result.data.buffered, 1)
  assert.equal(content(n).length, 0)
  n.service.applyRemoteSnapshot(L, [{ playerId: A, benchId: 0, seatId: 0, position: [0, 0, 0], levelTime: 100 }])
  await n.authority.tick(); assert.equal(content(n).length, 1)
  await n.cmd('performance.deliver', message(initial(), 1)); assert.equal(content(n).length, 1)
})

test('packet29 valid/value distinguishes accepted, released and rejected', () => {
  const codec = new AudienceCodec()
  for (const [payload, expected] of [[{ accepted: true }, [true, true]], [{ released: true }, [true, false]], [{ accepted: false }, [false, false]]]) {
    const wire = codec.encode({ id: IDs.AudienceSpotlightResponse, payload })
    const decoded = codec.decode(29, wire.subarray(3)).payload
    assert.deepEqual([decoded.valid, decoded.value], expected)
  }
})

class Socket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  constructor () { super(); this.readyState = 0; this.bufferedAmount = 0; this.sent = []; this.terminated = false; this.listeners = new Map() }
  addEventListener (type, listener) {
    const wrapper = (...args) => listener(type === 'message' ? { type, data: args[0] } : type === 'close' ? { type, code: args[0], reason: args[1]?.toString() } : { type, error: args[0] })
    this.listeners.set(listener, wrapper); this.on(type, wrapper)
  }
  removeEventListener (type, listener) { this.off(type, this.listeners.get(listener)); this.listeners.delete(listener) }
  send (text, callback) { if (this.fail) throw new Error('send failed'); this.sent.push(JSON.parse(text)); callback?.() }
  terminate () { this.terminated = true; this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0)) }
  close () { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)) }
  ping () {}
  open () { this.readyState = 1; this.emit('open') }
}
async function client (onCommand = () => ({ code: 0 })) {
  const { createWebSocketImpl } = await import('../src/qwd/WebSocketAdapter.js')
  const sockets = []
  class NativeSocket extends Socket { constructor (...args) { super(...args); sockets.push(this) } }
  const qwd = new QwdClient({ url: 'ws://fake.invalid', room: {}, identity: { id: 'A' }, logger: log, onCommand,
    websocketImpl: createWebSocketImpl({ WebSocket: NativeSocket, reconnectOptions: { minReconnectionDelay: 1, maxReconnectionDelay: 1 } }) })
  qwd.startLivenessWatch = () => {}
  qwd.start()
  const nextSocket = async count => {
    for (let i = 0; i < 100 && sockets.length < count; i++) await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(sockets.length, count)
    sockets[count - 1].open()
    return sockets[count - 1]
  }
  await nextSocket(1)
  return { qwd, sockets, nextSocket }
}
const command = (socket, id, cmd = 'performance.state', data = {}) => socket.emit('message', Buffer.from(JSON.stringify({ v: 1, id, cmd, data })))

test('connection commands deduplicate, reject collisions, isolate queued old socket and ACK destination', async t => {
  const calls = []; const { qwd, sockets, nextSocket } = await client(c => { calls.push(c.id); return { code: 0 } })
  t.after(() => qwd.stop())
  const rw = qwd.socket
  command(sockets[0], 1); command(sockets[0], 1); await qwd.commandChain
  assert.deepEqual(calls, [1]); assert.equal(sockets[0].sent.filter(s => s.id === 1).length, 2)
  command(sockets[0], 1, 'performance.deliver'); await qwd.commandChain
  assert.notEqual(sockets[0].sent.at(-1).code, 0)
  command(sockets[0], 2); sockets[0].terminate(); await nextSocket(2)
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [1])
  assert.equal(qwd.socket, rw, 'RW instance persists across native reconnects')
  assert(!sockets[1].sent.some(s => s.id === 2))
  command(sockets[1], 1); await qwd.commandChain; assert.deepEqual(calls, [1, 1])
})

test('control sends fail offline/backpressure and ACK send failures close native socket', async t => {
  const { qwd, sockets } = await client(); const socket = sockets[0]
  t.after(() => qwd.stop())
  socket.bufferedAmount = qwd.backpressureLimitBytes
  assert.equal(qwd.publish('performance.request', {}), false); assert.equal(qwd.queue.length, 0)
  socket.bufferedAmount = 0; assert.equal(qwd.publish('performance.sync', {}), true)
  socket.fail = true; assert.equal(qwd.sendAck(5, 0, {}), false); assert.equal(socket.terminated, true)
  assert.equal(qwd.publish('performance.request', {}), false); assert.equal(qwd.queue.length, 0)
})
