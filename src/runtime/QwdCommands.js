import { ErrorCode, fail, ok } from '../qwd/errorCodes.js'
import { ALLOCATION_RESERVATION_TTL_MS } from '../qwd/RoomReservations.js'
import { TgcUuid } from '../protocol/types/TgcUuid.js'
import { destinationUuid } from './destinationUuid.js'

const validLease = data => data?.ttlMs === undefined || (Number.isInteger(data.ttlMs) && data.ttlMs > 0 && data.ttlMs <= 120_000)
const validToken = data => data?.reservationToken === undefined || (typeof data.reservationToken === 'string' && data.reservationToken.length > 0 && data.reservationToken.length <= 256)
const roomMatches = (data, context) => data?.roomId === undefined || String(data.roomId) === String(context.identity.id)
const facts = context => context.reservations.facts(context.telemetry.version)
const ack = (context, reservationId, extra = {}) => {
  const reservation = context.reservations.get(reservationId)
  return ok({ accepted: true, reservationId, reservationToken: reservation?.reservationToken,
    expiresAt: reservation?.expiresAt, ...facts(context), ...extra })
}
const reservationValidation = (data, context) => {
  if (!validLease(data) || !validToken(data) || !roomMatches(data, context)) return fail(ErrorCode.BAD_REQUEST, 'invalid reservation identity or lease')
}

const roomReserve = {
  validate (data, context) {
    return reservationValidation(data, context) ??
      (!data?.roomId || !String(data?.playerId ?? '') ? fail(ErrorCode.BAD_REQUEST, 'invalid room reservation') : undefined)
  },
  handle (command, context) {
    const data = command.data
    const playerId = String(data.playerId)
    const existingId = context.reservations.findByPlayer(playerId)
    if (existingId) {
      if (!context.reservations.matchesToken(existingId, data.reservationToken)) return fail(ErrorCode.CONFLICT, 'reservation owner conflicts')
      context.reservations.renew(existingId, data.ttlMs ?? ALLOCATION_RESERVATION_TTL_MS)
      return ack(context, existingId, { slots: 1, idempotent: true })
    }
    if (context.players.getByUuid(playerId)) return fail(ErrorCode.CONFLICT, 'player already physically present', facts(context))
    if (!context.reservations.hasCapacity(1)) return fail(ErrorCode.NO_CAPACITY, 'room capacity reserved', facts(context))
    const reservationId = data.moveId ? String(data.moveId) : `allocation-${playerId}-${Date.now()}`
    if (context.reservations.get(reservationId)) return fail(ErrorCode.CONFLICT, 'reservation identity conflicts')
    context.reservations.create(reservationId, [playerId], data.ttlMs ?? ALLOCATION_RESERVATION_TTL_MS, data)
    return ack(context, reservationId, { slots: 1, moveId: data.moveId })
  }
}

const movePrepare = {
  validate (data, context) {
    const invalid = reservationValidation(data, context)
    if (invalid) return invalid
    if (!String(data?.moveId ?? '') || !Array.isArray(data?.playerIds) || !data.playerIds.length || data.playerIds.length > 7 ||
      data.playerIds.some(id => !String(id ?? '')) || new Set(data.playerIds.map(String)).size !== data.playerIds.length ||
      (data.expectedVersion !== undefined && (!Number.isInteger(data.expectedVersion) || data.expectedVersion < 0))) {
      return fail(ErrorCode.BAD_REQUEST, 'invalid move prepare')
    }
  },
  handle (command, context) {
    const data = command.data
    const moveId = String(data.moveId)
    const playerIds = data.playerIds.map(String)
    const existing = context.reservations.get(moveId)
    if (existing) {
      if (existing.playerIds.size !== playerIds.length || !playerIds.every(id => existing.playerIds.has(id)) ||
        !context.reservations.matchesToken(moveId, data.reservationToken)) return fail(ErrorCode.CONFLICT, 'move reservation conflicts')
      context.reservations.renew(moveId, data.ttlMs)
      return ack(context, moveId, { moveId, slots: playerIds.length, idempotent: true })
    }
    if (playerIds.some(id => context.reservations.findByPlayer(id) || context.players.getByUuid(id))) {
      return fail(ErrorCode.CONFLICT, 'participant already present or reserved', facts(context))
    }
    if (!context.reservations.hasCapacity(playerIds.length)) return fail(ErrorCode.NO_CAPACITY, 'room capacity reserved', facts(context))
    if (data.expectedVersion !== undefined && context.telemetry.version - data.expectedVersion > 3) {
      return fail(ErrorCode.STALE_PLAN, 'room state advanced past the plan', { expectedVersion: data.expectedVersion, currentVersion: context.telemetry.version, ...facts(context) })
    }
    context.reservations.create(moveId, playerIds, data.ttlMs, data)
    return ack(context, moveId, { moveId, slots: playerIds.length })
  }
}

