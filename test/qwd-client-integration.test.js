import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { QwdClient } from '../src/qwd/QwdClient.js'
import { createWebSocketImpl } from '../src/qwd/WebSocketAdapter.js'

const log = { info () {}, warn () {}, debug () {} }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until (predicate, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (!predicate() && Date.now() < deadline) await delay(5)
  assert(predicate(), `condition did not settle within ${timeout}ms`)
}
async function server (t, options = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options })
  await once(wss, 'listening')
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate()
    await new Promise(resolve => wss.close(resolve))
  })
  return wss
}
function client (t, url, extra = {}) {
  const native = []
  class TrackedWebSocket extends WebSocket {
    constructor (...args) { super(...args); native.push(this) }
  }
  const qwd = new QwdClient({ url, room: Object.freeze({ publicHost: 'public.example', publicPort: 5532 }), identity: { id: '12345678' }, logger: log,
    websocketImpl: createWebSocketImpl({ WebSocket: TrackedWebSocket, reconnectOptions: { minReconnectionDelay: 15, maxReconnectionDelay: 30, minUptime: 100 } }), ...extra })
  t.after(() => qwd.stop())
  return { qwd, native }
}

test('loopback ws proves real ping/pong, server-drop reconnect, full resync, ACK0 and final stop', { timeout: 6000 }, async t => {
  const wss = await server(t)
  const peers = [], paths = [], messages = []
  let pings = 0, connected = 0, dropped = 0
  wss.on('connection', (socket, request) => {
    peers.push(socket); paths.push(request.url)
    socket.on('message', text => messages.push({ peer: socket, data: JSON.parse(text) }))
    socket.on('ping', () => pings++)
  })
  const { qwd, native } = client(t, `ws://127.0.0.1:${wss.address().port}/ignored?token=keep`, {
    onConnected: () => connected++, onTransportDropped: () => dropped++, onCommand: () => ({ code: 0, data: { applied: true } })
  })
  qwd.start(); qwd.start()
  await until(() => connected === 1 && messages.length >= 2)
  assert.equal(native.length, 1)
  assert.match(paths[0], /^\/ignored\?token=keep&v=1&node=/)
  const rw = qwd.socket
  qwd.lastActivityAt = 0
  qwd.transport.ping()
  await until(() => pings === 1 && qwd.lastActivityAt > 0)
  peers[0].send(JSON.stringify({ v: 1, id: 0, cmd: 'room.test', data: {} }))
  await until(() => messages.some(row => row.data.id === 0))
  assert.equal(messages.find(row => row.data.id === 0).data.code, 0)
  const epoch = qwd.connectionEpoch
  peers[0].terminate()
  await until(() => dropped === 1)
  assert.equal(qwd.publish('performance.request', {}), false)
  qwd.publishTelemetry([{ playerId: 'obsolete' }], 10)
  await until(() => connected === 2 && messages.filter(row => row.peer === peers[1]).length >= 2)
  assert.equal(qwd.socket, rw)
  assert(qwd.connectionEpoch > epoch)
  assert.equal(qwd.queue.length, 0)
  assert.deepEqual(messages.filter(row => row.peer === peers[1]).map(row => row.data.event), ['node.ready', 'room.created'])
  const closed = once(native[1], 'close')
  const stopping = qwd.stop()
  assert.equal(qwd.stop(), stopping)
  await stopping; await closed
  assert.equal(native[1].listenerCount('pong'), 0)
  assert.equal(native[1].listenerCount('ping'), 0)
  await delay(120)
  assert.equal(peers.length, 2)
  assert.equal(qwd.socket, null)
  assert.equal(qwd.livenessTimer, null)
})

test('loopback stalled manager is hard-terminated and RW retries without graceful-close hang', { timeout: 6000 }, async t => {
  const wss = await server(t, { autoPong: false })
  const peers = []
  let pings = 0, connections = 0
  wss.on('connection', socket => { peers.push(socket); socket.on('ping', () => pings++) })
  const { qwd, native } = client(t, `ws://127.0.0.1:${wss.address().port}`, { onConnected: () => connections++ })
  qwd.start(); await until(() => connections === 1)
  qwd.transport.ping(); await until(() => pings === 1)
  const oldActivity = qwd.lastActivityAt
  await delay(20)
  assert.equal(qwd.lastActivityAt, oldActivity, 'server with autoPong false cannot fabricate liveness')
  // Keep actual IO and native sockets; advance only the periodic heartbeat.
  qwd.stopLivenessWatch()
  t.mock.timers.enable({ apis: ['setInterval'] })
  qwd.startLivenessWatch('loopback')
  qwd.lastActivityAt = Date.now() - 20_001
  t.mock.timers.tick(5000)
  assert.equal(qwd.connected, false)
  await until(() => native[0].readyState === WebSocket.CLOSED && connections === 2)
  assert.equal(native.length, 2)
  await qwd.stop()
  await delay(100)
  assert.equal(peers.length, 2)
})

test('loopback payloads above 512KiB disconnect and resync on a new native socket', { timeout: 6000 }, async t => {
  const wss = await server(t)
  const peers = []
  let connections = 0, drops = 0, commands = 0
  wss.on('connection', socket => {
    peers.push(socket)
    socket.on('error', () => {})
  })
  const { qwd, native } = client(t, `ws://127.0.0.1:${wss.address().port}`, {
    onConnected: () => connections++, onTransportDropped: () => drops++, onCommand: () => { commands++; return { code: 0 } }
  })
  qwd.start(); await until(() => connections === 1)
  peers[0].send('x'.repeat(512 * 1024 + 1))
  await until(() => drops >= 1 && connections === 2)
  assert.equal(native[0].readyState, WebSocket.CLOSED)
  assert.equal(commands, 0)
  assert.equal(native.length, 2)
  await qwd.stop()
})

test('loopback RW handshake timeout terminates stalled native upgrade and stop cancels retry', { timeout: 6000 }, async t => {
  const sockets = new Set(), native = []
  const server = http.createServer()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', () => {})
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  class TrackedWebSocket extends WebSocket {
    constructor (...args) { super(...args); native.push(this) }
  }
  let drops = 0
  const qwd = new QwdClient({ url: `ws://127.0.0.1:${server.address().port}`, room: {}, identity: { id: '12345678' }, logger: log,
    onTransportDropped: () => drops++,
    websocketImpl: createWebSocketImpl({ WebSocket: TrackedWebSocket, reconnectOptions: { connectionTimeout: 40, minReconnectionDelay: 100, maxReconnectionDelay: 100 } }) })
  t.after(() => qwd.stop())
  qwd.start()
  await until(() => drops === 1 && native[0]?.readyState === WebSocket.CLOSED)
  await qwd.stop()
  await delay(180)
  assert.equal(native.length, 1)
  assert.equal(qwd.connected, false)
})
