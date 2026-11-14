import { randomUUID } from 'node:crypto'
import { performance as monotonicClock } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'

const MAX_PENDING = 64
const MAX_BUFFERED = 128
const MAX_CONTENT_BYTES = 48 * 1024
const REQUEST_TIMEOUT_MS = 15000

export function validPerformanceState (state) {
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
  const time = value => Number.isSafeInteger(value) && value >= 0
  const phase = (value, id) => value && text(value[id]) && text(value.performerId) &&
    time(value.startedAtMs) && time(value.expiresAtMs) && time(value.durationMs) && value.durationMs > 0 &&
    value.expiresAtMs - value.startedAtMs === value.durationMs && value.startedAtMs <= state.serverNowMs
  if (!state || !text(state.authorityEpoch) ||
    !Number.isSafeInteger(state.revision) || state.revision < 0 || !time(state.serverNowMs) ||
    !Array.isArray(state.queue) || state.queue.length > 10000 ||
    !state.queue.every(entry => entry && text(entry.playerId) && time(entry.enqueuedAtMs) && entry.enqueuedAtMs <= state.serverNowMs) ||
    new Set(state.queue.map(entry => entry.playerId)).size !== state.queue.length ||
    !(state.current === null || phase(state.current, 'sessionId')) ||
    !(state.preparing === null || phase(state.preparing, 'preparationId')) ||
    (state.current && state.preparing)) return false
  if (state.current && state.queue.some(entry => entry.playerId === state.current.performerId)) return false
  if (state.preparing && (state.queue[0]?.playerId !== state.preparing.performerId ||
    state.queue[0].enqueuedAtMs > state.preparing.startedAtMs)) return false
  const ended = state.lastEnded
  return ended === null || Boolean(ended && text(ended.sessionId) && text(ended.performerId) &&
    time(ended.endedAtMs) && ended.endedAtMs <= state.serverNowMs && text(ended.reason) &&
    Number.isSafeInteger(ended.revision) && ended.revision >= 0 && ended.revision <= state.revision &&
    ended.sessionId !== state.current?.sessionId)
}

// QWD owns decisions and session lifetimes. This class only maintains a bounded,
// ordered projection; it never promotes a queued player or creates a session.
export class PerformanceAuthority {
  constructor ({ audience, publish, roomId, sessionOf, levels, clock = () => Date.now(), monotonic = () => monotonicClock.now(), logger = console, id = randomUUID }) {
    Object.assign(this, { audience, publish, roomId, sessionOf, levels, clock, monotonic, logger, id })
    this.deadlines = new Map()
    this.preparationClocks = new Map()
    this.states = new Map()
    this.pending = new Map()
    this.cursors = new Map()
    this.buffers = new Map()
    this.eventIds = new Map()
    this.submitted = new Map()
    this.draining = new Map()
    this.authorityEpoch = null
    this.retiredEpochs = new Set()
    this.expired = new Set()
    this.offsets = new Map()
    // Lease arithmetic only (live broadcast TTL checks). Refreshed far more
    // often than `offsets`, which must stay frozen per epoch: AudienceService
    // projects client-visible session times through `offsets`, and refreshing
    // it would shift a running countdown on every state arrival.
    this.leaseOffsets = new Map()
    this.available = false
    this.operationChain = Promise.resolve()
    this.lastSyncAt = -Infinity
  }

  enqueue (operation) {
    const result = this.operationChain.then(operation)
    this.operationChain = result.catch(() => {})
    return result
  }

  validSource (session, levelId, generation) {
    const player = session?.player
    const playerId = player?.uuid?.toString?.()
    return Boolean(playerId && this.sessionOf(playerId) === session && !session.closed && session.isActive?.() &&
      player.levelId === levelId &&
      Number.isInteger(generation) && generation === player.lvSeq &&
      this.audience.rosters.get(playerId)?.levelId === levelId)
  }

  send (event, data) {
    if (!this.available) return false
    return this.publish(event, { roomId: this.roomId(), ...data }) === true
  }

  /**
   * Re-derive the QWD-to-node clock mapping from a fresh authoritative
   * timestamp into the lease-only map. Called on every liveBroadcast capability
   * so lease validation tracks the actual node↔QWD skew instead of a value
   * frozen at epoch start. Never touches `offsets` — client-visible session
   * countdowns project through the frozen mapping and must not shift.
   */
  calibrateClock (levelId, serverNowMs) {
    if (!Number.isSafeInteger(serverNowMs)) return
    this.leaseOffsets.set(levelId, serverNowMs - this.clock())
  }

  leaseOffset (levelId) {
    return this.leaseOffsets.get(levelId) ?? this.offsets.get(levelId) ?? 0
  }

