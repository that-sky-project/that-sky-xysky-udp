import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { QwdClient } from '../src/qwd/QwdClient.js'
import { createWebSocketImpl } from '../src/qwd/WebSocketAdapter.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = { info () {}, warn () {}, debug () {} }
async function until (predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await delay(2)
  }
  assert(predicate(), 'condition did not settle within 400ms')
}

// A ws-compatible native constructor: browser EventTarget interface for RW,
// explicit native event/callback/ping/terminate capabilities for the adapter.
class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  constructor (url, protocols, options) {
    super()
    this.url = url
    this.protocols = protocols
    this.options = options
    this.readyState = 0
    this.bufferedAmount = 0
    this.sent = []
    this.browserListeners = new Map()
    this.pings = 0
    this.terminated = false
  }
  addEventListener (type, listener) {
    const wrapper = (...args) => {
      const event = new Event(type)
      if (type === 'message') event.data = args[0]
      if (type === 'close') { event.code = args[0]; event.reason = args[1] }
      if (type === 'error') { event.error = args[0]; event.message = args[0].message }
      listener(event)
    }
    this.browserListeners.set(listener, wrapper)
    this.on(type, wrapper)
  }
  removeEventListener (type, listener) {
    const wrapper = this.browserListeners.get(listener)
    if (wrapper) this.off(type, wrapper)
    this.browserListeners.delete(listener)
  }
  open () { this.readyState = 1; this.emit('open') }
  message (data) { this.emit('message', Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))) }
  send (text, callback) {
    if (this.throwSend) throw new Error('native send throw')
    this.sent.push(JSON.parse(text))
    if (this.asyncSend) this.pendingCallback = callback
    else callback?.(this.sendError)
  }
  ping () { this.pings++ }
  close () { this.readyState = 2; if (!this.hangClose) this.finishClose(1000) }
  finishClose (code = 1006) { this.readyState = 3; this.emit('close', code, '') }
  terminate () { this.terminated = true; this.finishClose() }
}
function fixture (t, extra = {}) {
  const sockets = []
  class Native extends FakeWebSocket {
    constructor (...args) { super(...args); sockets.push(this) }
  }
  const qwd = new QwdClient({ url: 'ws://fake.invalid/old/path?token=x&v=9', room: Object.freeze({ publicHost: 'public.example', publicPort: 1234, maxPeers: 10 }),
    identity: { id: '12345678' }, logger: log,
    websocketImpl: createWebSocketImpl({ WebSocket: Native, reconnectOptions: { minReconnectionDelay: 1, maxReconnectionDelay: 2, minUptime: 1000 } }),
    ...extra })
  t.after(() => qwd.stop())
  const open = async (count = 1) => { await until(() => sockets.length >= count); sockets[count - 1].open(); return sockets[count - 1] }
  return { qwd, sockets, open }
}
const cmd = (socket, id, data = {}, command = 'room.test') => socket.message({ v: 1, id, cmd: command, data })

test('real RW owns reconnects, preserves endpoint policy, resyncs and disables its buffering', async t => {
  let connections = 0, drops = 0
  const { qwd, sockets, open } = fixture(t, { onConnected: () => connections++, onTransportDropped: () => drops++, snapshot: () => ({ capacity: 10, players: 3, version: 2 }) })
  qwd.publishTelemetry([{ playerId: 'old' }], 1)
  qwd.start(); qwd.start()
  const socket = await open()
  assert.equal(sockets.length, 1)
  const endpoint = new URL(socket.url)
  assert.equal(endpoint.pathname, '/old/path')
  assert.equal(endpoint.searchParams.get('v'), '1')
  assert.equal(endpoint.searchParams.get('token'), 'x')
  assert.equal(endpoint.searchParams.get('node'), qwd.nodeId)
  assert.deepEqual(socket.options, { handshakeTimeout: 10_000, maxPayload: 512 * 1024 })
  assert.equal(qwd.queue.length, 0)
  assert.deepEqual(socket.sent.map(m => m.event), ['node.ready', 'room.created'])
  assert.equal(socket.sent[1].data.roomId, '12345678')
  assert.equal(socket.sent[1].data.port, 1234)
  assert.deepEqual(qwd.occupancy(), { capacity: 10, physicalPlayers: 3, activePlayers: 3, reservedSlots: 0, version: 2, load: 0.3 })
  const rw = qwd.socket, epoch = qwd.connectionEpoch
  socket.terminate()
  qwd.socket.send('must-not-be-buffered')
  qwd.publishTelemetry([], 2)
  const next = await open(2)
  assert.equal(qwd.socket, rw)
  assert(qwd.connectionEpoch >= epoch + 3, 'close, new native attempt and open invalidate command epochs')
  assert.equal(connections, 2); assert.equal(drops, 1)
  assert.deepEqual(next.sent.map(m => m.event), ['node.ready', 'room.created'])
  assert.equal(qwd.queue.length, 0)
})

