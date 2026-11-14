import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { performance as monotonicClock } from 'node:perf_hooks'
import { identityHashOfPlayerId } from '../../protocol/identityHash.js'
import { ErrorCode } from '../../qwd/errorCodes.js'

const validReaction = reaction => Boolean(reaction && Number.isInteger(reaction.flag7) && reaction.flag7 >= 0 && reaction.flag7 <= 7 &&
  Number.isInteger(reaction.type) && reaction.type >= 0 && reaction.type <= 13)

// Short-lived pulses are not barn state: rendering the crowd on later ticks
// must never repeat an emote. The QWD event id, not its reaction value, is identity.
export class AudienceReactionService {
  constructor ({ audience, publish, roomId, sessionOf, clock = () => Date.now(), monotonic = () => monotonicClock.now(),
    logger = console, id = randomUUID, maxPending = 128, maxSeen = 2048, maxTtlMs = 2000 }) {
    Object.assign(this, { audience, publish, roomId, sessionOf, clock, monotonic, logger, id, maxPending, maxSeen, maxTtlMs })
    audience.reactions = this
    this.savedFrames = new WeakMap()
    this.pending = new Map()
    this.seen = new Map()
    this.sequences = new Map()
    this.epoch = null
    this.chain = Promise.resolve()
  }
  enqueue (operation) {
    const result = this.chain.then(operation)
    this.chain = result.catch(() => {})
    return result
  }
  authority () { return this.audience.performance }
  resetEpoch () {
    const epoch = this.authority()?.authorityEpoch
    if (epoch !== this.epoch) {
      this.pending.clear(); this.seen.clear(); this.sequences.clear()
      this.epoch = epoch
    }
  }
  collect ({ session, source, decodedState, audiencePrefix, snapshot, payload, generation, confirmedLayout }) {
    const authority = this.authority()
    if (!authority?.available || !authority.authorityEpoch || !source || !Buffer.isBuffer(payload) ||
      !authority.validSource(session, source.levelId, generation)) return false
    const prefixValid = audiencePrefix?.version === 'sky-0.35.1-net-prefix' && audiencePrefix.parsed === true
    const stateValid = decodedState?.parsed && !decodedState.partial &&
      (decodedState.complete || (decodedState.minimal && confirmedLayout && decodedState.layout === confirmedLayout))
    if (!prefixValid && !stateValid) return false
    const net = (prefixValid ? audiencePrefix : decodedState).fields?.net
    const reaction = { flag7: net?.modeBytes?.[0], type: net?.modeBytes?.[1] }
    // Spotlight 14/15 belongs to PerformanceAuthority. No raw-prefix guesses.
    if (!validReaction(reaction) || (reaction.flag7 === 0 && reaction.type === 0)) return false
    const seq = snapshot?.sequence
    if (Number.isInteger(seq) && seq !== 0) {
      let saved = this.savedFrames.get(session)
      if (!saved || saved.generation !== generation) { saved = { generation, frames: new Map() }; this.savedFrames.set(session, saved) }
      const key = `${seq}:${snapshot.base}:${snapshot.checksum}`
      const previous = saved.frames.get(key)
      if (previous?.equals(payload)) return false
      saved.frames.set(key, Buffer.from(payload))
      while (saved.frames.size > 16) saved.frames.delete(saved.frames.keys().next().value)
    }
    // sequence=0 is an unsaved delta: identical bytes can be two real clicks.
    // Each successful read is a pulse. There is no proven transport identity to
    // distinguish a duplicated datagram from a second same-value click here.
    const data = { roomId: this.roomId(), player: { playerId: source.uuid.toString() }, levelId: source.levelId,
      eventId: this.id(), reaction }
    const accepted = this.publish('audience.reaction', data) === true
    if (!accepted) this.logger.warn?.({ playerId: data.player.playerId }, 'audience reaction not accepted by QWD transport')
    return accepted
  }
  ack (data, applied, reason, code = ErrorCode.CONFLICT) {
    return { code: applied ? 0 : code, data: { authorityEpoch: data?.authorityEpoch, eventId: data?.eventId,
      eventSeq: data?.eventSeq, applied, ...(reason ? { reason } : {}) } }
  }
  key (data) { return `${data.authorityEpoch}:${data.levelId}:${data.playerId}:${data.eventId}` }
  identity (data) {
    const { serverNowMs, ...immutable } = data
    return immutable
  }
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
    return this.sessionOf(recipient.playerId) === session &&
      this.authority()?.validSource(session, levelId, recipient.generation)
  }
  expired (entry) {
    return this.monotonic() >= entry.deadline ||
      this.clock() + (this.authority()?.offsets.get(entry.data.levelId) ?? 0) >= entry.data.expiresAtMs
  }
  async apply (data) {
    this.tick()
    const authority = this.authority()
    if (!data || typeof data.eventId !== 'string' || !data.eventId || data.eventId.length > 256 ||
      typeof data.playerId !== 'string' || !data.playerId || !Number.isInteger(data.levelId) || !validReaction(data.reaction) ||
      !Number.isSafeInteger(data.eventSeq) || data.eventSeq < 1 || !Number.isFinite(data.serverNowMs) ||
      !Number.isFinite(data.expiresAtMs) || data.expiresAtMs < data.serverNowMs) return this.ack(data, false, 'invalid')
    if (!authority?.available || !this.epoch || data.authorityEpoch !== this.epoch || !authority.offsets.has(data.levelId)) {
      return this.ack(data, false, 'unsynced')
    }
    if (this.audience.rosters.has(data.playerId)) return this.ack(data, false, 'source_room')
    const key = this.key(data)
    const seen = this.seen.get(key)
    if (seen) return isDeepStrictEqual(seen.identity, this.identity(data))
      ? this.ack(data, seen.applied, seen.reason) : this.ack(data, false, 'conflict')
    const stream = `${data.levelId}:${data.playerId}`
    let entry = this.pending.get(key)
    if (entry && !isDeepStrictEqual(this.identity(entry.data), this.identity(data))) return this.ack(data, false, 'conflict')
    if (!entry) {
      if (data.eventSeq <= (this.sequences.get(stream) ?? 0)) return this.ack(data, false, 'stale')
      const remaining = Math.min(this.maxTtlMs, data.expiresAtMs - (this.clock() + authority.offsets.get(data.levelId)))
      if (remaining <= 0) return this.ack(data, false, 'expired')
      if (this.pending.size >= this.maxPending) return this.ack(data, false, 'busy')
      entry = { data: structuredClone(data), submitted: new Set(), recipients: this.recipients(data.levelId),
        deadline: this.monotonic() + remaining }
      this.pending.set(key, entry)
    }
    const entity = this.audience.barn.getEntityForPlayer(data.playerId)
    if (authority.current(data.levelId)?.performerId === data.playerId || entity?.type === 14 || entity?.type === 15) {
      this.finish(key, entry, false, 'spotlight')
      return this.ack(data, false, 'spotlight')
    }
    // Receiving a command never inserts a position sample or sends id18. The
    // next scheduled AudienceService frame performs prepare/commit for us.
    if (!entity || entity.levelId !== data.levelId || !identityHashOfPlayerId(data.playerId)) {
      return this.ack(data, false, 'missing_entity', ErrorCode.NOT_FOUND)
    }
    return this.ack(data, false, entry.recipients.size ? 'pending' : 'no_recipients')
  }
  finish (key, entry, applied, reason) {
    this.pending.delete(key)
    this.seen.set(key, { applied, reason, identity: this.identity(entry.data) })
    if (applied) {
      const stream = `${entry.data.levelId}:${entry.data.playerId}`
      this.sequences.set(stream, Math.max(this.sequences.get(stream) ?? 0, entry.data.eventSeq))
    }
    while (this.seen.size > this.maxSeen) this.seen.delete(this.seen.keys().next().value)
    while (this.sequences.size > this.maxSeen) this.sequences.delete(this.sequences.keys().next().value)
  }
  prepare (playerId, levelId) {
    this.tick()
    const session = this.sessionOf(playerId)
    const entries = [...this.pending.entries()].sort((a, b) => a[1].data.eventSeq - b[1].data.eventSeq)
    const selected = new Map()
    if (!this.authority()?.available) return selected
    for (const [key, entry] of entries) {
      const recipient = entry.recipients.get(session)
      if (entry.data.levelId !== levelId || !recipient || entry.submitted.has(session) ||
        !this.live(session, recipient, levelId)) continue
      const entity = this.audience.barn.getEntityForPlayer(entry.data.playerId)
      if (!entity || entity.levelId !== levelId || selected.has(entity.entityIdx) ||
        this.authority().current(levelId)?.performerId === entry.data.playerId || entity.type === 14 || entity.type === 15) continue
      selected.set(entity.entityIdx, { key, entry, session, recipient, entity })
    }
    return selected
  }
  usable (transaction) {
    return this.pending.get(transaction.key) === transaction.entry && !this.expired(transaction.entry) &&
      this.authority()?.available && transaction.entry.data.authorityEpoch === this.authority().authorityEpoch &&
      this.live(transaction.session, transaction.recipient, transaction.entry.data.levelId) &&
      this.audience.barn.getEntityForPlayer(transaction.entry.data.playerId) === transaction.entity &&
      this.authority().current(transaction.entry.data.levelId)?.performerId !== transaction.entry.data.playerId &&
      transaction.entity.type !== 14 && transaction.entity.type !== 15
  }
  commit (transactions) {
    for (const transaction of transactions) {
      if (!this.usable(transaction)) continue
      const { key, entry, session } = transaction
      entry.submitted.add(session)
      const complete = [...entry.recipients].every(([target, recipient]) =>
        entry.submitted.has(target) || !this.live(target, recipient, entry.data.levelId))
      if (complete && entry.submitted.size) this.finish(key, entry, true)
    }
  }
  disconnected () { this.pending.clear() }
  tick () {
    this.resetEpoch()
    for (const [key, entry] of this.pending) {
      if (this.expired(entry)) this.finish(key, entry, false, 'expired')
      else if ([...entry.recipients].some(([session, recipient]) => !this.live(session, recipient, entry.data.levelId))) {
        // A new peer/generation is never an implicit recipient of an old pulse.
        for (const [session, recipient] of entry.recipients) {
          if (!this.live(session, recipient, entry.data.levelId)) entry.recipients.delete(session)
        }
        if (!entry.recipients.size) this.finish(key, entry, false, 'recipients_left')
        else if ([...entry.recipients.keys()].every(session => entry.submitted.has(session))) this.finish(key, entry, true)
      }
    }
  }
}