  sync (force = false) {
    if (!force && this.clock() - this.lastSyncAt < 2000) return false
    const sent = this.send('performance.sync', {
      levelIds: [...new Set(this.levels())],
      ...(this.authorityEpoch ? { authorityEpoch: this.authorityEpoch } : {}),
      eventCursors: Object.fromEntries(this.cursors)
    })
    if (sent) this.lastSyncAt = this.clock()
    return sent
  }

  connected () { this.available = true; this.sync(true) }

  async disconnected () {
    this.available = false
    for (const request of this.pending.values()) await this.reject(request)
    this.pending.clear()
  }

  async reject (request) {
    if (this.validSource(request.session, request.levelId, request.generation)) {
      await this.audience.sendSpotlightResponse(request.playerId, false, false)
    }
  }

  async request (session, requested, generation) {
    const playerId = session?.player?.uuid?.toString?.()
    const levelId = session?.player?.levelId
    if (!this.validSource(session, levelId, generation)) return false
    const request = { playerId, session, levelId, generation, requested, at: this.clock() }
    if (this.pending.size >= MAX_PENDING || !this.available) {
      this.logger.warn?.({ playerId, levelId }, 'performance request rejected: QWD unavailable or busy')
      await this.reject(request)
      return false
    }
    const requestId = this.id()
    this.pending.set(requestId, request)
    const { current, preparing } = this.states.get(levelId) ?? {}
    if (!this.send('performance.request', {
      player: { playerId }, levelId, requestId, requested,
      ...(current ? { expectedSessionId: current.sessionId } : {}),
      ...(!requested && preparing?.performerId === playerId ? { expectedPreparationId: preparing.preparationId } : {})
    })) {
      this.pending.delete(requestId)
      await this.reject(request)
      return false
    }
    return true
  }

  async decision (data) {
    if (!data || !['started', 'queued', 'released', 'cancelled', 'rejected'].includes(data.status) ||
      !validPerformanceState(data.state)) throw new Error('invalid performance decision')
    const request = this.pending.get(data.requestId)
    if (request && (request.playerId !== data.playerId || request.requested !== data.requested || request.levelId !== data.state.levelId)) {
      throw new Error('performance decision does not match request')
    }
    const applied = await this.state(data.state)
    if (!request) return
    this.pending.delete(data.requestId)
    if (!this.validSource(request.session, request.levelId, request.generation)) return
    if (!applied) { await this.reject(request); return }
    // Packet 29 acknowledges the request, not ownership of the stage. IDA
    // case29 clears request-pending; StreamInfo session/profile selects performer.
    const current = this.current(request.levelId)
    const accepted = data.status === 'queued' || (data.status === 'started' && current?.performerId === request.playerId)
    const released = data.status === 'released' || data.status === 'cancelled'
    await this.audience.sendSpotlightResponse(request.playerId, accepted, released)
  }

  current (levelId) {
    const state = this.states.get(levelId)
    const current = state?.current
    if (!current || this.expired.has(current.sessionId)) return null
    const now = this.clock() + (this.offsets.get(levelId) ?? 0)
    return now < current.expiresAtMs && this.monotonic() < (this.deadlines.get(current.sessionId) ?? -Infinity) ? current : null
  }

  // Preparation does not expire/promote locally: QWD alone leaves this phase.
  // Its wire countdown is clamped by monotonic time even if wall time rolls back.
  preparing (levelId) { return this.states.get(levelId)?.preparing ?? null }

  preparationDeadline (levelId) {
    const preparing = this.preparing(levelId)
    if (!preparing) return null
    const timing = this.preparationClocks.get(`${levelId}:${preparing.preparationId}`)
    if (!timing) return null
    timing.wire = Math.min(timing.wire, this.clock() + Math.max(0, timing.monotonic - this.monotonic()))
    return timing.wire
  }

  projection (levelId) {
    const state = this.states.get(levelId)
    const current = this.current(levelId)
    // Expiring a session locally must not turn its unapproved next player into
    // native state2. Only a QWD preparation grants that transition.
    return { current, preparing: this.preparing(levelId),
      queue: state?.current && !current ? [] : state?.queue ?? [] }
  }

