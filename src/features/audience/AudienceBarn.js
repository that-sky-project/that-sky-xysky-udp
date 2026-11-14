import {
  AUDIENCE_MAX_ENTITY,
  AUDIENCE_MAX_ENTITY_INDEX,
  AUDIENCE_ROOM_MEMBER_LIMIT,
  AUDIENCE_ENTITY_FULL_BYTES,
  AUDIENCE_ENTITY_LIGHT_BYTES
} from '../../protocol/types/Audience.js'
import {
  buildFrame as shapeFrame,
  buildFrames as shapeFrames,
  buildProfileChunks as shapeProfileChunks,
  estimateFrameBytes,
  suggestOrigin as computeOrigin
} from './AudienceFrames.js'
export const SEATS_PER_BENCH = 8
export const BENCH_COUNT = 1267
export const AUDIENCE_ENTITY_FLAGS_OUTSIDE_ROOM = 0x8040
export const AUDIENCE_ENTITY_FLAG_ACTIVATED = 0x0001
export const AUDIENCE_ENTITY_FLAG_NO_SEAT_LOOKUP = 0x0010
export const AUDIENCE_ENTITY_FLAG_OUTSIDE_ROOM = 0x0040
export const AUDIENCE_ENTITY_FLAG_IN_ROOM = 0x1000
export const AUDIENCE_ENTITY_FLAG_SPECIAL_TYPE = 0x2000
export const AUDIENCE_ENTITY_FLAG_PRESENCE = 0x8000
export const AUDIENCE_HISTORY_SLOTS = 3
export const AUDIENCE_HISTORY_MIN_SAMPLES = 2
export const AUDIENCE_HISTORY_TOLERANCE_SECONDS = 3.0
export const AUDIENCE_OUT_OF_ORDER_TOLERANCE_SECONDS = 5.0
export const PAGE_SEGMENTS = 4
const pageSizeOf = (entityLimit, segments) =>
  Math.floor((segments + entityLimit - 1) / segments)
