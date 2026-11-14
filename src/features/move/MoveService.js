import { PacketIds } from '../../protocol/PacketIds.js';
import { ConnectionState } from '../../connection/states.js';
import { sendPacket } from '../broadcast/sendPacket.js';

const MOVE_HISTORY_LIMIT = 200;

export class MoveService {
  constructor({ players, rooms, broadcaster, transport, levelService, logger, onMoveResult, finalizeSession, moveTimeoutMs = 20000 }) {
    Object.assign(this, { players, rooms, broadcaster, transport, levelService, logger, onMoveResult, finalizeSession, moveTimeoutMs });
    this.pendingMoves = new Map();
    this.moveHistory = new Map();
  }

  recordHistory(moveId, entry) {
    this.moveHistory.set(moveId, entry);
    while (this.moveHistory.size > MOVE_HISTORY_LIMIT) this.moveHistory.delete(this.moveHistory.keys().next().value);
  }

  send(session, packet) {
    return sendPacket(this.broadcaster, session, packet, undefined, 'Move packet send failed to queue');
  }

  movePlayer(player, targetRoom, options = {}) {
    return this.movePlayersAtomic([player], targetRoom, { ...options, isSplit: false }).accepted;
  }

  movePlayersAtomic(players, targetRoom, { moveId, reservationToken, isSplit = true } = {}) {
    const group = Array.isArray(players) ? players : [];
    const rejected = reason => ({ accepted: false, moved: 0, reason,
      failedPlayerIds: group.map(player => player?.uuid?.toString?.()).filter(Boolean) });
    if (!group.length || !targetRoom) return rejected('empty_group');
    if (group.length > 7) return rejected('move_group_too_large');
    if (new Set(group).size !== group.length) return rejected('duplicate_players');
    if (group.some(player => !player?.session?.isActive?.() || this.players.getBySession(player.session) !== player ||
      this.findPendingByPlayer(player.id, player.session.id))) return rejected('group_not_movable');

    const prepared = group.map(player => this.prepareMove(player, targetRoom, moveId, reservationToken));
    const queued = [];
    for (const pending of prepared) this.pendingMoves.set(pending.moveId, pending);
    try {
      for (let index = 0; index < group.length; index++) {
        const player = group[index];
        this.send(player.session, { id: PacketIds.MoveGame, payload: { address: targetRoom.address,
          players: group, moveNonce: prepared[index].moveNonce, splitType: 0, isSplit, destinationUuid: targetRoom.uuid } });
        queued.push(player);
      }
    } catch (error) {
      for (const pending of prepared) {
        this.pendingMoves.delete(pending.moveId);
        this.recordHistory(pending.moveId, { ...pending, status: 'cancelled', cancelReason: 2, cancelledAt: Date.now(), error: error.message });
      }
      for (const player of queued) {
        try { this.send(player.session, { id: PacketIds.CancelMove, payload: { reason: 2 } }); }
        catch { this.finalizeSession?.(player.session, 'move_rollback_failed', { disconnect: 'now' }); }
      }
      return rejected(error.message);
    }
    for (const player of group) player.session.transition(ConnectionState.MOVING);
    // All peers are in MOVING before elections can see the remaining active set.
    for (const player of group) this.levelService?.releaseAuthority(player, 'players_moving');
    this.logger.info({ moveId, playerIds: group.map(player => player.id), targetRoomId: targetRoom.id }, 'atomic player move committed');
    return { accepted: true, moved: group.length, movedPlayerIds: group.map(player => player.uuid.toString()), failedPlayerIds: [] };
  }

  prepareMove(player, targetRoom, moveId, reservationToken) {
    const createdAt = Date.now();
    return { moveId: moveId ? `${moveId}:${player.id}` : this.createMoveId(player, targetRoom),
      transactionId: moveId, reservationToken, playerId: player.id, playerUuid: player.uuid.toString(),
      sessionId: player.session.id, playerLevelId: player.levelId, lvSeq: player.lvSeq,
      targetRoomId: targetRoom.id, targetAddress: targetRoom.address?.toApi?.() ?? targetRoom.address,
      moveNonce: this.createMoveNonce(player, targetRoom), splitType: 0, status: 'pending', createdAt,
      cleanupAt: createdAt + this.moveTimeoutMs };
  }

  moveLevel(levelId, targetRoom) {
    const players = this.players.listActiveInLevel?.(Number(levelId)) ?? this.players.listInLevel(Number(levelId));
    return this.movePlayersAtomic(players, targetRoom).moved;
  }

