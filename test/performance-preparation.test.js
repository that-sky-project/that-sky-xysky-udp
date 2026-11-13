import test from 'node:test'
import assert from 'node:assert/strict'
import { AudienceService } from '../src/features/audience/AudienceService.js'
import { PerformanceAuthority, validPerformanceState } from '../src/features/audience/PerformanceAuthority.js'
import { AudienceCodec } from '../src/protocol/AudienceCodec.js'
import { BinaryReader } from '../src/protocol/binary/BinaryReader.js'
import { AudienceStreamInfoPacket } from '../src/protocol/packets/server/AudiencePackets.js'
import { identityHashOfPlayerId } from '../src/protocol/identityHash.js'
import { dispatchQwdCommand } from '../src/runtime/QwdCommands.js'

const L = 263580627
const A = 'ef20bad5-b52a-4e8f-9c7c-7537d9941d08'
const B = '0d17e2c6-cdbd-40a5-983d-b9deb380dd00'
const C = '7f75f1b5-c3d2-4ed5-9bb7-f13133f08047'
const logger = { info () {}, warn () {}, debug () {} }
const prep = () => ({ authorityEpoch: 'epoch', levelId: L, revision: 1, serverNowMs: 100000,
  preparing: { preparationId: 'prep-1', performerId: A, startedAtMs: 100000, expiresAtMs: 115000, durationMs: 15000 },
  current: null, queue: [A, B].map(playerId => ({ playerId, enqueuedAtMs: 100000 })), lastEnded: null })
const running = () => ({ ...prep(), revision: 2, serverNowMs: 115000, preparing: null,
  current: { sessionId: 'show-1', performerId: A, startedAtMs: 115000, expiresAtMs: 175000, durationMs: 60000 },
  queue: [{ playerId: B, enqueuedAtMs: 100000 }] })
function nativeState (p, playerId = A) {
  if (!p.hasDetail) return 0
  if (p.hasSession) return p.sessionId === identityHashOfPlayerId(playerId) ? 3 : 5
  return p.stageEnd === 0 ? 2 : p.stage < 1 ? 1 : 4
}
async function fixture (skew = 0) {
  const time = { wall: 100000 + skew, mono: 0 }, sessions = new Map(), sent = [], upstream = []
  const codec = new AudienceCodec()
  const audience = new AudienceService({ logger, clock: () => time.wall, barnClock: () => time.wall / 1000,
    currentLevelOf: id => sessions.get(id)?.player.levelId,
    sendToClient: (playerId, packet) => {
      const wire = codec.encode(packet)
      assert.equal(wire.readUInt16LE(1), wire.length - 3)
      sent.push({ playerId, id: packet.id, payload: codec.decode(packet.id, wire.subarray(3)).payload })
      return 0
    } })
  for (const [i, playerId] of [A, B, C].entries()) {
    const session = { player: { uuid: { toString: () => playerId }, levelId: L, lvSeq: 1 }, isActive: () => true, closed: false }
    sessions.set(playerId, session)
    await audience.seatPlayer({ playerId, levelId: L, benchId: 0, seatId: i, position: [i, 71, 0], levelTime: time.wall / 1000 })
  }
  const authority = audience.performance = new PerformanceAuthority({ audience, logger, clock: () => time.wall, monotonic: () => time.mono,
    roomId: () => 'room', sessionOf: id => sessions.get(id), levels: () => [L], publish: (event, data) => { upstream.push({ event, data }); return true } })
  authority.connected(); sent.length = 0
  return { audience, authority, sessions, time, sent, upstream,
    cmd: (name, data) => dispatchQwdCommand({ cmd: name, data }, { audienceService: audience, performanceAuthority: authority }),
    info: (playerId = A) => sent.filter(r => r.id === 28 && r.playerId === playerId).at(-1)?.payload }
}