export class AudienceBarn {
  constructor ({
    entityLimit = AUDIENCE_MAX_ENTITY,
    pageSegments = PAGE_SEGMENTS,
    logger = console,
    clock = null
  } = {}) {
    this.entityLimit = entityLimit
    this.pageSegments = Math.max(1, Math.floor(pageSegments))
    this.logger = logger
    // Seconds-resolution clock of the node that OWNS this barn. When set,
    // every sample is clamped into this clock domain on write — cross-room
    // seats arrive stamped with the source node's wall clock, and an ahead
    // source would future-stamp them (see pushPosition).
    this.clock = typeof clock === 'function' ? clock : null
    this.entities = new Map()
    this.occupants = new Map()
    this.dirtyEntities = new Set()
    this.cursor = 0
    this.pageSize = pageSizeOf(this.entityLimit, this.pageSegments)
  }
  entityForSeat (eventId, benchId, seatId) {
    const index = this.#indexOf(benchId, seatId)
    if (!this.entities.has(index)) {
      this.entities.set(index, {
        entityIdx: index,
        active: true,
        hasData: true,
        eventId,
        benchId,
        seatId,
        playerId: null,
        flags: AUDIENCE_ENTITY_FLAGS_OUTSIDE_ROOM,
        flag7: 0,
        type: 0,
        extra: null,
        position: null,
        history: [null, null, null],
        historyCursor: 0,
        updatedAt: 0
      })
      this.dirtyEntities.add(index)
    }
    return index
  }
  #indexOf (benchId, seatId) {
    const bench = Number(benchId)
    const seat = Number(seatId)
    if (!Number.isInteger(bench) || !Number.isInteger(seat)) {
      throw new Error(`invalid seat: bench=${benchId} seat=${seatId}`)
    }
    if (
      bench < 0 ||
      bench >= BENCH_COUNT ||
      seat < 0 ||
      seat >= SEATS_PER_BENCH
    ) {
      throw new Error(`seat out of range: bench=${bench} seat=${seat}`)
    }
    return bench * SEATS_PER_BENCH + seat + 1
  }
  occupySeat ({
    eventId,
    benchId,
    seatId,
    playerId,
    levelTime,
    position,
    hasData = true,
    ...entity
  }) {
    const index = this.entityForSeat(eventId, benchId, seatId)
    // One entity per player: re-assignment (seat move, manager restart
    // rebuild, remote snapshot relocation) must retire the previous entity,
    // otherwise the stale seat keeps rendering as a badminton-bird silhouette
    // that follows the player — feedLocalPositions and getEntityForPlayer
    // resolve owners by first map match, so the ghost would keep receiving
    // live positions forever.
    for (const [owned, owner] of this.occupants) {
      if (owner !== playerId || owned === index) continue
      this.entities.delete(owned)
      this.occupants.delete(owned)
      this.dirtyEntities.delete(owned)
    }
    const existing = this.entities.get(index)
    const next = {
      ...existing,
      entityIdx: index,
      active: true,
      hasData,
      eventId,
      benchId,
      seatId,
      playerId,
      flag7: 0,
      type: 0,
      extra: null,
      ...entity
    }
    this.entities.set(index, next)
    this.occupants.set(index, playerId)
    this.dirtyEntities.add(index)
    if (position) next.position = [...position]
    if (position) {
      const t = levelTime ?? 0
      this.pushPosition(index, position, t)
      this.pushPosition(index, position, t)
    }
    return index
  }
  /**
   * Clamp an inbound sample's timestamp into THIS node's clock domain.
   *
   * Client rejection rule (sub_114556C): a sample whose levelTime sits in the
   * past window (-5s, 0) relative to the entity's previous stamp is dropped,
   * and `latestPosition` skips any slot stamped ahead of the query time. A
   * remote seat stamped with the SOURCE node's wall clock therefore breaks
   * asymmetrically: a source running ahead future-stamps the ghost here, and
   * every query below `now` returns null -> the bird never renders (the
   * one-way-visibility bug); a source running behind self-heals on the next
   * resample. Clamping inbound stamps to local now (never backwards past the
   * entity's own newest sample, which is the out-of-order guard's job) makes
   * every query resolvable.
   */
  #clampLevelTime (levelTime) {
    const raw = Number(levelTime)
    if (!Number.isFinite(raw) || this.clock === null) return raw
    const now = this.clock()
    return raw > now ? now : raw
  }

  pushPosition (
    index,
    position,
    levelTime,
    { valid = true, markDirty = true } = {}
  ) {
    const entity = this.entities.get(index)
    if (!entity) return false
    const stamped = this.#clampLevelTime(levelTime)
    const newest = entity.history[entity.historyCursor % AUDIENCE_HISTORY_SLOTS]
    const reference = newest?.time ?? entity.updatedAt ?? 0
    if (stamped < reference - AUDIENCE_OUT_OF_ORDER_TOLERANCE_SECONDS)
      return false
    if (
      stamped === reference &&
      newest &&
      entity.sampleCount >= AUDIENCE_HISTORY_MIN_SAMPLES
    )
      return false
    const cursor = entity.historyCursor
    entity.history[cursor % AUDIENCE_HISTORY_SLOTS] = {
      time: stamped,
      position: [...position],
      valid
    }
    entity.historyCursor = (cursor + 1) % AUDIENCE_HISTORY_SLOTS
    entity.sampleCount = Math.min(
      (entity.sampleCount ?? 0) + 1,
      AUDIENCE_HISTORY_SLOTS * 2
    )
    entity.updatedAt = stamped
    entity.position = [...position]
    if (markDirty) this.dirtyEntities.add(index)
    return true
  }
  latestPosition (index, levelTime) {
    const entity = this.entities.get(index)
    if (!entity) return null
    if ((entity.sampleCount ?? 0) < AUDIENCE_HISTORY_MIN_SAMPLES) return null
    for (let step = 0; step < AUDIENCE_HISTORY_SLOTS; step += 1) {
      const slotIndex =
        (entity.historyCursor - 1 - step + AUDIENCE_HISTORY_SLOTS * 2) %
        AUDIENCE_HISTORY_SLOTS
      const slot = entity.history[slotIndex]
      if (!slot) continue
      if (levelTime < slot.time) continue
      if (levelTime - slot.time > AUDIENCE_HISTORY_TOLERANCE_SECONDS) continue
      if (slot.valid === false) return null
      return slot.position
    }
    return null
  }
  releaseSeat (eventId, benchId, seatId) {
    const index = this.#indexOf(benchId, seatId)
    const entity = this.entities.get(index)
    if (!entity) return false
    this.entities.delete(index)
    this.occupants.delete(index)
    this.dirtyEntities.delete(index)
    return true
  }
  getEntity (index) {
    return this.entities.get(index)
  }
  getEntityForPlayer (playerId) {
    for (const [index, owner] of this.occupants) {
      if (owner === playerId) return this.entities.get(index)
    }
    return undefined
  }
  roomMemberIndices (eventId, seatAssignments) {
    const members = []
    for (const assignment of seatAssignments) {
      const index = this.entityForSeat(
        eventId,
        assignment.benchId,
        assignment.seatId
      )
      members.push(index)
      if (members.length >= AUDIENCE_ROOM_MEMBER_LIMIT) break
    }
    return members
  }
  benchMemberIndices (eventId, benchId) {
    const bench = Number(benchId)
    if (!Number.isInteger(bench) || bench < 0 || bench >= BENCH_COUNT) return []
    const members = []
    for (let seatId = 0; seatId < SEATS_PER_BENCH; seatId += 1) {
      const index = this.#indexOf(bench, seatId)
      const entity = this.entities.get(index)
      if (entity?.playerId) members.push(index)
      if (members.length >= AUDIENCE_ROOM_MEMBER_LIMIT) break
    }
    return members
  }
  suggestOrigin () {
    return computeOrigin(this)
  }
  currentSegment () {
    const pageStart = this.cursor * this.pageSize
    const pageEnd = Math.min(
      (this.cursor + 1) * this.pageSize,
      this.entityLimit
    )
    this.cursor = (this.cursor + 1) % this.pageSegments
    return { pageStart, pageEnd }
  }
  buildFrames (options = {}) {
    return shapeFrames(this, options)
  }
  segmentEntities (pageStart, pageEnd) {
    const records = []
    for (let index = pageStart; index < pageEnd; index += 1) {
      const entity = this.entities.get(index)
      if (entity) records.push(entity)
    }
    return records
  }
  buildFrame (options) {
    return shapeFrame(this, options)
  }
  buildProfileChunks (options = {}) {
    return shapeProfileChunks(this, options)
  }
  /**
   * Keep remote entities' history rings from aging out between manager
   * snapshots.
   *
   * A remote seat's position only updates when the manager reports a move, so
   * an idle one would go stale past the client's tolerance and vanish. This
   * re-stamps the clock — it must NOT push the old position as a fresh sample
   * every call, though: doing that at the frame cadence made a moving bird's
   * newest sample repeatedly a 3-second-old position, so clients interpolated
   * to a constant lag and every silhouette crawled.
   *
   * Pushing the same position at the same instant is a no-op in `pushPosition`
   * anyway (duplicate-time guard), so this now only fires when the newest
   * sample is actually older than this tick's time.
   */
  resampleAll (levelTime) {
    let sampled = 0
    for (const [index, entity] of this.entities) {
      if (!entity.position) continue
      if (!Number.isFinite(entity.position[0])) continue
      if (entity.updatedAt >= levelTime) continue
      if (
        this.pushPosition(index, entity.position, levelTime, {
          markDirty: false
        })
      )
        sampled += 1
    }
    return sampled
  }
  sweepStale (olderThanMs, now = Date.now()) {
    let removed = 0
    for (const [index, entity] of this.entities) {
      if (entity.touchedAt && now - entity.touchedAt < olderThanMs) continue
      if (!entity.playerId) continue
      this.entities.delete(index)
      this.occupants.delete(index)
      this.dirtyEntities.delete(index)
      removed += 1
    }
    return removed
  }
  forgetPlayer (playerId) {
    for (const [index, owner] of this.occupants) {
      if (owner !== playerId) continue
      this.entities.delete(index)
      this.occupants.delete(index)
      this.dirtyEntities.delete(index)
    }
  }
  stats () {
    return {
      entities: this.entities.size,
      seats: this.entities.size,
      occupants: this.occupants.size,
      dirty: this.dirtyEntities.size,
      pageSize: this.pageSize,
      pageSegments: this.pageSegments,
      cursor: this.cursor,
      entityBytesFull: AUDIENCE_ENTITY_FULL_BYTES,
      entityBytesLight: AUDIENCE_ENTITY_LIGHT_BYTES
    }
  }
}
export {
  AUDIENCE_MAX_ENTITY,
  AUDIENCE_MAX_ENTITY_INDEX,
  AUDIENCE_ROOM_MEMBER_LIMIT,
  estimateFrameBytes
}