  cancelPlayerMove(player, reason = 0) {
    if (!player || this.players.getBySession(player.session) !== player) return false;
    const pending = this.findPendingByPlayer(player.id, player.session.id);
    if (!pending) return false;
    this.send(player.session, { id: PacketIds.CancelMove, payload: { reason } });
    this.pendingMoves.delete(pending.moveId);
    this.recordHistory(pending.moveId, { ...pending, status: 'cancelled', cancelReason: reason, cancelledAt: Date.now() });
    if (player.session.state === ConnectionState.MOVING) {
      player.session.transition(ConnectionState.ACTIVE);
      this.levelService?.rebalanceAuthority(player.levelId);
    }
    return true;
  }

  handleMoveResult(session, payload) {
    const player = this.players.getBySession(session);
    if (!player || player.session !== session) return;
    const matched = this.findPendingByPlayer(player.id, session.id);
    if (!matched || matched.status !== 'pending') return;
    const result = payload?.result ?? payload?.payloadBytes?.[0] ?? 0;
    const updated = { ...matched, status: result === 0 ? 'acknowledged' : 'failed', result, acknowledgedAt: Date.now() };
    if (result === 0) {
      // This acknowledges receipt at the source, not admission at the destination.
      // Keep the original cleanup deadline even when no disconnect event follows.
      this.pendingMoves.set(matched.moveId, updated);
    } else {
      this.pendingMoves.delete(matched.moveId);
      if (session.state === ConnectionState.MOVING) {
        session.transition(ConnectionState.ACTIVE);
        this.levelService?.rebalanceAuthority(player.levelId);
      }
    }
    this.recordHistory(matched.moveId, updated);
    this.onMoveResult?.({ ...updated, phase: 'source_ack' }, result === 0);
    this.logger.debug({ playerId: player.id, sessionId: session.id, result }, 'received source move result');
  }

  expireStuckMoves(now = Date.now()) {
    let expired = 0;
    for (const move of [...this.pendingMoves.values()]) {
      if (now < move.cleanupAt) continue;
      const candidate = this.players.getById(move.playerId);
      const player = candidate?.session.id === move.sessionId && candidate.uuid.toString() === move.playerUuid ? candidate : undefined;
      this.pendingMoves.delete(move.moveId);
      this.recordHistory(move.moveId, { ...move, status: 'aborted', abortReason: 'move_timeout', abortedAt: now });
      if (player) {
        if (!move.transactionId && move.status === 'pending') {
          try {
            this.send(player.session, { id: PacketIds.CancelMove, payload: { reason: 2 } });
            player.session.transition(ConnectionState.ACTIVE);
            this.levelService?.rebalanceAuthority(player.levelId);
          } catch { this.finalizeSource(player, 'move_timeout'); }
        } else this.finalizeSource(player, 'move_timeout');
      }
      expired++;
    }
    return expired;
  }

  finalizeSource(player, reason) {
    if (this.finalizeSession) return this.finalizeSession(player.session, reason, { disconnect: 'now' });
    // Standalone service owners still cannot leave a domain ghost after native now.
    this.players.removeBySession(player.session);
    player.session.close?.();
    this.levelService?.releaseAuthority(player, reason);
    this.transport.disconnect(player.session.peerId, 'now');
  }

  forgetPlayerMoves(player, reason = 'player_disconnected') {
    if (!player) return 0;
    let removed = 0;
    for (const [moveId, move] of this.pendingMoves) {
      if (move.playerId !== player.id || move.sessionId !== player.session.id) continue;
      this.pendingMoves.delete(moveId);
      this.recordHistory(moveId, { ...move, status: 'aborted', abortReason: reason, abortedAt: Date.now() });
      removed++;
    }
    return removed;
  }

  createMoveId(player, targetRoom) { return `${player.id}:${targetRoom.id}:${Date.now()}`; }
  listPending() { return Array.from(this.pendingMoves.values()); }
  listHistory() { return Array.from(this.moveHistory.values()); }
  findPendingByPlayer(playerId, sessionId) {
    for (const move of this.pendingMoves.values()) {
      if (move.playerId === playerId && (sessionId === undefined || move.sessionId === sessionId)) return move;
    }
  }
  createMoveNonce(player, targetRoom) {
    const high = BigInt(player.id & 0xff);
    const low = BigInt((targetRoom.id?.toString?.().length ?? 0) & 0xff);
    return (BigInt(Date.now()) << 16n) ^ (high << 8n) ^ low;
  }
}