test('offline structured telemetry coalesces, snapshots caller data and queue overflow logs', t => {
  const warnings = []
  const { qwd } = fixture(t, { logger: { ...log, warn: (...args) => warnings.push(args) } })
  const players = [{ playerId: 'first' }]
  assert.equal(qwd.publishTelemetry(players, 1), true)
  players[0].playerId = 'mutated'
  assert.equal(qwd.queue[0].data.players[0].playerId, 'first')
  qwd.publishTelemetry([{ playerId: 'second' }], 2, { kind: 'delta', baseSeq: 1, removedPlayers: ['first'] })
  assert.equal(qwd.queue.length, 1)
  assert.equal(qwd.queue[0].event, 'room.telemetry')
  assert.equal(qwd.queue[0].data.seq, 2)
  assert.equal(qwd.queue[0].data.kind, 'delta')
  for (let i = 0; i < 255; i++) assert.equal(qwd.publish('room.test', { i }), true)
  assert.equal(qwd.publish('room.overflow', {}), false)
  assert.equal(qwd.queue.length, 256)
  assert.equal(qwd.droppedFrames, 1)
  assert(warnings.some(([, message]) => message.includes('queue full')))
  qwd.publishTelemetry([], 3)
  assert.equal(qwd.queue.length, 256)
  assert.equal(qwd.queue[0].data.seq, 3)
})

test('runtime solely writes conflict identity, updated identity drives telemetry, logging and announcement', async t => {
  let writes = 0, value = '12345678'
  const identity = { get id () { return value }, set id (id) { writes++; value = id } }
  const warnings = [], conflicts = []
  const { qwd, open } = fixture(t, { identity, logger: { ...log, warn: (...args) => warnings.push(args) },
    onRoomIdConflict: (newId, previousId) => { conflicts.push([newId, previousId]); identity.id = newId } })
  qwd.start(); const socket = await open()
  cmd(socket, 0, {}, 'room.id_conflict'); await qwd.commandChain
  assert.equal(conflicts.length, 1); assert.equal(writes, 1)
  assert.match(value, /^\d{8}$/)
  assert.equal(conflicts[0][1], '12345678')
  assert.equal(socket.sent.at(-1).id, 0, 'id zero is a valid command, not an implicit notification')
  assert.equal(socket.sent.at(-2).data.roomId, identity.id)
  assert.equal(warnings.at(-1)[0].roomId, identity.id)
  cmd(socket, 0, {}, 'room.id_conflict'); await qwd.commandChain
  assert.equal(writes, 1, 'duplicate conflict does not regenerate twice')
  qwd.publishTelemetry([], 2)
  assert.equal(socket.sent.at(-1).data.roomId, identity.id)
})

test('client cannot mutate a readonly identity even during conflicts', async t => {
  const identity = Object.freeze({ id: '87654321' })
  const { qwd, open } = fixture(t, { identity, onRoomIdConflict: () => {} })
  qwd.start(); const socket = await open()
  cmd(socket, 1, {}, 'room.id_conflict'); await qwd.commandChain
  assert.equal(identity.id, '87654321')
  assert.equal(socket.sent.at(-1).code, 0)
  assert.equal(socket.sent.at(-2).data.roomId, '87654321')
})

test('valid id zero ACKs, duplicates cache, collisions reject and invalid envelopes never dispatch', async t => {
  const calls = [], warnings = []
  const { qwd, open } = fixture(t, { onCommand: command => { calls.push(command.id); return { code: 0, data: { applied: true } } },
    logger: { ...log, warn: (...args) => warnings.push(args) } })
  qwd.start(); const socket = await open()
  cmd(socket, 0); cmd(socket, 0); await qwd.commandChain
  assert.deepEqual(calls, [0])
  assert.equal(socket.sent.filter(m => m.id === 0).length, 2)
  cmd(socket, 0, { different: true }); await qwd.commandChain
  assert.notEqual(socket.sent.at(-1).code, 0)
  for (const id of [-1, 1.2, '1', null, Number.MAX_SAFE_INTEGER + 1]) cmd(socket, id)
  for (const data of [null, [], 'x']) cmd(socket, 1, data)
  socket.message({ v: 2, id: 1, cmd: 'room.test', data: {} })
  socket.message({ v: 1, id: 1, cmd: 42, data: {} })
  socket.message('{bad json')
  await qwd.commandChain
  assert.deepEqual(calls, [0])
  assert(warnings.length >= 11)
})