const moveCancel = {
  validate (data, context) {
    return reservationValidation(data, context) ?? (!String(data?.moveId ?? '') ? fail(ErrorCode.BAD_REQUEST, 'missing move identity') : undefined)
  },
  handle (command, context) {
    const data = command.data
    const moveId = String(data.moveId)
    if (context.reservations.get(moveId) && !context.reservations.matchesToken(moveId, data.reservationToken)) {
      return fail(ErrorCode.CONFLICT, 'reservation owner conflicts')
    }
    context.reservations.cancel(moveId)
    context.migrationRosters?.cancelReservation?.(moveId)
    return ok({ accepted: true, moveId, reservationToken: data.reservationToken, ...facts(context) })
  }
}

const moveCommit = {
  validate (data, context) {
    const ids = data?.playerIds ?? (data?.playerId ? [data.playerId] : [])
    if (!roomMatches(data, context) || !validToken(data) || typeof data?.udpHost !== 'string' || !data.udpHost ||
      !Number.isInteger(data.udpPort) || data.udpPort < 1 || data.udpPort > 65535 ||
      !Array.isArray(ids) || !ids.length || ids.length > 7 || new Set(ids.map(String)).size !== ids.length) {
      return fail(ErrorCode.BAD_REQUEST, 'invalid move destination or group')
    }
    if (data.expectedParticipants !== undefined && (!Array.isArray(data.expectedParticipants) ||
      data.expectedParticipants.length !== ids.length || new Set(data.expectedParticipants.map(item => String(item?.playerId))).size !== ids.length ||
      data.expectedParticipants.some(item => !item || !ids.map(String).includes(String(item.playerId)) || item.sessionId === undefined ||
        !Number.isInteger(item.levelId) || !Number.isInteger(item.lvSeq) || item.lvSeq < 0 || item.lvSeq > 255))) {
      return fail(ErrorCode.BAD_REQUEST, 'invalid expected participants')
    }
  },
  handle (command, context) {
    const data = command.data
    const ids = data.playerIds ?? [data.playerId]
    const group = []
    for (const id of ids) {
      const player = context.players.getByUuid(String(id)) ?? context.players.getById(Number(id))
      if (!player) return fail(ErrorCode.NOT_FOUND, 'source player not found', { playerId: id })
      const expected = data.expectedParticipants?.find(item => String(item.playerId) === String(id))
      if (expected && (String(expected.sessionId) !== String(player.session.id) || expected.levelId !== player.levelId || expected.lvSeq !== player.lvSeq)) {
        return fail(ErrorCode.STALE_PLAN, 'source participant changed', { playerId: id, expected, actual: {
          playerId: player.uuid.toString(), sessionId: player.session.id, levelId: player.levelId, lvSeq: player.lvSeq } })
      }
      group.push(player)
    }
    const toRoomUuid = TgcUuid.isText(data.toRoomUuid) ? data.toRoomUuid : destinationUuid(data.toRoomId)
    if (!toRoomUuid) return fail(ErrorCode.BAD_REQUEST, 'invalid destination room uuid', { toRoomId: data.toRoomId })
    const target = { id: data.toRoomId, uuid: toRoomUuid,
      address: { host: data.udpHost, port: data.udpPort, toApi () { return { host: this.host, port: this.port } } } }
    const result = context.moveService.movePlayersAtomic(group, target, { moveId: data.moveId, reservationToken: data.reservationToken })
    context.qwd.publish('move.result', { roomId: context.identity.id, moveId: data.moveId,
      reservationToken: data.reservationToken, phase: 'source_commit', accepted: result.accepted, reason: result.reason,
      movedPlayerIds: result.movedPlayerIds ?? [], failedPlayerIds: result.failedPlayerIds ?? [] })
    return result.accepted ? ok(result) : { code: ErrorCode.CONFLICT, data: result }
  }
}

const roomSync = {
  validate (data, context) { if (!roomMatches(data, context)) return fail(ErrorCode.BAD_REQUEST, 'room identity conflicts') },
  handle (command, context) { context.telemetry.forceFull(); return ok(facts(context)) }
}
export const QWD_COMMANDS = new Map(Object.entries({
  'room.reserve': roomReserve, 'room.sync': roomSync,
  'move.prepare': movePrepare, 'move.renew': movePrepare, 'move.cancel': moveCancel,
  'move.commit': moveCommit, 'player.redirect': moveCommit
}))
export function dispatchQwdCommand (command, context) {
  const commandType = QWD_COMMANDS.get(command?.cmd)
  if (!commandType) return fail(ErrorCode.BAD_REQUEST, 'unsupported command')
  const rejected = commandType.validate?.(command.data, context)
  return rejected ?? commandType.handle(command, context)
}