test('preparation immediately acknowledges admission, exposes native state2, and refuses content', async () => {
  const f = await fixture()
  await f.authority.request(f.sessions.get(A), true, 1)
  const request = f.upstream.at(-1).data
  const ack = await f.cmd('performance.decision', { ...request, playerId: A, status: 'queued', state: prep() })
  assert.equal(ack.code, 0)
  assert.equal(f.authority.current(L), null)
  assert.equal(f.authority.pending.size, 0, 'admission ACK does not wait for preparation to finish')
  assert.equal(nativeState(f.info()), 2); assert.equal(f.info().startTime, 115)
  assert.equal(f.info(B).stageEnd, 1); assert.equal(f.info(C).stageEnd, 65535)
  assert.equal(f.sent.find(r => r.id === 29).payload.accepted, true)
  assert.equal(await f.authority.publishContent(f.sessions.get(A), { timestamp: 100, actionId: 0, payload: Buffer.from('{}') }, 1), false)
  assert.equal(f.upstream.filter(r => r.event === 'performance.publish').length, 0)
  assert.equal(f.audience.barn.getEntityForPlayer(A).type, 0)
})

test('fixed preparation mapping survives revisions and reconnect; node never promotes itself', async () => {
  for (const skew of [-20000, 20000]) {
    const f = await fixture(skew)
    await f.cmd('performance.state', prep())
    const deadline = f.info().startTime
    f.time.wall += 5000; f.time.mono += 5000
    await f.cmd('performance.state', { ...prep(), revision: 2, serverNowMs: 105000 })
    await f.authority.disconnected(); f.authority.connected()
    await f.cmd('performance.state', { ...prep(), revision: 3, serverNowMs: 105000 })
    assert.equal(f.info().startTime, deadline)
    f.time.wall += 10000; f.time.mono += 10000
    await f.authority.tick(); await f.audience.broadcastFrame(f.time.wall / 1000)
    assert.equal(nativeState(f.info()), 2); assert.equal(f.authority.current(L), null)
    assert.equal(f.info().startTime, deadline, 'waiting for authority does not restart countdown')
    f.time.wall -= 30000
    await f.audience.broadcastFrame((f.time.wall + 30001) / 1000)
    assert(f.info().startTime <= f.time.wall / 1000, 'wall rollback cannot revive finished countdown')
  }
})

test('preparation to running keeps native local phase continuous with self-only deadline compensation', async () => {
  const f = await fixture(); await f.cmd('performance.state', prep())
  f.time.wall = 115000; f.time.mono = 15000; f.sent.length = 0
  await f.cmd('performance.state', running())
  assert.deepEqual(f.sent.filter(r => r.playerId === A && r.id === 28).map(r => nativeState(r.payload)), [3])
  assert.equal(f.sent.filter(r => r.id === 26 || r.id === 29).length, 0, 'no false leave or unsolicited request ACK')
  assert.equal(f.info().startTime, 180); assert.equal(f.info(B).startTime, 175)
  assert.equal(f.authority.current(L).expiresAtMs, 175000)
  await f.audience.preparePerformance(L, A)
  const profile = f.sent.filter(r => r.id === 23).flatMap(r => r.payload.entries).find(e => e.profile.f0 === identityHashOfPlayerId(A))
  assert.equal(profile.profile.f68, 0)
  const entity = f.audience.barn.getEntityForPlayer(A)
  assert.equal(entity.type, 0); assert.equal(entity.extra, null); assert.equal(entity.stageState, undefined)
})

test('preparation replacement releases old native state2 and cancelled head request carries exact identity', async () => {
  const f = await fixture(); await f.cmd('performance.state', prep())
  await f.authority.request(f.sessions.get(A), false, 1)
  assert.equal(f.upstream.at(-1).data.expectedPreparationId, 'prep-1')
  f.sent.length = 0; f.time.wall += 3000; f.time.mono += 3000
  const replacement = { ...prep(), revision: 2, serverNowMs: 103000, queue: [{ playerId: B, enqueuedAtMs: 100000 }],
    preparing: { preparationId: 'prep-2', performerId: B, startedAtMs: 103000, expiresAtMs: 118000, durationMs: 15000 } }
  await f.cmd('performance.state', replacement)
  assert.equal(nativeState(f.info(A)), 4); assert.equal(nativeState(f.info(B), B), 2)
  assert.equal(f.info(B).startTime, 118)
  assert.equal(f.sent.filter(r => r.id === 29).length, 0)
  const oldAck = await f.cmd('performance.state', prep()); assert.notEqual(oldAck.code, 0)
  assert.equal(f.authority.preparing(L).preparationId, 'prep-2')
})