test('stale async completion and queued old commands cannot ACK/cache after same-RW reconnect', async t => {
  let resolveOld
  const calls = []
  const { qwd, open } = fixture(t, { onCommand: command => {
    calls.push(command.id)
    if (command.id === 1 && calls.length === 1) return new Promise(resolve => { resolveOld = resolve })
    return { code: 0 }
  } })
  qwd.start(); const socket = await open()
  cmd(socket, 1); cmd(socket, 2)
  const oldChain = qwd.commandChain
  await until(() => resolveOld)
  socket.terminate(); const next = await open(2)
  cmd(next, 1); await qwd.commandChain
  resolveOld({ code: 999 }); await oldChain
  assert.deepEqual(calls, [1, 1])
  assert.equal(socket.sent.filter(m => m.id === 1).length, 0)
  assert.deepEqual(next.sent.filter(m => m.id !== undefined), [{ v: 1, id: 1, code: 0 }])
  assert.equal(qwd.commandResults.get(1).code, 0)
  assert.equal(qwd.queuedCommands, 0)
})

test('256 command queue and 512 result cache bounds hold and reset per epoch', async t => {
  let release
  const calls = []
  const { qwd, open } = fixture(t, { onCommand: command => {
    calls.push(command.id)
    if (command.id === 1) return new Promise(resolve => { release = resolve })
    return { code: 0 }
  } })
  qwd.start(); const socket = await open()
  cmd(socket, 1); await until(() => release)
  for (let id = 2; id <= 257; id++) cmd(socket, id)
  assert.equal(qwd.queuedCommands, 256)
  assert.notEqual(socket.sent.find(m => m.id === 257).code, 0)
  release({ code: 0 }); await qwd.commandChain
  assert.equal(calls.length, 256)
  for (let id = 258; id <= 850; id++) { cmd(socket, id); await qwd.commandChain }
  assert.equal(qwd.commandResults.size, 512)
  assert(!qwd.commandResults.has(1))
  socket.terminate(); await open(2)
  assert.equal(qwd.commandResults.size, 0)
  assert.equal(qwd.queuedCommands, 0)
})

test('native send throw and synchronous callback errors return false and hard terminate', async t => {
  for (const kind of ['throwSend', 'sendError']) {
    const { qwd, open } = fixture(t)
    qwd.start(); const socket = await open()
    socket[kind] = kind === 'sendError' ? new Error('callback failure') : true
    socket.hangClose = true
    assert.equal(qwd.publish('player.join', {}), false)
    assert.equal(socket.terminated, true)
    assert.equal(qwd.connected, false)
    qwd.stop()
  }
})

test('async native callback failure drops epoch, late callbacks cannot kill replacement', async t => {
  const { qwd, open } = fixture(t)
  qwd.start(); const socket = await open()
  socket.asyncSend = true
  assert.equal(qwd.publish('player.join', {}), true)
  const lateCallback = socket.pendingCallback
  lateCallback(new Error('late send failed'))
  assert(socket.terminated)
  const next = await open(2)
  lateCallback(new Error('old error'))
  assert.equal(qwd.connected, true)
  assert.equal(next.terminated, false)
})

test('native rejection and byte-based backpressure preserve false result, ACK pressure terminates', async t => {
  const { qwd, open } = fixture(t)
  qwd.start(); const socket = await open()
  const messageBytes = Buffer.byteLength(JSON.stringify({ v: 1, event: 'player.join', data: { text: '原' } }))
  socket.bufferedAmount = qwd.backpressureLimitBytes - messageBytes
  assert.equal(qwd.publish('player.join', { text: '原' }), true)
  socket.bufferedAmount++
  assert.equal(qwd.publish('player.join', { text: '原' }), false)
  assert.equal(qwd.queue.length, 0)
  socket.bufferedAmount = qwd.backpressureLimitBytes
  assert.equal(qwd.sendAck(0, 0, {}), false)
  assert(socket.terminated)
  const next = await open(2)
  next.readyState = 3
  // A race in native state is a rejection, never a successful RW enqueue.
  assert.equal(qwd.transport.send('x', () => {}), false)
})

test('5s native heartbeat accepts ping/pong activity and 20s silence hard terminates a hanging close', async t => {
  const { qwd, open } = fixture(t)
  qwd.start(); const socket = await open()
  qwd.stopLivenessWatch()
  t.mock.timers.enable({ apis: ['setInterval'] })
  qwd.startLivenessWatch('fake')
  t.mock.timers.tick(5000)
  assert.equal(socket.pings, 1)
  qwd.lastActivityAt = Date.now() - 30_000
  socket.emit('pong')
  assert(Date.now() - qwd.lastActivityAt < 100)
  qwd.lastActivityAt = Date.now() - 30_000
  socket.emit('ping')
  assert(Date.now() - qwd.lastActivityAt < 100)
  socket.hangClose = true
  qwd.lastActivityAt = Date.now() - 20_001
  t.mock.timers.tick(5000)
  assert(socket.terminated)
  assert.equal(qwd.livenessTimer, null)
  qwd.stop()
})

