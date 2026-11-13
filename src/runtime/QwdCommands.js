import { ErrorCode, fail, ok } from '../qwd/errorCodes.js'
import { TgcUuid } from '../protocol/types/TgcUuid.js'
import { destinationUuid } from './destinationUuid.js'
const seatAssign = {
  validate (data) {
    const playerId = String(data?.playerId ?? '')
    const benchId = Number(data?.benchId)
    const seatId = Number(data?.seatId)
    if (!playerId || !Number.isInteger(benchId) || !Number.isInteger(seatId)) {
      return fail(ErrorCode.BAD_REQUEST, 'invalid seat assignment')
    }
    return undefined
  },
  async handle (command, context) {
    const data = command.data ?? {}
    const playerId = String(data.playerId ?? '')
    const benchId = Number(data.benchId)
    const seatId = Number(data.seatId)
    const levelId = Number(data.levelId) || 0
    const roomMembers =
      Array.isArray(data.roomMembers) && data.roomMembers.length > 0
        ? data.roomMembers
            .map(member => ({
              benchId: Number(member?.benchId),
              seatId: Number(member?.seatId)
            }))
            .filter(
              member =>
                Number.isInteger(member.benchId) &&
                Number.isInteger(member.seatId)
            )
        : undefined
    const player = context.players.getByUuid(playerId)
    const position = player?.playerDelta?.decodedState?.fields?.position
    const levelTime = Date.now() / 1000
    const assigned = await context.audienceService.seatPlayer({
      playerId,
      levelId,
      benchId,
      seatId,
      roomMembers,
      position,
      levelTime
    })
    if (!assigned) {
      return ok({ accepted: false, reason: 'level_without_audience' })
    }
    context.qwd.publish('seat.occupied', {
      roomId: context.identity.id,
      player: { playerId },
      levelId,
      benchId,
      seatId,
      entityId: assigned.entityIdx,
      position,
      levelTime
    })
    return ok({ accepted: true, entityId: assigned.entityIdx })
  }
}
const audienceSnapshot = {
  async handle (command, context) {
    const data = command.data ?? {}
    const levelId = Number(data.levelId) || 0
    const seats = Array.isArray(data.seats) ? data.seats : []
    const removed = Array.isArray(data.removed) ? data.removed.map(String) : []
    for (const playerId of removed) {
      if (context.audienceService.rosters.has(playerId)) continue
      context.audienceService.barn.forgetPlayer(playerId)
    }
    const full = data.full === true
    const applied = context.audienceService.applyRemoteSnapshot(levelId, seats, {
      full
    })
    // Seating snapshots never establish performance authority. Only the
    // versioned performance.state/decision/deliver commands may do that.
    return ok({ accepted: true, applied, removed: removed.length })
  }
}
const seatRelease = {
  validate (data) {
    if (!String(data?.playerId ?? ''))
      return fail(ErrorCode.BAD_REQUEST, 'invalid seat release')
    return undefined
  },
  handle (command, context) {
    const playerId = String(command.data?.playerId ?? '')
    const roster = context.audienceService.rosters.get(playerId)
    context.audienceService.forgetPlayer(playerId)
    context.qwd.publish('seat.released', {
      roomId: context.identity.id,
      player: { playerId },
      levelId: roster?.levelId ?? 0,
      benchId: roster?.benchId,
      seatId: roster?.seatId
    })
    return ok({ accepted: true })
  }
}
const roomReserve = {
  validate (data, context) {
    const roomId = String(data?.roomId ?? '')
    const playerId = String(data?.playerId ?? '')
    if (!roomId || roomId !== String(context.identity.id) || !playerId) {
      return fail(ErrorCode.BAD_REQUEST, 'invalid room reservation')
    }
    return undefined
  },
  handle (command, context) {
    const playerId = String(command.data?.playerId ?? '')
    const existingId = context.reservations.findByPlayer(playerId)
    if (existingId) {
      return ok({ accepted: true, reservationId: existingId, slots: 1 })
    }
    if (!context.reservations.hasCapacity(1)) {
      return fail(ErrorCode.NO_CAPACITY, 'room capacity reserved')
    }
    const reservationId = `allocation-${playerId}-${Date.now()}`
    context.reservations.create(reservationId, [playerId], command.data?.ttlMs)
    return ok({ accepted: true, reservationId, slots: 1 })
  }
}
const movePrepare = {
  validate (data) {
    const moveId = String(data?.moveId ?? '')
    const playerIds = Array.isArray(data?.playerIds)
      ? data.playerIds.map(String)
      : []
    if (
      !moveId ||
      !playerIds.length ||
      new Set(playerIds).size !== playerIds.length
    ) {
      return fail(ErrorCode.BAD_REQUEST, 'invalid move prepare')
    }
    return undefined
  },
  handle (command, context) {
    const data = command.data ?? {}
    const moveId = String(data.moveId ?? '')
    const playerIds = data.playerIds.map(String)
    const existing = context.reservations.get(moveId)
    if (existing) {
      const same =
        existing.playerIds.size === playerIds.length &&
        playerIds.every(id => existing.playerIds.has(id))
      if (!same) return fail(ErrorCode.CONFLICT, 'move reservation conflicts')
      context.reservations.renew(moveId, data.ttlMs)
      return ok({
        accepted: true,
        moveId,
        slots: playerIds.length,
        idempotent: true,
        version: context.telemetry.version
      })
    }
    if (!context.reservations.hasCapacity(playerIds.length)) {
      return fail(ErrorCode.NO_CAPACITY, 'room capacity reserved')
    }
    const expectedVersion = data?.expectedVersion
    if (
      typeof expectedVersion === 'number' &&
      Number.isFinite(expectedVersion)
    ) {
      const currentVersion = context.telemetry.version
      if (
        expectedVersion < currentVersion &&
        currentVersion - expectedVersion > 3
      ) {
        return fail(ErrorCode.STALE_PLAN, 'room state advanced past the plan', {
          expectedVersion,
          currentVersion,
          players: context.players.size
        })
      }
    }
    context.reservations.create(moveId, playerIds, data.ttlMs)
    return ok({
      accepted: true,
      moveId,
      slots: playerIds.length,
      version: context.telemetry.version
    })
  }
}
const moveCancel = {
  handle (command, context) {
    context.reservations.cancel(String(command.data?.moveId ?? ''))
    return ok()
  }
}
const moveCommit = {
  validate (data) {
    if (!data?.udpHost)
      return fail(ErrorCode.BAD_REQUEST, 'missing destination host')
    return undefined
  },
  handle (command, context) {
    const data = command.data ?? {}
    const ids = data.playerIds ?? [data.playerId]
    const group = []
    for (const id of ids) {
      const player =
        context.players.getByUuid(String(id)) ??
        context.players.getById(Number(id))
      if (!player)
        return fail(ErrorCode.NOT_FOUND, 'source player not found', {
          playerId: id
        })
      group.push(player)
    }
    const toRoomUuid = TgcUuid.isText(data.toRoomUuid)
      ? data.toRoomUuid
      : destinationUuid(data.toRoomId)
    if (!toRoomUuid) {
      return fail(ErrorCode.BAD_REQUEST, 'invalid destination room uuid', {
        toRoomId: data.toRoomId
      })
    }
    const target = {
      id: data.toRoomId,
      udpHost: data.udpHost,
      udpPort: data.udpPort,
      uuid: toRoomUuid,
      address: {
        host: data.udpHost,
        port: data.udpPort,
        toApi () {
          return { host: this.host, port: this.port }
        }
      }
    }
    const result = context.moveService.movePlayersAtomic(group, target, {
      moveId: data.moveId
    })
    context.qwd.publish('move.result', {
      roomId: context.identity.id,
      moveId: data.moveId,
      accepted: result.accepted,
      reason: result.reason,
      movedPlayerIds: result.movedPlayerIds ?? [],
      failedPlayerIds: result.failedPlayerIds ?? []
    })
    return result.accepted
      ? ok(result)
      : { code: ErrorCode.CONFLICT, data: result }
  }
}
export const QWD_COMMANDS = new Map(
  Object.entries({
    'liveBroadcast.capability': { async handle (command, context) {
      const live = context.liveBroadcastService
      return live.enqueue(() => live.capability(command.data))
    } },
    'liveBroadcast.deliver': { async handle (command, context) {
      const live = context.liveBroadcastService
      return live.enqueue(() => live.deliver(command.data))
    } },
    'performance.state': { async handle (command, context) {
      const authority = context.performanceAuthority
      const applied = await authority.enqueue(() => authority.state(command.data))
      const data = { authorityEpoch: command.data.authorityEpoch, revision: command.data.revision, applied }
      return applied ? ok(data) : fail(ErrorCode.CONFLICT, 'stale performance state', data)
    } },
    'performance.decision': { async handle (command, context) {
      const authority = context.performanceAuthority
      await authority.enqueue(() => authority.decision(command.data)); return ok()
    } },
    'performance.deliver': { async handle (command, context) {
      const authority = context.performanceAuthority
      return ok(await authority.enqueue(() => authority.deliver(command.data)))
    } },
    'performance.gap': { async handle (command, context) {
      const authority = context.performanceAuthority
      const data = await authority.enqueue(() => authority.gap(command.data))
      return data.applied ? ok(data) : fail(ErrorCode.CONFLICT, 'stale performance gap', data)
    } },
    'audience.reaction': { async handle (command, context) {
      const reactions = context.audienceReactionService
      return reactions.enqueue(() => reactions.apply(command.data))
    } },
    'audience.chatGlobal': { async handle (command, context) {
      const chatGlobal = context.audienceChatGlobalService
      return chatGlobal.enqueue(() => chatGlobal.apply(command.data))
    } },
    'seat.assign': seatAssign,
    'audience.snapshot': audienceSnapshot,
    'seat.release': seatRelease,
    'room.reserve': roomReserve,
    'move.prepare': movePrepare,
    'move.cancel': moveCancel,
    'move.commit': moveCommit,
    'player.redirect': moveCommit
  })
)
export function dispatchQwdCommand (command, context) {
  const commandType = QWD_COMMANDS.get(command?.cmd)
  if (!commandType) return fail(ErrorCode.BAD_REQUEST, 'unsupported command')
  const rejected = commandType.validate?.(command.data, context)
  if (rejected) return rejected
  return commandType.handle(command, context)
}
