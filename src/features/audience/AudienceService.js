import {
  AudienceBarn,
  AUDIENCE_MAX_ENTITY_INDEX,
  AUDIENCE_ENTITY_FLAG_IN_ROOM,
  AUDIENCE_ENTITY_FLAGS_OUTSIDE_ROOM
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
import { AudienceSocial } from './AudienceSocial.js'
import { profileF0Of } from './AudienceFrames.js'
import { identityHashOfPlayerId } from '../../protocol/identityHash.js'
export class AudienceService {
  constructor ({
    barn,
    sendToClient,
    onPositionChanged,
    performance,
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
    this.performance = performance
    this.idleStreamInfo = defaultStreamInfo()
    this.spotlightPerformers = new Map()
    this.performanceStates = new Map()
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
    // Fully trusts QWD: seat.assign arrives only for levels the manager
    // configured as seated venues.
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
    await this.chatGlobalService?.sendToPlayerOnSeat(playerId, levelId)
    return { entityIdx, memberIndices }
  }
  #isSeatedInVenue (playerId, roster) {
    if (typeof this.currentLevelOf !== 'function') return true
    const liveLevel = this.currentLevelOf(playerId)
    if (liveLevel === undefined || liveLevel === null) return false
    return liveLevel === roster.levelId
  }
  forgetPlayer (playerId) {
    const session = this.liveBroadcastService?.sessionOf(playerId)
    if (session) this.liveBroadcastService.uploads.delete(session)
    this.barn.forgetPlayer(playerId)
    this.rosters.delete(playerId)
  }
  applyRemoteSnapshot (levelId, seats, { full = false } = {}) {
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
        flags: AUDIENCE_ENTITY_FLAGS_OUTSIDE_ROOM
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
    if (this.frameInFlight) return { skipped: true, reason: 'in_flight' }
    if (!Number.isFinite(levelTime) || (this.lastFrameStartedAt !== undefined && levelTime <= this.lastFrameStartedAt)) {
      return { skipped: true, reason: 'non_increasing_time' }
    }
    this.frameInFlight = true
    this.lastFrameStartedAt = levelTime
    try { return await this.broadcastNormalFrame(levelTime, origin) } finally { this.frameInFlight = false }
  }
  async broadcastNormalFrame (levelTime, origin) {
    const resampled = this.barn.resampleAll(levelTime)
    const frameOrigin = origin ?? this.barn.suggestOrigin()
    let framesSent = 0
    let activeTotal = 0
    let dataRecords = 0
    const windowStart = this.profileCursor
    this.profileCursor =
      (this.profileCursor + this.profileWindow) %
      (AUDIENCE_MAX_ENTITY_INDEX + 1)
    // Freeze every recipient's normal motion frames before the first await.
    // Later seat snapshots/pulses cannot inject a different position/time into
    // this frame transaction while profiles or transport sends are awaited.
    const plans = [...this.rosters].filter(([playerId, roster]) => this.#isSeatedInVenue(playerId, roster)).map(([playerId, roster]) => {
      const roomIndices = this.#roomIndicesFor(playerId, roster)
      const frames = this.barn.buildFrames({ memberIndices: roomIndices, levelTime, origin: [...frameOrigin],
        byteBudget: this.byteBudget, reserveReactionData: true }).map(frame => ({ ...frame,
        entities: frame.entities.map(entity => ({ ...entity, ...(entity.position ? { position: [...entity.position] } : {}) })) }))
      return { playerId, roster, roomIndices, frames, pulses: this.reactions?.prepare(playerId, roster.levelId) ?? new Map() }
    })
    for (const { playerId, roster, roomIndices, frames, pulses } of plans) {
      if (this.rosters.get(playerId) !== roster || !this.#isSeatedInVenue(playerId, roster)) continue
      try {
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
      for (const chunk of this.barn.buildProfileChunks({
        memberIndices: roomIndices,
        limit: this.profileChunkSize,
        budget: this.profileWindow,
        rangeStart: windowStart,
        rangeLength: this.profileWindow
      })) {
        await this.sendToClient(playerId, {
          id: AudiencePacketId.AudienceReliableData,
          payload: chunk
        })
      }
      for (const baseline of frames) {
        const transactions = []
        const entities = baseline.entities.map((entity, offset) => {
          const transaction = pulses.get(baseline.idxStart + offset)
          if (!entity.active || !transaction || !this.reactions.usable(transaction) || entity.type === 14 || entity.type === 15) return entity
          transactions.push(transaction)
          return { ...entity, dataPresent: true, resetEntity: false,
            flag7: transaction.entry.data.reaction.flag7, type: transaction.entry.data.reaction.type }
        })
        for (const transaction of transactions) {
          const profileBarn = Object.create(this.barn)
          profileBarn.entities = new Map([[transaction.entity.entityIdx, transaction.entity]])
          profileBarn.dirtyEntities = new Set([transaction.entity.entityIdx])
          for (const chunk of profileBarn.buildProfileChunks({ limit: 1, budget: 1 })) {
            const result = await this.sendToClient(playerId, { id: AudiencePacketId.AudienceReliableData, payload: chunk })
            if (result === false || (typeof result === 'number' && result < 0)) throw new Error('reaction profile send rejected')
          }
        }
        // A session may have ended or the TTL may have elapsed during profile
        // output. Restore only the event fields; motion remains the frozen frame.
        const committed = transactions.filter(transaction => this.reactions.usable(transaction))
        const valid = new Set(committed)
        for (let offset = 0; offset < entities.length; offset++) {
          const transaction = pulses.get(baseline.idxStart + offset)
          if (transaction && !valid.has(transaction)) entities[offset] = baseline.entities[offset]
        }
        const result = await this.sendToClient(playerId, { id: AudiencePacketId.Audience, payload: { ...baseline, entities } })
        if (result === false || (typeof result === 'number' && result < 0)) throw new Error('audience frame send rejected')
        this.reactions?.commit(committed)
      }
      framesSent += frames.length
      for (const frame of frames) {
        for (const entity of frame.entities) {
          if (!entity.active) continue
          activeTotal += 1
          if (entity.dataPresent) dataRecords += 1
        }
      }
      } catch (error) {
        this.logger.debug?.({ err: error, playerId }, 'normal audience frame recipient failed; pulse remains pending')
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
          dataRecords,
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
    const roster = this.rosters.get(playerId)
    if (!this.performance?.validSource(session, roster.levelId, payload?.levelChangeCount)) return
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
    decoded.generation = payload.levelChangeCount
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
    if (!roster || !this.performance) return false
    const formal = this.performance.current(roster.levelId)?.performerId === playerId
    if (formal) this.liveBroadcastService?.uploads.delete(session)
    const publisher = formal ? this.performance : this.liveBroadcastService
    const accepted = await publisher?.publishContent(session, request, request.generation) ?? false
    if (accepted) this.stats.socialRelays = (this.stats.socialRelays ?? 0) + 1
    return accepted
  }
  async broadcastPerformance ({
    sessionId,
    prefix = Buffer.alloc(0),
    time,
    counter,
    json,
    exceptPlayerId,
    levelId,
    submitted = new Set(),
    recipientKey = playerId => playerId,
    recipientValid = () => true
  }) {
    const payload = {
      sessionId:
        typeof sessionId === 'bigint' ? sessionId : BigInt(sessionId ?? 0),
      prefix,
      time: time ?? this.clock(),
      counter: counter ?? 0,
      json
    }
    let sent = 0
    for (const [playerId, roster] of this.rosters) {
      if (exceptPlayerId && playerId === exceptPlayerId) continue
      if (!this.#isSeatedInVenue(playerId, roster)) continue
      if (levelId !== undefined && roster.levelId !== levelId) continue
      const key = recipientKey(playerId)
      if (submitted.has(key) || !recipientValid(playerId)) continue
      const result = await this.sendToClient(playerId, {
        id: AudiencePacketId.SocialBroadcastDown,
        payload
      })
      // sky-enet returns 0 when queued successfully and a negative code on
      // failure. Boolean adapters may reject explicitly; void test callbacks
      // retain their existing successful-completion contract.
      if (result === false || (typeof result === 'number' && result < 0)) {
        throw new Error('performance client send rejected')
      }
      submitted.add(key)
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
  async sendChatGlobalState (levelId, state, { playerId: onlyPlayerId } = {}) {
    const enabled = state?.enabled === true
    const packet = {
      id: AudiencePacketId.AudienceChatDownReliable,
      payload: {
        messages: [{
          entityId: enabled
            ? AudienceChatEntityId.SetFloatParam
            : AudienceChatEntityId.ClearBroadcast,
          payload: enabled
            ? Buffer.from(String(state.remainingSeconds))
            : Buffer.alloc(0)
        }]
      }
    }
    let sent = 0
    let firstError
    for (const [playerId, roster] of this.rosters) {
      if (onlyPlayerId !== undefined && playerId !== onlyPlayerId) continue
      if (roster.levelId !== levelId || !this.#isSeatedInVenue(playerId, roster)) continue
      try {
        const result = await this.sendToClient(playerId, packet)
        if (result === false || (typeof result === 'number' && result < 0)) {
          throw new Error('global chat client send rejected')
        }
        sent += 1
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
    return sent
  }
  async handleChat (session, { messages = [] }) {
    const entityId = this.#entityOf(playerIdOf(session))
    for (const message of messages) {
      await this.broadcastChat({
        entityId,
        payload: message.text,
        reliable: true
      })
    }
  }
  async handleSpotlightRequest (session, { requested, generation }) {
    const playerId = playerIdOf(session)
    if (!playerId) return false
    if (!this.performance) {
      this.logger.warn?.({ playerId }, 'performance request rejected: QWD is not configured')
      await this.sendSpotlightResponse(playerId, false, false)
      return false
    }
    this.stats.spotlightRequests = (this.stats.spotlightRequests ?? 0) + 1
    return this.performance.request(session, requested === true, generation)
  }
  sendSpotlightResponse (playerId, accepted, released) {
    return this.sendToClient(playerId, {
      id: AudiencePacketId.AudienceSpotlightResponse,
      payload: { valid: accepted || released, accepted, released }
    })
  }
  performanceIdentity (playerId) { return identityHashOfPlayerId(playerId) ?? 0n }
  async clearBroadcast (levelId) {
    for (const [playerId, roster] of this.rosters) {
      if (roster.levelId !== levelId || !this.#isSeatedInVenue(playerId, roster)) continue
      await this.#sendPerformancePacket(playerId, {
        id: AudiencePacketId.AudienceChatDownReliable,
        payload: { messages: [{ entityId: AudienceChatEntityId.ClearBroadcast, payload: Buffer.alloc(0) }] }
      })
    }
  }
  async clearPerformance (levelId) {
    await this.applyPerformanceState(levelId, { current: null, preparing: null, queue: [] })
  }
  async applyPerformanceState (levelId, { current, preparing, queue }) {
    const previous = this.performanceStates.get(levelId)
    const oldPreparation = previous?.preparing
    if (oldPreparation && oldPreparation.preparationId !== preparing?.preparationId &&
      current?.performerId !== oldPreparation.performerId) {
      // id29 acknowledges a request; it cannot release native preparing state2.
      // Explicitly project no session/no queue for the previous preparer first,
      // even when the next preparation names the same player at queue index 0.
      // Reliable send order does not guarantee a render tick between these two
      // StreamInfos; no stronger client-side observation guarantee is claimed.
      const playerId = oldPreparation.performerId
      const roster = this.rosters.get(playerId)
      if (roster?.levelId === levelId && this.#isSeatedInVenue(playerId, roster)) {
        await this.#sendPerformancePacket(playerId, { id: AudiencePacketId.AudienceStreamInfo,
          payload: { ...this.idleStreamInfo, flags: this.#streamFlagsFor(playerId, this.idleStreamInfo), hasSession: false, hasStageEnd: true, stageEnd: 0xffff } })
      }
    }
    if (previous?.current && previous.current.sessionId !== current?.sessionId) await this.clearBroadcast(levelId)
    if (current) {
      const session = this.liveBroadcastService?.sessionOf(current.performerId)
      if (session) this.liveBroadcastService.uploads.delete(session)
    }
    this.performanceStates.set(levelId, { current, preparing, queue })
    if (current) this.spotlightPerformers.set(levelId, { ...current, playerId: current.performerId })
    else this.spotlightPerformers.delete(levelId)
    await this.sendPerformanceInfo(levelId)
  }
  async #sendPerformancePacket (playerId, packet) {
    const result = await this.sendToClient(playerId, packet)
    if (result === false || (typeof result === 'number' && result < 0)) throw new Error('performance client send rejected')
  }
  async sendPerformanceInfo (levelId) {
    for (const [playerId, roster] of this.rosters) {
      if (roster.levelId !== levelId || !this.#isSeatedInVenue(playerId, roster)) continue
      await this.#sendPerformancePacket(playerId, { id: AudiencePacketId.AudienceStreamInfo, payload: this.#streamInfoFor(playerId) })
    }
  }
  async preparePerformance (levelId, performerId, { recipientValid = () => true } = {}) {
    const entity = this.barn.getEntityForPlayer(performerId)
    if (!entity || !entity.position || entity.hasData === false || !identityHashOfPlayerId(performerId)) return false
    // Reliable identity profile precedes content; profile f68 and entity type14
    // are not performance state. Never overwrite genuine incoming reactions.
    for (const [playerId, roster] of this.rosters) {
      if (roster.levelId !== levelId || !this.#isSeatedInVenue(playerId, roster)) continue
      if (!recipientValid(playerId)) continue
      const profileBarn = Object.create(this.barn)
      profileBarn.entities = new Map([[entity.entityIdx, entity]])
      profileBarn.dirtyEntities = new Set([entity.entityIdx])
      for (const chunk of profileBarn.buildProfileChunks({ memberIndices: this.#roomIndicesFor(playerId, roster),
        limit: 1, budget: 1, rangeStart: entity.entityIdx, rangeLength: 1 })) {
        await this.#sendPerformancePacket(playerId, { id: AudiencePacketId.AudienceReliableData, payload: chunk })
      }
    }
    return true
  }
  #entityOf (playerId) {
    return this.barn.getEntityForPlayer(playerId)?.entityIdx ?? 0
  }
  #streamFlagsFor (playerId, base) {
    const flags = [...(base.flags ?? [false, false, false, false, false])]
    flags[2] = this.liveBroadcastService?.canPublish(playerId, this.rosters.get(playerId)?.levelId) === true
    flags[4] = false
    return flags
  }
  #streamInfoFor (playerId) {
    const base = this.streamInfo ?? this.idleStreamInfo
    const roster = this.rosters.get(playerId)
    const state = roster ? this.performanceStates.get(roster.levelId) : undefined
    const { current, preparing, queue = [] } = state ?? {}
    const queueIndex = current?.performerId === playerId ? -1 : queue.findIndex(entry => entry.playerId === playerId)
    const info = { ...base, flags: this.#streamFlagsFor(playerId, base), hasSession: false, sessionId: 0n,
      hasStageEnd: queueIndex >= 0, stageEnd: queueIndex >= 0 ? queueIndex : 0xffff }
    if (preparing) {
      info.startTime = (this.performance?.preparationDeadline?.(roster.levelId) ??
        (preparing.expiresAtMs - (this.performance?.offsets.get(roster.levelId) ?? 0))) / 1000
      info.hasStartTime = true
    } else if (current) {
      info.hasSession = true
      info.sessionId = profileF0Of(current.performerId)
      // Retain the legacy captured value without assigning it stage semantics.
      info.stage = 48
      info.hasStartTime = true
      info.startTime = (current.expiresAtMs - (this.performance?.offsets.get(roster.levelId) ?? 0) +
        (current.performerId === playerId ? 5000 : 0)) / 1000
    }
    return info
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
      if (entity.levelId !== levelId) continue
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
 * Captured stage 44 and stageStart 90 are retained; their exact semantics
 * remain unknown. startTime is a deadline, not a session start. Idle uses a
 * stable inactive value; active deadlines come only from QWD authority.
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