test('stop before async first attempt, during retry and after open leaks no sockets or heartbeat listeners', async t => {
  const first = fixture(t)
  first.qwd.start(); first.qwd.stop(); first.qwd.stop()
  await delay(20)
  assert.equal(first.sockets.length, 0)
  const { qwd, sockets, open } = fixture(t)
  qwd.start(); const socket = await open()
  assert.equal(socket.listenerCount('pong'), 1)
  socket.hangClose = true
  qwd.stop(); qwd.stop()
  assert(socket.terminated)
  assert.equal(socket.listenerCount('pong'), 0)
  assert.equal(socket.listenerCount('ping'), 0)
  assert.equal(qwd.socket, null); assert.equal(qwd.livenessTimer, null)
  await delay(20); assert.equal(sockets.length, 1)
  qwd.start(); await open(2)
  sockets[1].terminate(); qwd.stop()
  await delay(20); assert.equal(sockets.length, 2)
})

test('stop invalidates pending commands without ACK after completion', async t => {
  let release
  const { qwd, open } = fixture(t, { onCommand: () => new Promise(resolve => { release = resolve }) })
  qwd.start(); const socket = await open()
  cmd(socket, 1); const chain = qwd.commandChain
  await until(() => release)
  const stopping = qwd.stop()
  assert.equal(qwd.stop(), stopping)
  let drained = false
  stopping.then(() => { drained = true })
  await delay(2)
  assert.equal(drained, false, 'shutdown waits for in-flight callback')
  release({ code: 0 }); await chain; await stopping
  assert.equal(drained, true)
  assert(!socket.sent.some(m => m.id === 1))
  assert.equal(qwd.commandResults.size, 0)
  assert.equal(qwd.queuedCommands, 0)
})

test('stop drains retired-epoch callbacks too and blocks restart until draining finishes', async t => {
  let release
  const { qwd, open, sockets } = fixture(t, { onCommand: () => new Promise(resolve => { release = resolve }) })
  qwd.start(); const socket = await open()
  cmd(socket, 1); await until(() => release)
  socket.terminate(); await open(2)
  assert.equal(qwd.queuedCommands, 0)
  const stopping = qwd.stop()
  let drained = false
  stopping.then(() => { drained = true })
  qwd.start()
  await delay(20)
  assert.equal(drained, false)
  assert.equal(sockets.length, 2)
  release({ code: 0 }); await stopping
  assert.equal(qwd.pendingCommandTasks.size, 0)
  qwd.start(); await open(3)
  assert.equal(qwd.connected, true)
})

// Generic QWD transport regressions retained from the removed feature suite.
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
const command = (socket, id, cmd = 'room.reserve', data = {}) => socket.emit('message', Buffer.from(JSON.stringify({ v: 1, id, cmd, data })))

test('connection commands deduplicate, reject collisions, isolate queued old socket and ACK destination', async t => {
  const calls = []; const { qwd, sockets, nextSocket } = await client(c => { calls.push(c.id); return { code: 0 } })
  t.after(() => qwd.stop())
  const rw = qwd.socket
  command(sockets[0], 1); command(sockets[0], 1); await qwd.commandChain
  assert.deepEqual(calls, [1]); assert.equal(sockets[0].sent.filter(s => s.id === 1).length, 2)
  command(sockets[0], 1, 'move.cancel'); await qwd.commandChain
  assert.notEqual(sockets[0].sent.at(-1).code, 0)
  command(sockets[0], 2); sockets[0].terminate(); await nextSocket(2)
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [1])
  assert.equal(qwd.socket, rw, 'RW instance persists across native reconnects')
  assert(!sockets[1].sent.some(s => s.id === 2))
  command(sockets[1], 1); await qwd.commandChain; assert.deepEqual(calls, [1, 1])
})

test('extracted transport backpressure and ACK send failures close native socket; ordinary events queue offline', async t => {
  const { qwd, sockets } = await client(); const socket = sockets[0]
  t.after(() => qwd.stop())
  socket.bufferedAmount = qwd.backpressureLimitBytes
  assert.equal(qwd.publish('player.join', {}), false); assert.equal(qwd.queue.length, 0)
  socket.bufferedAmount = 0; assert.equal(qwd.publish('room.telemetry', {}), true)
  socket.fail = true; assert.equal(qwd.sendAck(5, 0, {}), false); assert.equal(socket.terminated, true)
  assert.equal(qwd.publish('player.join', {}), true); assert.equal(qwd.queue.length, 1)
})
