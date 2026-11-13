import { PacketIds } from '../protocol/PacketIds.js'

export function createPlayerLifecycle ({ identity, publish, audience, sessions, transport, broadcaster, moveService, reservations }) {
  const notifyLeft = player => {
    const playerId = player.uuid.toString()
    const roster = audience.rosters.get(playerId)
    publish('player.leave', { roomId: identity.id, player: { playerId } })
    if (roster) {
      publish('seat.released', {
        roomId: identity.id, player: { playerId }, levelId: roster.levelId ?? 0,
        benchId: roster.benchId, seatId: roster.seatId
      })
    }
  }

  return {
    joined (player) {
      const playerId = player.uuid.toString()
      reservations.consume(playerId)
      publish('player.join', { roomId: identity.id, player: { playerId, level: player.levelId } })
    },
    notifyLeft,
    evicted (player) {
      notifyLeft(player)
      audience.forgetPlayer(player.uuid.toString())
      moveService.forgetPlayerMoves(player)
      sessions.remove(player.session.peerId)
      transport.disconnect(player.session.peerId, 'later')
      broadcaster.broadcast({ id: PacketIds.PlayerLeft, payload: { playerId: player.id, reason: 0 } }, { playerOnly: true })
    }
  }
}
