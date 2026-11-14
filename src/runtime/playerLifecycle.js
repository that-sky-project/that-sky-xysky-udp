import { PacketIds } from '../protocol/PacketIds.js'

export function createPlayerLifecycle ({ identity, publish, sessions, players, levelService, transport,
  broadcaster, moveService, reservations, metrics, logger }) {
  const playerFields = player => ({ playerId: player.uuid.toString(), sessionId: player.session.id,
    level: player.levelId, lvSeq: player.lvSeq })
  const notifyLeft = player => {
    if (player.leaveNotified) return
    player.leaveNotified = true
    publish('player.leave', { roomId: identity.id, player: playerFields(player) })
  }
  const finalizeSession = (session, reason = 'player_disconnected', { disconnect, removedPlayer, releaseAuthority = true } = {}) => {
    if (!session || session.finalized) return false
    session.finalized = true
    const ownsPeer = sessions.get(session.peerId) === session
    if (ownsPeer) sessions.remove(session.peerId, session)
    else session.close?.()
    const player = players?.removeBySession(session) ?? removedPlayer
    // disconnectNow does not emit an ENet disconnect event. Every explicit
    // cleanup must finish domain ownership here, including reused peer pointers.
    const attempt = operation => {
      try { operation() } catch (error) { logger?.warn({ err: error, sessionId: session.id, reason }, 'session cleanup step failed') }
    }
    if (player) {
      attempt(() => moveService?.forgetPlayerMoves(player, reason))
      if (releaseAuthority) attempt(() => levelService?.releaseAuthority(player, reason))
      attempt(() => notifyLeft(player))
      attempt(() => broadcaster.broadcast({ id: PacketIds.PlayerLeft, payload: { playerId: player.id, reason: 0 } }, { playerOnly: true }))
    }
    metrics?.connectedPeers?.set(sessions.size)
    metrics?.onlinePlayers?.set(players?.size ?? 0)
    metrics?.disconnects?.inc({ reason })
    if (ownsPeer && disconnect) attempt(() => transport.disconnect(session.peerId, disconnect))
    return true
  }

  return {
    joined (player) {
      if (player.joinNotified) return
      player.joinNotified = true
      reservations.consume(player.uuid.toString())
      publish('player.join', { roomId: identity.id, player: playerFields(player) })
    },
    notifyLeft,
    finalizeSession,
    evicted (player) {
      // JoinService already removed this player and released authority.
      finalizeSession(player.session, 'session_evicted', { disconnect: 'now', removedPlayer: player, releaseAuthority: false })
    }
  }
}