  async state (incoming) {
    if (!validPerformanceState(incoming)) throw new Error('invalid performance state')
    const state = structuredClone(incoming)
    if (this.retiredEpochs.has(state.authorityEpoch)) return false
    if (this.authorityEpoch !== state.authorityEpoch) {
      if (this.authorityEpoch) this.retiredEpochs.add(this.authorityEpoch)
      while (this.retiredEpochs.size > 16) this.retiredEpochs.delete(this.retiredEpochs.values().next().value)
      for (const levelId of this.states.keys()) await this.audience.clearPerformance(levelId)
      this.states.clear(); this.cursors.clear(); this.buffers.clear(); this.eventIds.clear(); this.submitted.clear(); this.expired.clear(); this.offsets.clear(); this.leaseOffsets.clear(); this.deadlines.clear(); this.preparationClocks.clear()
      this.authorityEpoch = state.authorityEpoch
    }
    const previous = this.states.get(state.levelId)
    if (previous && state.revision < previous.revision) return false
    if (previous && state.revision === previous.revision) {
      const { serverNowMs: ignoredPrevious, ...oldContent } = previous
      const { serverNowMs: ignoredIncoming, ...newContent } = state
      if (!isDeepStrictEqual(oldContent, newContent)) throw new Error('conflicting performance state revision')
      // A previous output attempt may have failed after storing the state.
      // Retry the projection before acknowledging the revision as applied.
      await this.audience.applyPerformanceState(state.levelId, this.projection(state.levelId))
      return true
    }
    // IDs name immutable lifetimes, not extendable leases. Reject conflicting
    // higher revisions as well as exact-revision conflicts.
    for (const [field, id] of [['current', 'sessionId'], ['preparing', 'preparationId']]) {
      if (previous?.[field] && state[field]?.[id] === previous[field][id] &&
        !isDeepStrictEqual(state[field], previous[field])) throw new Error(`conflicting performance ${field} identity`)
    }
    const old = previous?.current
    if (old && old.sessionId !== state.current?.sessionId) {
      this.buffers.delete(old.sessionId)
      this.cursors.delete(old.sessionId)
    }
    this.states.set(state.levelId, state)
    // Fix the QWD-to-node clock mapping once per level per authority epoch.
    // This offset projects client-visible session times (AudienceService
    // startTime), so it must stay frozen — refreshing it on every state
    // arrival shifts a running countdown by whatever the node↔QWD walls
    // drifted since epoch start. Lease arithmetic tracks the fresh mapping
    // separately via calibrateClock()/leaseOffset() instead.
    if (!this.offsets.has(state.levelId)) this.offsets.set(state.levelId, state.serverNowMs - this.clock())
    if (state.current && !this.deadlines.has(state.current.sessionId)) {
      this.deadlines.set(state.current.sessionId, this.monotonic() + Math.max(0,
        state.current.expiresAtMs - (this.clock() + this.offsets.get(state.levelId))))
      while (this.deadlines.size > 512) this.deadlines.delete(this.deadlines.keys().next().value)
    }
    if (state.preparing) {
      const key = `${state.levelId}:${state.preparing.preparationId}`
      if (!this.preparationClocks.has(key)) {
        const wire = state.preparing.expiresAtMs - this.offsets.get(state.levelId)
        this.preparationClocks.set(key, { wire, monotonic: this.monotonic() + Math.max(0, wire - this.clock()) })
        while (this.preparationClocks.size > 512) this.preparationClocks.delete(this.preparationClocks.keys().next().value)
      }
    }
    const current = this.current(state.levelId)
    await this.audience.applyPerformanceState(state.levelId, this.projection(state.levelId))
    if (current && !this.cursors.has(current.sessionId)) this.cursors.set(current.sessionId, 0)
    return true
  }

  async publishContent (session, request, generation) {
    const levelId = session?.player?.levelId
    if (!this.validSource(session, levelId, generation)) return false
    const playerId = session.player.uuid.toString()
    const current = this.current(levelId)
    if (!current || current.performerId !== playerId || !Number.isFinite(request.timestamp) ||
      !Number.isInteger(request.actionId) || request.actionId < 0 || request.actionId > 0xffffffff ||
      !Buffer.isBuffer(request.payload) || request.payload.length === 0 || request.payload.length > MAX_CONTENT_BYTES) return false
    const sent = this.send('performance.publish', {
      player: { playerId }, levelId, sessionId: current.sessionId, eventId: this.id(),
      timestamp: request.timestamp, actionId: request.actionId, payloadBase64: request.payload.toString('base64')
    })
    if (!sent) this.logger.warn?.({ levelId, playerId }, 'performance content not accepted by QWD transport')
    return sent
  }

