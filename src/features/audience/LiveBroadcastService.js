import { randomUUID } from 'node:crypto'
import { performance as monotonicClock } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'
import { identityHashOfPlayerId } from '../../protocol/identityHash.js'
import { ErrorCode } from '../../qwd/errorCodes.js'

const MAX_BYTES = 48 * 1024
const MAX_PENDING = 32
const MAX_SEEN = 2048
const MAX_STREAMS = 128
// Capability lease length. It must cover transient node↔QWD WebSocket blips:
// revoking on every disconnect made the broadcast state disappear under公网
// WSS jitter, and only a map re-entry restored it. QWD keeps refreshing the
// same lease across reconnects, so a short blip rides out seamlessly; a real
// outage still expires everything within this window (fail-closed).
const LEASE_MS = 30_000
// Content-side rotation stays tight: QWD prunes idle streams at 5s regardless.
const UPLOAD_IDLE_MS = 5_000
const EVENT_TTL_MS = 3000
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const time = value => Number.isSafeInteger(value) && value >= 0
const level = value => Number.isInteger(value) && value > 0
const canonicalIds = ids => [...new Set(ids.map(value => value.toLowerCase()))].sort()
const identity = data => { const { serverNowMs, ...rest } = data; return rest }

// Independent content has no queue, preparation, stage or native stop control.
// QWD grants short receiving leases to every node, including an empty allowlist.
export class IndependentLiveBroadcastService {
  constructor ({ audience, publish, roomId, sessionOf, levels, clock = () => Date.now(), monotonic = () => monotonicClock.now(), logger = console, id = randomUUID }) {
    Object.assign(this, { audience, publish, roomId, sessionOf, levels, clock, monotonic, logger, id })
    audience.liveBroadcastService = this
    this.available = false
    this.epoch = null
    this.capabilities = new Map()
    this.history = new Map()
    this.retiredCapabilities = new Set()
    this.pending = new Map()
    this.seen = new Map()
    this.streams = new Map()
    this.sources = new Map()
    this.uploads = new WeakMap()
    this.revocations = new Set()
    this.chain = Promise.resolve()
    this.lastSyncAt = -Infinity
  }
  enqueue (operation) {
    const result = this.chain.then(operation)
    this.chain = result.catch(() => {})
    return result
  }
  authority () { return this.audience.performance }
  ready (levelId) {
    const authority = this.authority()
    return this.available && authority?.available && Boolean(authority.authorityEpoch) && authority.offsets.has(levelId)
  }
  send (event, data) {
    return this.available && this.authority()?.available && this.publish(event, { roomId: this.roomId(), ...data }) === true
  }
  sync (force = false) {
    if (!force && this.monotonic() - this.lastSyncAt < 2000) return false
    const sent = this.send('liveBroadcast.sync', { levelIds: [...new Set(this.levels().filter(level))] })
    if (sent) this.lastSyncAt = this.monotonic()
    return sent
  }
  connected () { this.available = true; this.sync(true) }
  clearEphemeral () {
    this.pending.clear(); this.streams.clear(); this.sources.clear(); this.uploads = new WeakMap()
  }
  async revoke (levels) {
    // Clear eligibility synchronously before any client output can yield.
    for (const levelId of levels) { this.capabilities.delete(levelId); this.revocations.add(levelId) }
    this.clearEphemeral()
    await this.flushRevocations()
  }
  async flushRevocations () {
    await Promise.all([...this.revocations].map(async levelId => {
      try { await this.audience.sendPerformanceInfo(levelId); this.revocations.delete(levelId) } catch (error) {
        this.logger.warn?.({ err: error }, 'live broadcast eligibility revoke failed')
      }
    }))
  }
  async disconnected () {
    // A transient node↔QWD WebSocket blip must not kill the broadcast state:
    // keep the granted leases and let tick()/reconcile() expire them at their
    // own deadlines (fail-closed within LEASE_MS). Only the ephemeral content
    // queues are cleared — nothing can be delivered while QWD is unreachable.
    // This.available stays false so no new uploads/publishes are accepted.
    this.available = false
    this.clearEphemeral()
  }
  async reconcile () {
    const epoch = this.authority()?.authorityEpoch ?? null
    if (this.epoch !== epoch) {
      const levels = new Set(this.capabilities.keys())
      this.epoch = epoch
      this.history.clear(); this.retiredCapabilities.clear(); this.seen.clear()
      await this.revoke(levels)
    }
    const expired = new Set()
    for (const [levelId, cap] of this.capabilities) if (!this.validCapability(cap)) expired.add(levelId)
    if (expired.size) await this.revoke(expired)
  }
  validCapability (cap) {
    // Deliberately does NOT consult ready()/authority availability: a transient
    // node↔QWD WebSocket blip must not invalidate a lease QWD already granted.
    // The monotonic deadline and wall expiry below are the fail-closed guards.
    return Boolean(cap && cap.authorityEpoch === this.authority().authorityEpoch &&
      this.monotonic() < cap.deadline && this.clock() + this.authority().leaseOffset(cap.levelId) < cap.expiresAtMs)
  }
  canPublish (playerId, levelId) {
    if (!uuid(playerId)) return false
    const cap = this.capabilities.get(levelId)
    const session = this.sessionOf(playerId)
    return Boolean(this.validCapability(cap) && cap.allowed.has(playerId.toLowerCase()) &&
      this.authority().validSource(session, levelId, session?.player?.lvSeq))
  }
  capabilityAck (data, applied, reason, code = ErrorCode.CONFLICT) {
    return { code: applied ? 0 : code, data: { authorityEpoch: data?.authorityEpoch, capabilityId: data?.capabilityId,
      revision: data?.revision, applied, ...(reason ? { reason } : {}) } }
  }
  async capability (data) {
    await this.reconcile()
    if (!data || !text(data.authorityEpoch) || !text(data.capabilityId) || !level(data.levelId) ||
      !time(data.revision) || !time(data.serverNowMs) || !time(data.expiresAtMs) ||
      data.expiresAtMs <= data.serverNowMs || data.expiresAtMs - data.serverNowMs > LEASE_MS ||
      !Array.isArray(data.allowedPlayerIds) || data.allowedPlayerIds.length > 2048 || !data.allowedPlayerIds.every(uuid)) {
      return this.capabilityAck(data, false, 'invalid', ErrorCode.BAD_REQUEST)
    }
    if (!this.ready(data.levelId) || data.authorityEpoch !== this.epoch) return this.capabilityAck(data, false, 'unsynced')
    const allowedPlayerIds = canonicalIds(data.allowedPlayerIds)
    if (this.retiredCapabilities.has(`${data.levelId}:${data.capabilityId}`)) return this.capabilityAck(data, false, 'retired')
    // Recalibrate the node↔QWD clock mapping from the freshest authoritative
    // timestamp before any deadline arithmetic; without this, node↔QWD clock
    // drift slowly shrank `remaining` until every refresh read as expired.
    this.authority().calibrateClock(data.levelId, data.serverNowMs)
    const previous = this.history.get(data.levelId)
    if (previous && (data.revision < previous.revision || data.serverNowMs < previous.serverNowMs ||
      (data.revision === previous.revision && (data.capabilityId !== previous.capabilityId || data.expiresAtMs !== previous.expiresAtMs)) ||
      (data.capabilityId === previous.capabilityId && !isDeepStrictEqual(allowedPlayerIds, previous.allowedPlayerIds)))) {
      return this.capabilityAck(data, false, 'conflict')
    }
    const remaining = Math.min(LEASE_MS, data.expiresAtMs - (this.clock() + this.authority().leaseOffset(data.levelId)))
    if (remaining <= 0) return this.capabilityAck(data, false, 'expired')
    const old = this.capabilities.get(data.levelId)
    // A replay cannot restart a monotonic lease, even after wall rollback or reconnect.
    if (previous && data.serverNowMs === previous.serverNowMs && data.expiresAtMs !== previous.expiresAtMs) return this.capabilityAck(data, false, 'conflict')
    if (previous && data.revision === previous.revision && !old) return this.capabilityAck(data, false, 'stale_lease')
    if (previous && previous.capabilityId !== data.capabilityId) {
      if (this.retiredCapabilities.size >= MAX_SEEN) return this.capabilityAck(data, false, 'history_full')
      this.retiredCapabilities.add(`${data.levelId}:${previous.capabilityId}`)
    }
    if (old && old.capabilityId !== data.capabilityId) await this.revoke(new Set([data.levelId]))
    const deadline = old && previous?.revision === data.revision ? Math.min(old.deadline, this.monotonic() + remaining) : this.monotonic() + remaining
    const cap = { ...data, allowedPlayerIds, allowed: new Set(allowedPlayerIds), deadline,
      acceptedAt: this.monotonic(), serverAt: Math.max(data.serverNowMs, this.clock() + this.authority().leaseOffset(data.levelId),
        old ? old.serverAt + this.monotonic() - old.acceptedAt : 0) }
    this.history.set(data.levelId, { ...cap, allowed: undefined })
    this.capabilities.set(data.levelId, cap)
    try { await this.audience.sendPerformanceInfo(data.levelId) } catch (error) {
      this.logger.debug?.({ err: error }, 'live capability projection pending')
      return this.capabilityAck(data, false, 'output_pending')
    }
    return this.capabilityAck(data, true)
  }
  async publishContent (session, request, generation) {
    const playerId = session?.player?.uuid?.toString?.()
    const levelId = session?.player?.levelId
    if (!this.canPublish(playerId, levelId) || !this.authority().validSource(session, levelId, generation) ||
      !Number.isFinite(request?.timestamp) || !Number.isInteger(request.actionId) || request.actionId < 0 || request.actionId > 0xffffffff ||
      !Buffer.isBuffer(request.payload) || request.payload.length === 0 || request.payload.length > MAX_BYTES) return false
    let source = this.uploads.get(session)
    if (!source || source.levelId !== levelId || source.generation !== generation || this.monotonic() - source.lastAt >= UPLOAD_IDLE_MS) {
      source = { levelId, generation, streamId: this.id(), lastAt: this.monotonic() }
      this.uploads.set(session, source)
    }
    const accepted = this.send('liveBroadcast.publish', { player: { playerId }, levelId,
      capabilityId: this.capabilities.get(levelId).capabilityId, sourceStreamId: source.streamId,
      eventId: this.id(), timestamp: request.timestamp + this.authority().leaseOffset(levelId) / 1000,
      actionId: request.actionId, payloadBase64: request.payload.toString('base64') })
    if (accepted) source.lastAt = this.monotonic()
    return accepted
  }
  ack (data, applied, reason, code = ErrorCode.CONFLICT) {
    return { code: applied ? 0 : code, data: { authorityEpoch: data?.authorityEpoch, capabilityId: data?.capabilityId,
      streamId: data?.streamId, eventId: data?.eventId, eventSeq: data?.eventSeq, applied, ...(reason ? { reason } : {}) } }
  }
  key (data) { return `${data.levelId}:${data.playerId}:${data.streamId}:${data.eventId}` }
  recipients (levelId) {
    const recipients = new Map()
    for (const [playerId, roster] of this.audience.rosters) {
      const session = this.sessionOf(playerId)
      if (roster.levelId === levelId && this.authority()?.validSource(session, levelId, session?.player?.lvSeq)) {
        recipients.set(session, { playerId, generation: session.player.lvSeq })
      }
    }
    return recipients
  }
  live (session, recipient, levelId) {
    return this.sessionOf(recipient.playerId) === session && this.authority()?.validSource(session, levelId, recipient.generation)
  }
  expired (entry) {
    return this.monotonic() >= entry.deadline || this.clock() + this.authority().leaseOffset(entry.data.levelId) >= entry.data.expiresAtMs
  }
  usable (entry) {
    const cap = this.capabilities.get(entry.data.levelId)
    return this.pending.get(this.key(entry.data)) === entry && !this.expired(entry) && this.validCapability(cap) &&
      cap.capabilityId === entry.data.capabilityId && cap.authorityEpoch === entry.data.authorityEpoch
  }
  async deliver (data) {
    await this.reconcile()
    if (!data || !text(data.authorityEpoch) || !text(data.capabilityId) || !level(data.levelId) || !uuid(data.playerId) ||
      !text(data.streamId) || !text(data.eventId) || !Number.isSafeInteger(data.eventSeq) || data.eventSeq < 1 ||
      !time(data.serverNowMs) || !time(data.expiresAtMs) || data.expiresAtMs <= data.serverNowMs ||
      data.expiresAtMs - data.serverNowMs > EVENT_TTL_MS || !Number.isFinite(data.timestamp) ||
      !Number.isInteger(data.actionId) || data.actionId < 0 || data.actionId > 0xffffffff ||
      typeof data.payloadBase64 !== 'string' || data.payloadBase64.length === 0 || data.payloadBase64.length > MAX_BYTES * 4 / 3 ||
      Buffer.from(data.payloadBase64, 'base64').toString('base64') !== data.payloadBase64) return this.ack(data, false, 'invalid', ErrorCode.BAD_REQUEST)
    data = { ...data, playerId: data.playerId.toLowerCase() }
    const cap = this.capabilities.get(data.levelId)
    if (!this.validCapability(cap) || data.authorityEpoch !== this.epoch || cap.capabilityId !== data.capabilityId) return this.ack(data, false, 'unsynced')
    // Reception intentionally does not consult the local publisher allowlist.
    const key = this.key(data), seen = this.seen.get(key)
    if (seen) return isDeepStrictEqual(seen.identity, identity(data)) ? this.ack(data, seen.applied, seen.reason) : this.ack(data, false, 'conflict')
    let entry = this.pending.get(key)
    if (entry && !isDeepStrictEqual(identity(entry.data), identity(data))) return this.ack(data, false, 'conflict')
    if (!entry) {
      const remaining = Math.min(EVENT_TTL_MS, data.expiresAtMs - Math.max(
        this.clock() + this.authority().leaseOffset(data.levelId), cap.serverAt + this.monotonic() - cap.acceptedAt))
      if (remaining <= 0) return this.ack(data, false, 'expired')
      if (this.pending.size >= MAX_PENDING) return this.ack(data, false, 'busy')
      const sourceKey = `${data.levelId}:${data.playerId}`, streamKey = `${sourceKey}:${data.streamId}`
      let stream = this.streams.get(streamKey)
      if (stream?.retired || data.eventSeq <= (stream?.seq ?? 0)) return this.ack(data, false, 'stale')
      if (!stream) {
        if (this.streams.size >= MAX_STREAMS) return this.ack(data, false, 'streams_full')
        const previousKey = this.sources.get(sourceKey)
        if (previousKey) {
          this.streams.get(previousKey).retired = true
          for (const [oldKey, old] of this.pending) if (`${old.data.levelId}:${old.data.playerId}:${old.data.streamId}` === previousKey) this.finish(oldKey, old, false, 'retired')
        }
        stream = { seq: 0, retired: false }; this.streams.set(streamKey, stream); this.sources.set(sourceKey, streamKey)
      }
      stream.seq = data.eventSeq
      stream.lastAt = this.monotonic()
      stream.retireAt = this.monotonic() + 30000
      entry = { data, submitted: new Set(), recipients: this.recipients(data.levelId), deadline: this.monotonic() + remaining }
      this.pending.set(key, entry)
    }
    return this.attempt(key, entry)
  }
  finish (key, entry, applied, reason) {
    this.pending.delete(key)
    this.seen.set(key, { identity: identity(entry.data), applied, reason })
    while (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.keys().next().value)
  }
  async attempt (key, entry) {
    const data = entry.data
    if (!this.usable(entry)) { this.finish(key, entry, false, 'expired'); return this.ack(data, false, 'expired') }
    const entity = this.audience.barn.getEntityForPlayer(data.playerId)
    if (!entity || entity.levelId !== data.levelId || !identityHashOfPlayerId(data.playerId)) return this.ack(data, false, 'missing_entity', ErrorCode.NOT_FOUND)
    const recipientValid = playerId => {
      const session = this.sessionOf(playerId), recipient = entry.recipients.get(session)
      return Boolean(this.usable(entry) && recipient && this.live(session, recipient, data.levelId))
    }
    try {
      if (!await this.audience.preparePerformance(data.levelId, data.playerId, { recipientValid })) return this.ack(data, false, 'missing_entity', ErrorCode.NOT_FOUND)
      if (!this.usable(entry)) return this.ack(data, false, 'expired')
      if (this.audience.barn.getEntityForPlayer(data.playerId) !== entity || entity.levelId !== data.levelId) return this.ack(data, false, 'missing_entity', ErrorCode.NOT_FOUND)
      await this.audience.broadcastPerformance({ sessionId: identityHashOfPlayerId(data.playerId),
        time: data.timestamp - this.authority().leaseOffset(data.levelId) / 1000, counter: data.actionId,
        json: Buffer.from(data.payloadBase64, 'base64'), levelId: data.levelId,
        submitted: entry.submitted, recipientKey: playerId => this.sessionOf(playerId), recipientValid })
    } catch (error) {
      this.logger.debug?.({ err: error }, 'live broadcast client output pending')
      return this.ack(data, false, 'output_pending')
    }
    const complete = [...entry.recipients].every(([session, recipient]) => entry.submitted.has(session) || !this.live(session, recipient, data.levelId))
    if (complete && entry.submitted.size && this.usable(entry)) {
      this.finish(key, entry, true)
      return this.ack(data, true)
    }
    return this.ack(data, false, 'pending')
  }
  async tick () {
    await this.reconcile()
    await this.flushRevocations()
    // Only a fresh QWD delivery command may retry output: QWD revalidates the
    // source before retrying. A local timer cannot resurrect a departed source.
    for (const [key, entry] of this.pending) if (!this.usable(entry)) this.finish(key, entry, false, 'expired')
    for (const [key, stream] of this.streams) {
      if (this.monotonic() - stream.lastAt >= UPLOAD_IDLE_MS) stream.retired = true
      if (this.monotonic() >= stream.retireAt) {
        this.streams.delete(key)
        for (const [source, current] of this.sources) if (current === key) this.sources.delete(source)
      }
    }
    for (const [playerId] of this.audience.rosters) {
      const session = this.sessionOf(playerId)
      if (this.authority()?.current(session?.player?.levelId)?.performerId === playerId) this.uploads.delete(session)
    }
    this.sync()
  }
}
export { IndependentLiveBroadcastService as LiveBroadcastService }
export const independentLiveBroadcastService = options => new IndependentLiveBroadcastService(options)