test('phase validation rejects missing preparation, ambiguous ownership and mutable identities', async () => {
  for (const state of [{ ...prep(), preparing: undefined }, { ...prep(), current: running().current },
    { ...prep(), queue: [] }, { ...prep(), preparing: { ...prep().preparing, durationMs: 1 } },
    { ...prep(), queue: [prep().queue[0], prep().queue[0]] }]) assert.equal(validPerformanceState(state), false)
  const f = await fixture(); await f.cmd('performance.state', prep())
  await assert.rejects(f.cmd('performance.state', { ...prep(), revision: 2,
    preparing: { ...prep().preparing, expiresAtMs: 116000, durationMs: 16000 } }), /conflicting/)
  assert.equal(f.authority.preparing(L).expiresAtMs, 115000)
})

test('local formal expiry and state retries cannot manufacture preparation for queued spectators', async () => {
  const f = await fixture(); f.time.wall = 115000; f.time.mono = 15000
  await f.cmd('performance.state', running())
  f.time.wall = 175000; f.time.mono = 75000
  await f.authority.tick()
  await f.cmd('performance.state', { ...running(), serverNowMs: 175000 })
  assert.equal(f.authority.current(L), null); assert.equal(f.authority.preparing(L), null)
  assert.equal(nativeState(f.info(B), B), 4); assert.equal(f.info(B).stageEnd, 65535)
})

test('failed phase output never ACKs applied and command retry projects the same immutable deadline', async () => {
  const f = await fixture(), send = f.audience.sendToClient
  let rejected = true
  f.audience.sendToClient = (id, packet) => packet.id === 28 && id === B && rejected ? -1 : send(id, packet)
  await assert.rejects(f.cmd('performance.state', prep()), /client send rejected/)
  const first = f.info(A).startTime
  rejected = false
  const ack = await f.cmd('performance.state', prep())
  assert.equal(ack.code, 0); assert.equal(ack.data.applied, true)
  assert.equal(f.info(A).startTime, first); assert.equal(f.info(B).stageEnd, 1)
})

// A minimal native state/event model, not a real renderer or scene/lift simulation.
class NativePhase {
  state = 4; timer = 0; seated = false; events = []
  update (state, dt) {
    if (state === 2 || state === 3) {
      if (!this.seated) {
        if (this.timer > 2.5) { this.seated = true; this.events.push('Sit') }
        this.timer += dt
      }
    }
    if (state !== this.state) {
      if (state === 2) this.events.push('warmup')
      else if (state === 3) this.events.push('broadcast')
      else if (this.state === 2 || this.state === 3) { this.timer = 0; this.seated = false; this.events.push('leave') }
    }
    this.state = state
  }
}
test('official warmup and self stream goldens drive countdown then broadcast without a second Sit', () => {
  const read = hex => {
    const r = new BinaryReader(Buffer.from(hex, 'hex')), p = AudienceStreamInfoPacket.decode(r)
    assert(r.remainingBits < 8); while (r.remainingBits) assert.equal(r.readBits(1), 0)
    return p
  }
  // seq107909 (next), seq109684 (self). Warm-up wire is independently built
  // from verified full-flow fields below and checked against its state contract.
  const next = read('1280fa003804000100005a0001493217f15ebdda412a82520a61344cce00')
  const self = read('1280fa00380300005a00013f84780b5fbdda4177f72723d3d23af300')
  const warmup = { ...next, hasSession: false, startTime: 1794472915.8174345 }
  const model = new NativePhase()
  model.update(nativeState(next), 0); model.update(nativeState(warmup), 0)
  for (let i = 0; i < 10; i++) model.update(2, 0.5)
  const timer = model.timer
  model.update(nativeState(self), 0.1)
  assert.equal(model.timer, timer); assert.equal(model.events.filter(e => e === 'Sit').length, 1)
  model.update(4, 0); assert.deepEqual(model.events, ['warmup', 'Sit', 'broadcast', 'leave'])
  const changeTime = 1794472901.998233
  const total = Math.fround(warmup.startTime - changeTime)
  const shown = t => Math.trunc(total) - Math.trunc(Math.fround(Math.min(t - changeTime, total)))
  assert(shown(changeTime) > shown(changeTime + 5)); assert.equal(shown(warmup.startTime), 0)
  assert.equal(self.sessionId, identityHashOfPlayerId(A))
})
