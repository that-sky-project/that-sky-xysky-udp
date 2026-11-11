import {
  AudienceBarn,
  AUDIENCE_MAX_ENTITY_INDEX,
  AUDIENCE_ENTITY_FLAG_IN_ROOM,
  AUDIENCE_ENTITY_FLAGS_OUTSIDE_ROOM,
  AUDIENCE_ENTITY_TYPE_SPOTLIGHT,
  AUDIENCE_SPOTLIGHT_STAGE_MID,
  AUDIENCE_SPOTLIGHT_EXTRA_FLAG,
  AUDIENCE_STAGE_ON_STAGE
} from './AudienceBarn.js'
import {
  AudiencePacketId,
  AudienceGameMsgType,
  AudienceChatEntityId,
  AUDIENCE_ROOM_MEMBER_LIMIT
} from '../../protocol/types/Audience.js'
import { audienceRequestPayloads } from '../../protocol/packets/client/AudienceRequests.js'
import { TgcUuid } from '../../protocol/types/TgcUuid.js'
import { BinaryReader } from '../../protocol/binary/BinaryReader.js'
import { isAudienceLevel } from './AudienceLevels.js'
import { AudienceSocial } from './AudienceSocial.js'
import { profileF0Of } from './AudienceFrames.js'
import { identityHashOfPlayerId } from '../../protocol/identityHash.js'
export class AudienceService {
  constructor ({
    barn,
    sendToClient,
    onPositionChanged,
    onSpotlightChanged,
    currentLevelOf,
    logger = console,
    clock = () => Date.now(),
    packetDebug,
    barnClock
  } = {}) {
    // The barn's clock domain IS the frame clock domain: broadcastFrame is
    // called with Date.now()/1000 and latestPosition is queried at that same
    // levelTime, so clamping inbound samples (remote seats, telemetry) to the
    // same clock keeps them resolvable regardless of the source node's skew.
    this.barn =
      barn ?? new AudienceBarn({ logger, clock: barnClock ?? (() => Date.now() / 1000) })
    this.sendToClient = sendToClient
    this.packetDebug = packetDebug
    this.onPositionChanged = onPositionChanged
    this.onSpotlightChanged = onSpotlightChanged
    this.spotlightPerformers = new Map()
    this.currentLevelOf = currentLevelOf
    this.logger = logger
    this.clock = clock
    this.rosters = new Map()
    this.stats = {
      frames: 0,
      roomTags: 0,
      chatRouted: 0,
      consensusBroadcasts: 0
    }
    this.social = new AudienceSocial({
      rosters: this.rosters,
      sendToClient: (playerId, packet) => this.sendToClient(playerId, packet),
      stats: this.stats
    })
    this.lastLevelTime = 0
    this.byteBudget = 630
    this.profileChunkSize = 25
    this.profileWindow = 50
    this.profileCursor = 0
    this.timeline = null
    this.timelineStep = 2.5
    this.lastConsensusAt = 0
    this.roomTail = Math.floor(this.clock() / 1000) & 0x1f
  }
  async seatPlayer ({
    playerId,
    levelId,
    benchId,
    seatId,
    roomMembers,
    position,
    levelTime,
    entity = {}
  }) {
    if (!isAudienceLevel(levelId)) {
      this.logger.info(
        { playerId, levelId, benchId, seatId },
        'seatPlayer refused: level does not run the audience system'
      )
      return null
    }
    this.logger.info(
      { playerId, levelId, benchId, seatId, position, levelTime },
      'seatPlayer'
    )
    const entityIdx = this.barn.occupySeat({
      levelId,
      benchId,
      seatId,
      playerId,
      position,
      levelTime,
      flags: AUDIENCE_ENTITY_FLAG_IN_ROOM,
      ...entity
    })
    const occupants = this.barn.benchMemberIndices(levelId, benchId)
    const explicit =
      Array.isArray(roomMembers) && roomMembers.length > 0
        ? this.barn.roomMemberIndices(levelId, roomMembers)
        : []
    let memberIndices = []
    for (const index of [entityIdx, ...occupants, ...explicit]) {
      if (!memberIndices.includes(index)) memberIndices.push(index)
    }
    const hasPosition =
      Array.isArray(position) &&
      position.length >= 3 &&
      position.every(value => Number.isFinite(value))
    this.rosters.set(playerId, {
      levelId,
      benchId,
      seatId,
      roomMembers: memberIndices,
      lastReported: hasPosition
        ? [position[0], position[1], position[2]]
        : null,
      pendingHandshake: !hasPosition
    })
    await this.#sendFeatureFlags(playerId)
    if (hasPosition) await this.#sendRoomIds(playerId, memberIndices)
    return { entityIdx, memberIndices }
  }
  #isSeatedInVenue (playerId, roster) {
    if (!isAudienceLevel(roster.levelId)) return false
    if (typeof this.currentLevelOf !== 'function') return true
    const liveLevel = this.currentLevelOf(playerId)
    if (liveLevel === undefined || liveLevel === null) return false
    return isAudienceLevel(liveLevel)
  }
  forgetPlayer (playerId) {
    this.barn.forgetPlayer(playerId)
    this.rosters.delete(playerId)
  }
  applyRemoteSnapshot (levelId, seats, { full = false } = {}) {
    if (!isAudienceLevel(levelId)) {
      this.logger.debug?.(
        { levelId, seats: seats.length },
        'remote snapshot ignored: level without audience'
      )
      return 0
    }
    const now = Date.now() / 1000
    let applied = 0
    const localBenches = this.#localBenches()
    if (full) {
      this.#dropGhosts(levelId, seats, localBenches)
    }
    for (const seat of seats) {
      const playerId = String(seat?.playerId ?? '')
      const benchId = Number(seat?.benchId)
      const seatId = Number(seat?.seatId)
      if (!playerId || !Number.isInteger(benchId) || !Number.isInteger(seatId))
        continue
      if (this.rosters.has(playerId)) continue
      if (localBenches.has(benchId)) continue
      const position =
        Array.isArray(seat.position) && seat.position.length >= 3
          ? [
              Number(seat.position[0]),
              Number(seat.position[1]),
              Number(seat.position[2])
            ]
          : null
      if (!position || position.some(v => !Number.isFinite(v))) continue
      const levelTime = Number(seat.levelTime) || now
      const entityIdx = this.barn.occupySeat({
        levelId,
        benchId,
        seatId,
        playerId,
        position,
        levelTime,
        flags: AUDIENCE_ENTITY_FLAGS_OUTSIDE_ROOM,
        ...(seat.spotlight === true
          ? {
              type: AUDIENCE_ENTITY_TYPE_SPOTLIGHT,
              extraVal: AUDIENCE_SPOTLIGHT_STAGE_MID,
              extra: AUDIENCE_SPOTLIGHT_EXTRA_FLAG,
              stageState: AUDIENCE_STAGE_ON_STAGE
            }
          : {})
      })
      this.barn.pushPosition(entityIdx, position, levelTime)
      applied += 1
    }
    this.stats.remoteSeats = applied
    return applied
  }
  feedLocalPositions (levelTime, positionOf) {
    if (typeof positionOf !== 'function') return
    for (const [playerId, roster] of this.rosters) {
      const position = positionOf(playerId)
      if (!position) continue
      const entity = this.barn.getEntityForPlayer(playerId)
      if (!entity) continue
      this.barn.pushPosition(entity.entityIdx, position, levelTime)
      if (
        this.onPositionChanged &&
        movedEnough(roster.lastReported, position)
      ) {
        roster.lastReported = [position[0], position[1], position[2]]
        this.onPositionChanged(playerId, roster, position, levelTime)
      }
    }
  }
  async broadcastFrame (levelTime = 0, origin) {
    const resampled = this.barn.resampleAll(levelTime)
    const frameOrigin = origin ?? this.barn.suggestOrigin()
    let framesSent = 0
    let activeTotal = 0
    let inRoomTotal = 0
    const windowStart = this.profileCursor
    this.profileCursor =
      (this.profileCursor + this.profileWindow) %
      (AUDIENCE_MAX_ENTITY_INDEX + 1)
    for (const [playerId, roster] of this.rosters) {
      if (!this.#isSeatedInVenue(playerId, roster)) continue
      const roomIndices = this.#roomIndicesFor(playerId, roster)
      if (roster.pendingHandshake) {
        const entity = this.barn.getEntityForPlayer(playerId)
        if (!entity || !this.barn.latestPosition(entity.entityIdx, levelTime))
          continue
        await this.#sendRoomIds(playerId, roomIndices)
        roster.pendingHandshake = false
      }
      await this.sendToClient(playerId, {
        id: AudiencePacketId.AudienceRoomIds,
        payload: { indices: roomIndices, tail: this.roomTail }
      })
      await this.sendToClient(playerId, {
        id: AudiencePacketId.AudienceStreamInfo,
        payload: this.#streamInfoFor(playerId)
      })
      const onStageIds = new Set(
        [...this.spotlightPerformers.values()].map(state => state.playerId)
      )
      for (const chunk of this.barn.buildProfileChunks({
        memberIndices: roomIndices,
        limit: this.profileChunkSize,
        budget: this.profileWindow,
        rangeStart: windowStart,
        rangeLength: this.profileWindow,
        nowSeconds: levelTime,
        onStagePlayerIds: onStageIds
      })) {
        await this.sendToClient(playerId, {
          id: AudiencePacketId.AudienceReliableData,
          payload: chunk
        })
      }
      const frames = this.barn.buildFrames({
        memberIndices: roomIndices,
        levelTime,
        origin: frameOrigin,
        byteBudget: this.byteBudget
      })
      for (const frame of frames) {
        await this.sendToClient(playerId, {
          id: AudiencePacketId.Audience,
          payload: frame
        })
      }
      framesSent += frames.length
      for (const frame of frames) {
        for (const entity of frame.entities) {
          if (!entity.active) continue
          activeTotal += 1
          if (entity.commitRecord) inRoomTotal += 1
        }
      }
    }
    this.stats.frames += framesSent
    this.stats.audienceFramesSent =
      (this.stats.audienceFramesSent ?? 0) + framesSent
    this.lastLevelTime = levelTime
    this.frameCounter = (this.frameCounter ?? 0) + 1
    if (this.packetDebug?.isEnabled({ id: AudiencePacketId.Audience })) {
      const probe = [...this.barn.entities.values()].find(
        entity => entity.playerId
      )
      this.logger.debug(
        {
          frames: framesSent,
          rosters: this.rosters.size,
          active: activeTotal,
          inRoom: inRoomTotal,
          barnEntities: this.barn.entities.size,
          resampled,
          origin: frameOrigin,
          probe: probe
            ? {
                entityIdx: probe.entityIdx,
                samples: probe.sampleCount,
                updatedAt: probe.updatedAt,
                levelTime,
                age: levelTime - probe.updatedAt
              }
            : null
        },
        'audience frame sent'
      )
    }
  }
  advanceTimeline (now = this.clock() / 1000) {
    const step = this.timelineStep
    if (this.timeline === null) {
      this.timeline = { start: Math.floor(now / step) * step }
    } else {
      this.timeline.start += step
      while (this.timeline.start + step <= now) this.timeline.start += step
    }
    return {
      start: this.timeline.start,
      end: this.timeline.start + step
      // Optional blocks (struct / 4 consensus floats / 9 vec4s) stay absent:
      // the official capture carries bare 2.5 s windows, and a populated
      // float needs a real consensus source (AudienceConsensusVote) first.
    }
  }
  async broadcastTimeline (now = this.clock() / 1000) {
    if (this.rosters.size === 0) return 0
    const window = this.advanceTimeline(now)
    let sent = 0
    for (const [playerId, roster] of this.rosters) {
      if (!this.#isSeatedInVenue(playerId, roster)) continue
      await this.sendToClient(playerId, {
        id: AudiencePacketId.AudienceConsensus,
        payload: window
      })
      sent += 1
    }
    if (sent > 0) {
      this.stats.consensusBroadcasts = (this.stats.consensusBroadcasts ?? 0) + 1
      this.lastConsensusAt = now
    }
    return sent
  }
  async broadcastConsensus (consensus) {
    return this.social.broadcastConsensus(consensus)
  }
  async broadcastChat (options) {
    return this.social.broadcastChat(options)
  }
  async broadcastPresence (recipientId, matches) {
    return this.social.broadcastPresence(recipientId, matches)
  }
  #rosterForEntity (entityId) {
    return this.social.rosterForEntity(entityId)
  }
  #roommatesOf (roster) {
    return this.social.roommatesOf(roster)
  }
  async handleRequest (session, payload) {
    const playerId = playerIdOf(session)
    if (!playerId || !this.rosters.has(playerId)) return
    const type = payload?.type
    const schema = audienceRequestPayloads.get(type)
    if (!schema) {
      this.logger.debug?.(
        { playerId, type },
        'ignored unknown audience request'
      )
      return
    }
    let decoded
    try {
      decoded = schema.decode(
        new BinaryReader(payload.payloadBytes ?? Buffer.alloc(0))
      )
    } catch (error) {
      this.logger.warn?.(
        { err: error, playerId, type },
        'failed to decode audience request'
      )
      return
    }
    switch (type) {
      case AudienceGameMsgType.Hint:
        return this.handleHint(session, decoded)
      case AudienceGameMsgType.SocialBroadcast:
        return this.handleSocialBroadcast(session, decoded)
      case AudienceGameMsgType.ConsensusVote:
        return this.handleConsensusVote(session, decoded)
      case AudienceGameMsgType.Chat:
        return this.handleChat(session, decoded)
      case AudienceGameMsgType.SpotlightRequest:
        return this.handleSpotlightRequest(session, decoded)
      default:
        return undefined
    }
  }
  async handleHint (session, { entityIndices = [] }) {
    const roster = this.rosters.get(playerIdOf(session))
    if (!roster) return
    if (entityIndices.length > 0) roster.nearby = entityIndices.slice(0, 0xff)
    else roster.nearby = []
    roster.lastHintAt = this.clock()
    this.stats.hints = (this.stats.hints ?? 0) + 1
  }
  async handleSocialBroadcast (session, request) {
    const playerId = playerIdOf(session)
    const roster = this.rosters.get(playerId)
    if (!roster) return
    const payload = request?.payload
    if (!payload || payload.length === 0) return
    if (this.spotlightPerformers.get(roster.levelId)?.playerId !== playerId) {
      this.stats.staleSocialDrops = (this.stats.staleSocialDrops ?? 0) + 1
      return
    }
    await this.broadcastPerformance({
      // The client binds the JSON action to the entity whose profile f0
      // equals this id and drops the packet when it matches its own hash
      // (sub_115BA7C). It must be the performer's identity hash — without it
      // the broadcast renders nowhere (the previous code omitted sessionId,
      // so every client received id=0 and matched no entity).
      sessionId: identityHashOfPlayerId(playerId) ?? 0n,
      time: request.timestamp,
      counter: request.actionId,
      json: payload,
      levelId: roster.levelId
    })
    this.stats.socialRelays = (this.stats.socialRelays ?? 0) + 1
    this.logger.debug?.(
      { playerId, actionId: request?.actionId, bytes: payload.length },
      'relayed social broadcast to the hall (packet 24)'
    )
  }
  async broadcastPerformance ({
    sessionId,
    flags = 0,
    time,
    counter,
    json,
    exceptPlayerId,
    levelId
  }) {
    const payload = {
      sessionId:
        typeof sessionId === 'bigint' ? sessionId : BigInt(sessionId ?? 0),
      flags,
      time: time ?? this.clock(),
      counter: counter ?? 0,
      json
    }
    let sent = 0
    for (const [playerId, roster] of this.rosters) {
      if (exceptPlayerId && playerId === exceptPlayerId) continue
      if (!this.#isSeatedInVenue(playerId, roster)) continue
      if (levelId !== undefined && roster.levelId !== levelId) continue
      await this.sendToClient(playerId, {
        id: AudiencePacketId.SocialBroadcastDown,
        payload
      })
      sent += 1
    }
    if (sent > 0)
      this.stats.performanceBroadcasts =
        (this.stats.performanceBroadcasts ?? 0) + 1
    return sent
  }
  async handleConsensusVote (session, vote) {
    this.lastVote = {
      playerId: playerIdOf(session),
      value: vote?.value ?? 0,
      at: this.clock()
    }
    this.stats.consensusVotes = (this.stats.consensusVotes ?? 0) + 1
  }
  async handleChat (session, { messages = [] }) {
    const entityId = this.#entityOf(playerIdOf(session))
    for (const message of messages) {
      await this.broadcastChat({
        entityId,
        payload: message.message,
        sender: message.sender,
        reliable: true
      })
    }
  }
  async handleSpotlightRequest (session, { requested }) {
    const playerId = playerIdOf(session)
    if (!playerId) return
    const granted = requested === true
    await this.sendToClient(playerId, {
      id: AudiencePacketId.AudienceSpotlightResponse,
      payload: { accepted: granted, released: !granted }
    })
    const roster = this.rosters.get(playerId)
    if (roster) {
      this.syncSpotlightState({
        levelId: roster.levelId,
        performerId: granted ? playerId : null
      })
      if (this.onSpotlightChanged) {
        this.onSpotlightChanged({
          levelId: roster.levelId,
          playerId,
          active: granted
        })
      }
    }
    this.stats.spotlightRequests = (this.stats.spotlightRequests ?? 0) + 1
  }
  applySpotlightChange ({ levelId, playerId, active }) {
    if (!isAudienceLevel(levelId)) return false
    if (active) {
      const existing = this.spotlightPerformers.get(levelId)
      if (existing?.playerId !== playerId) {
        this.spotlightPerformers.set(levelId, {
          playerId,
          startedAt: this.clock() / 1000
        })
      }
    } else if (this.spotlightPerformers.get(levelId)?.playerId === playerId) {
      this.spotlightPerformers.delete(levelId)
    }
    const changed = this.#setEntitySpotlight(playerId, active)
    if (changed)
      this.stats.spotlightChanges = (this.stats.spotlightChanges ?? 0) + 1
    return true
  }
  syncSpotlightState ({ levelId, performerId }) {
    if (!isAudienceLevel(levelId)) return false
    const previous = this.spotlightPerformers.get(levelId)
    if (!performerId) {
      if (!previous) return false
      this.#setEntitySpotlight(previous.playerId, false)
      this.spotlightPerformers.delete(levelId)
      this.stats.spotlightChanges = (this.stats.spotlightChanges ?? 0) + 1
      return true
    }
    if (previous?.playerId === performerId) return false
    if (previous) this.#setEntitySpotlight(previous.playerId, false)
    this.spotlightPerformers.set(levelId, {
      playerId: performerId,
      startedAt: this.clock() / 1000
    })
    this.#setEntitySpotlight(performerId, true)
    this.stats.spotlightChanges = (this.stats.spotlightChanges ?? 0) + 1
    return true
  }
  #setEntitySpotlight (playerId, active) {
    const entity = this.barn.getEntityForPlayer(playerId)
    if (!entity) return false
    if (active) {
      entity.type = AUDIENCE_ENTITY_TYPE_SPOTLIGHT
      entity.extraVal = AUDIENCE_SPOTLIGHT_STAGE_MID
      entity.extra = AUDIENCE_SPOTLIGHT_EXTRA_FLAG
      entity.stageState = AUDIENCE_STAGE_ON_STAGE
    } else {
      entity.type = 0
      entity.extraVal = 0
      entity.extra = null
      entity.stageState = 0
    }
    this.barn.dirtyEntities.add(entity.entityIdx)
    return true
  }
  #entityOf (playerId) {
    return this.barn.getEntityForPlayer(playerId)?.entityIdx ?? 0
  }
  #streamInfoFor (playerId) {
    const base = this.streamInfo ?? defaultStreamInfo()
    const roster = this.rosters.get(playerId)
    const performer = roster
      ? this.spotlightPerformers.get(roster.levelId)
      : undefined
    if (!performer) return base
    return {
      ...base,
      hasSession: true,
      sessionId: profileF0Of(performer.playerId),
      // `stage` is a venue-state index, NOT elapsed seconds: both official
      // captures carry free-running values (idle 44, active session 48) and
      // sub_10FE178 never compares it against anything — only stageStart
      // (!= 1) and stageEnd steer the state machine. The previous
      // Math.min(30, elapsed) turned the index into a 0..30 ramp, an
      // in-between venue state the level's performance markers do not
      // define — the phantom-position path (players landing under the stage
      // floor / in the water instead of the piano marker).
      stage: 48,
      startTime: performer.startedAt
    }
  }
  #localBenches () {
    const benches = new Set()
    for (const roster of this.rosters.values()) {
      if (Number.isInteger(roster.benchId)) benches.add(roster.benchId)
    }
    return benches
  }
  #dropGhosts (levelId, seats, localBenches) {
    const alive = new Set()
    for (const seat of seats) {
      const benchId = Number(seat?.benchId)
      const seatId = Number(seat?.seatId)
      if (Number.isInteger(benchId) && Number.isInteger(seatId)) {
        alive.add(`${benchId}:${seatId}`)
      }
    }
    for (const [index, entity] of this.barn.entities) {
      if (!entity.playerId) continue
      if (this.rosters.has(entity.playerId)) continue
      if (localBenches.has(entity.benchId)) continue
      if (alive.has(`${entity.benchId}:${entity.seatId}`)) continue
      this.barn.entities.delete(index)
      this.barn.occupants.delete(index)
      this.barn.dirtyEntities.delete(index)
    }
  }
  #roomIndicesFor (playerId, roster) {
    const occupants = this.barn.benchMemberIndices(
      roster.levelId,
      roster.benchId
    )
    const assigned = Array.isArray(roster.roomMembers) ? roster.roomMembers : []
    const ordered = []
    for (const index of [...occupants, ...assigned]) {
      if (!ordered.includes(index)) ordered.push(index)
    }
    const ownEntity = this.#entityOf(playerId)
    if (ownEntity && !ordered.includes(ownEntity)) ordered.unshift(ownEntity)
    return ordered.slice(0, AUDIENCE_ROOM_MEMBER_LIMIT)
  }
  async #sendFeatureFlags (playerId) {
    await this.sendToClient(playerId, {
      id: AudiencePacketId.AudienceFeatureFlags,
      payload: { b0: true, b1: true, b2: false, b3: false }
    })
    this.featureFlagsAnnounced = this.featureFlagsAnnounced ?? new Set()
    this.featureFlagsAnnounced.add(playerId)
  }
  async #sendRoomIds (playerId, memberIndices) {
    await this.sendToClient(playerId, {
      id: AudiencePacketId.AudienceRoomIds,
      payload: {
        indices: memberIndices.slice(0, AUDIENCE_ROOM_MEMBER_LIMIT),
        tail: this.roomTail
      }
    })
    this.stats.roomTags += 1
  }
  snapshot () {
    return {
      barn: this.barn.stats(),
      rosters: this.rosters.size,
      lastLevelTime: this.lastLevelTime,
      ...this.stats
    }
  }
}
function playerIdOf (session) {
  const uuid = session?.player?.uuid
  if (uuid && typeof uuid.toString === 'function') return uuid.toString()
  if (typeof session?.playerId === 'string') return session.playerId
  if (typeof session?.player?.id === 'string') return session.player.id
  return undefined
}
const POSITION_REPORT_EPSILON = 0.25
/**
 * Idle stream shape, from the official-server capture (test golden wire
 * '8280fa00...'): startIdx=129/endIdx=500 are the last window the show
 * rendered (stored values — the wire is signed-bounded, wire = stored+1),
 * stage 44 + stageStart 90 tell the client the venue is open but no session
 * is running, and startTime anchors the stage clock on a 30 s grid so every
 * client agrees on the current stage phase. Values are from the capture; do
 * not invent new magic numbers without one.
 */
function defaultStreamInfo () {
  return {
    startIdx: 129,
    hasStart: false,
    endIdx: 500,
    hasEnd: false,
    flags: [false, false, false, false, false],
    hasDetail: true,
    hasSession: false,
    hasStage: true,
    stage: 44,
    hasStageEnd: false,
    stageEnd: 0xffff,
    stageStart: 90,
    hasStartTime: true,
    startTime: Math.ceil(Date.now() / 30000) * 30,
    trailing: [false, false, false],
    extra: 0
  }
}
function movedEnough (previous, next) {
  if (!previous) return true
  return (
    Math.abs(previous[0] - next[0]) > POSITION_REPORT_EPSILON ||
    Math.abs(previous[1] - next[1]) > POSITION_REPORT_EPSILON ||
    Math.abs(previous[2] - next[2]) > POSITION_REPORT_EPSILON
  )
}
export {
  AudienceBarn,
  AUDIENCE_ROOM_MEMBER_LIMIT,
  movedEnough,
  playerIdOf,
  POSITION_REPORT_EPSILON
}