  async deliver (data) {
    if (!data || !validPerformanceState(data.state) || typeof data.eventId !== 'string' || !data.eventId ||
      !Number.isSafeInteger(data.eventSeq) || data.eventSeq < 1 || !Number.isFinite(data.timestamp) ||
      !Number.isInteger(data.actionId) || data.actionId < 0 || data.actionId > 0xffffffff ||
      typeof data.payloadBase64 !== 'string' || data.payloadBase64.length > MAX_CONTENT_BYTES * 4 / 3 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.payloadBase64)) throw new Error('invalid performance delivery')
    if (!await this.state(data.state)) return { stale: true, eventCursor: this.cursors.get(data.sessionId) ?? 0, buffered: 0 }
    const current = this.current(data.state.levelId)
    if (!current || current.sessionId !== data.sessionId || current.performerId !== data.playerId) return { stale: true, eventCursor: this.cursors.get(data.sessionId) ?? 0, buffered: 0 }
    const cursor = this.cursors.get(data.sessionId) ?? 0
    if (data.eventSeq <= cursor) return { duplicate: true, eventCursor: cursor, buffered: this.buffers.get(data.sessionId)?.size ?? 0 }
    let buffer = this.buffers.get(data.sessionId)
    if (!buffer) { buffer = new Map(); this.buffers.set(data.sessionId, buffer) }
    const existing = buffer.get(data.eventSeq)
    if (existing && existing.eventId !== data.eventId) throw new Error('conflicting performance sequence')
    if (buffer.size >= MAX_BUFFERED && !existing) { this.sync(); throw new Error('performance delivery buffer full') }
    buffer.set(data.eventSeq, data)
    await this.drain(data.sessionId)
    if (buffer.size) this.sync()
    return { eventCursor: this.cursors.get(data.sessionId), buffered: buffer.size }
  }

  async drain (sessionId) {
    if (this.draining.has(sessionId)) return this.draining.get(sessionId)
    const promise = this.drainSession(sessionId)
    this.draining.set(sessionId, promise)
    try { await promise } finally { if (this.draining.get(sessionId) === promise) this.draining.delete(sessionId) }
  }

  async drainSession (sessionId) {
    const buffer = this.buffers.get(sessionId)
    if (!buffer) return
    let next = (this.cursors.get(sessionId) ?? 0) + 1
    while (buffer.has(next)) {
      const data = buffer.get(next)
      const current = this.current(data.state.levelId)
      if (!current || current.sessionId !== sessionId) { buffer.clear(); return }
      // An identity profile is sent reliably before the content for every viewer.
      if (!await this.audience.preparePerformance(data.state.levelId, current.performerId)) { this.sync(); return }
      const eventKey = `${sessionId}:${data.eventId}`
      if (!this.eventIds.has(eventKey)) {
        let submitted = this.submitted.get(eventKey)
        if (!submitted) { submitted = new Set(); this.submitted.set(eventKey, submitted) }
        await this.audience.broadcastPerformance({ sessionId: this.audience.performanceIdentity(current.performerId),
          time: data.timestamp, counter: data.actionId, json: Buffer.from(data.payloadBase64, 'base64'), levelId: data.state.levelId,
          submitted, recipientKey: playerId => this.sessionOf(playerId) })
        this.submitted.delete(eventKey)
        this.eventIds.set(eventKey, next)
        while (this.eventIds.size > 2048) this.eventIds.delete(this.eventIds.keys().next().value)
      }
      buffer.delete(next)
      this.cursors.set(sessionId, next++)
    }
  }

  async gap (data) {
    if (!data || data.authorityEpoch !== this.authorityEpoch ||
      !Number.isSafeInteger(data.oldestAvailableSeq) || data.oldestAvailableSeq < 1 ||
      !['epoch_changed', 'cursor_ahead', 'journal_gap', 'session_ended'].includes(data.reason)) throw new Error('invalid performance gap')
    const state = this.states.get(data.levelId)
    const sessionId = state?.current?.sessionId ?? null
    if (!state || data.sessionId !== sessionId ||
      (data.reason === 'session_ended' && sessionId !== null)) {
      return { authorityEpoch: this.authorityEpoch, sessionId: data.sessionId, applied: false, stale: true,
        eventCursor: data.sessionId ? this.cursors.get(data.sessionId) ?? 0 : 0 }
    }
    await this.audience.clearBroadcast(data.levelId)
    this.logger.warn?.(data, 'performance replay gap; client broadcast objects cleared')
    if (data.sessionId) {
      this.cursors.set(data.sessionId, data.oldestAvailableSeq - 1)
      const buffer = this.buffers.get(data.sessionId)
      if (buffer) for (const seq of buffer.keys()) if (seq < data.oldestAvailableSeq) buffer.delete(seq)
      await this.drain(data.sessionId)
    }
    return { authorityEpoch: this.authorityEpoch, sessionId: data.sessionId, applied: true,
      eventCursor: data.sessionId ? this.cursors.get(data.sessionId) ?? 0 : 0 }
  }

  async tick () {
    for (const [requestId, request] of this.pending) {
      if (this.clock() - request.at >= REQUEST_TIMEOUT_MS) { this.pending.delete(requestId); await this.reject(request) }
    }
    for (const [levelId, state] of this.states) {
      if (state.current && !this.current(levelId) && !this.expired.has(state.current.sessionId)) {
        this.expired.add(state.current.sessionId)
        await this.audience.clearPerformance(levelId)
        this.buffers.delete(state.current.sessionId)
        this.sync()
      }
    }
    for (const sessionId of this.buffers.keys()) await this.drain(sessionId)
    this.sync()
  }
}
