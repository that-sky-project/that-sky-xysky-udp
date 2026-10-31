import { PacketIds } from '../../protocol/PacketIds.js';
import { ConnectionState } from '../../connection/states.js';

/**
 * Completed moves kept for diagnostics.
 *
 * `moveHistory` exists only for `listHistory`, which no production path reads,
 * so it is a bounded ring: an unbounded Map here leaked one entry per migration
 * for the lifetime of the process.
 */
const MOVE_HISTORY_LIMIT = 200;
const MOVE_HISTORY_TTL_MS = 10 * 60 * 1000;

export class MoveService {
  constructor({ players, rooms, broadcaster, transport, levelService, logger, onMoveResult, moveTimeoutMs = 20000 }) {
    this.players = players;
    this.rooms = rooms;
    this.broadcaster = broadcaster;
    this.transport = transport;
    this.levelService = levelService;
    this.logger = logger;
    this.onMoveResult = onMoveResult;
    this.moveTimeoutMs = moveTimeoutMs;
    this.pendingMoves = new Map();
    this.moveHistory = new Map();
  }

  recordHistory(moveId, entry) {
    this.moveHistory.set(moveId, entry);
    if (this.moveHistory.size <= MOVE_HISTORY_LIMIT) return;

    const cutoff = Date.now() - MOVE_HISTORY_TTL_MS;
    for (const [id, move] of this.moveHistory) {
      if (this.moveHistory.size <= MOVE_HISTORY_LIMIT) break;
      const at = move.abortedAt ?? move.cancelledAt ?? move.acknowledgedAt ?? move.createdAt ?? 0;
      if (at >= cutoff && this.moveHistory.size <= MOVE_HISTORY_LIMIT) break;
      this.moveHistory.delete(id);
    }
    while (this.moveHistory.size > MOVE_HISTORY_LIMIT) {
      const oldest = this.moveHistory.keys().next();
      if (oldest.done) break;
      this.moveHistory.delete(oldest.value);
    }
  }

  movePlayer(player, targetRoom, { disconnect = true } = {}) {
    if (!player || !targetRoom || !player.session?.isActive?.() || this.findPendingByPlayer(player.id)) {
      return false;
    }

    const moveId = this.createMoveId(player, targetRoom);
    const moveNonce = this.createMoveNonce(player, targetRoom);
    this.pendingMoves.set(moveId, {
      moveId,
      playerId: player.id,
      playerUuid: player.uuid?.toString?.(),
      playerLevelId: player.levelId,
      targetRoomId: targetRoom.id,
      targetAddress: targetRoom.address?.toApi?.() ?? targetRoom.address,
      moveNonce,
      splitType: 0,
      status: 'pending',
      createdAt: Date.now()
    });

    try {
      this.broadcaster.send(player.session, {
        id: PacketIds.MoveGame,
        payload: {
          address: targetRoom.address,
          players: [player],
          moveNonce,
          splitType: 0,
          isSplit: false,
          destinationUuid: targetRoom.uuid
        }
      });
    } catch (error) {
      this.pendingMoves.delete(moveId);
      throw error;
    }
    player.session.transition(ConnectionState.MOVING);
    this.levelService?.releaseAuthority(player, 'player_moving');

    this.logger.info({
      playerId: player.id,
      targetRoomId: targetRoom.id,
      target: targetRoom.address.toApi()
    }, 'player move requested');

    // if (disconnect) {
    //   this.transport.disconnect(player.session.peerId, 'later', 2);
    //}
    return true;
  }

  movePlayersAtomic(players, targetRoom, { disconnect = true, moveId } = {}) {
    const group = Array.isArray(players) ? players : [];
    if (!group.length || !targetRoom) return { accepted: false, moved: 0, reason: 'empty_group' };
    if (group.length > 7) return { accepted: false, moved: 0, reason: 'move_group_too_large' };
    const unique = [...new Set(group)];
    if (unique.length !== group.length) return { accepted: false, moved: 0, reason: 'duplicate_players' };
    const eligible = unique.filter(player => player?.session?.isActive?.() && !this.findPendingByPlayer(player.id));
    if (!eligible.length) return { accepted: false, moved: 0, reason: 'group_not_movable' };
    const rejected = unique.filter(player => !eligible.includes(player));
    const moved = [];
    const failed = [...rejected];
    const groupPlayers = eligible;
    const prepared = [];
    try {
      for (const player of eligible) {
        const pending = this.prepareMove(player, targetRoom, moveId);
        this.pendingMoves.set(pending.moveId, pending);
        prepared.push(pending);
      }
  
      for (const player of eligible) {
        const pending = prepared.find(item => item.playerId === player.id);
        if (!pending) continue;
        this.broadcaster.send(player.session, {
          id: PacketIds.MoveGame,
          payload: {
            address: targetRoom.address,
            players: groupPlayers,
            moveNonce: pending.moveNonce,
            splitType: 0,
            isSplit: true,
            destinationUuid: targetRoom.uuid
          }
        });
        moved.push(player);
      }
    } catch (error) {
      for (const pending of prepared) {
        this.pendingMoves.delete(pending.moveId);
        this.recordHistory(pending.moveId, {
          ...pending,
          status: 'cancelled',
          cancelReason: 2,
          cancelledAt: Date.now(),
          error: error.message
        });
      }
      for (const player of moved) {
        try {
          this.broadcaster.send(player.session, { id: PacketIds.CancelMove, payload: { reason: 2 } });
        } catch {
          // The original MoveGame may already have closed the peer.
        }
      }
      return { accepted: false, moved: 0, failedPlayerIds: eligible.map(player => player.uuid?.toString?.()).filter(Boolean), reason: error.message };
    }
    for (const player of moved) {
      player.session.transition(ConnectionState.MOVING);
      this.levelService?.releaseAuthority(player, 'players_moving');
    }

    this.logger.info({ moveId, playerIds: moved.map(player => player.id), targetRoomId: targetRoom.id }, 'atomic player move committed');
    return { accepted: moved.length > 0, moved: moved.length, failedPlayerIds: failed.map(player => player.uuid?.toString?.()).filter(Boolean), movedPlayerIds: moved.map(player => player.uuid?.toString?.()).filter(Boolean) };
  }

  prepareMove(player, targetRoom, moveId) {
    const generatedMoveId = moveId
      ? `${moveId}:${player.id}`
      : this.createMoveId(player, targetRoom);
    return {
      moveId: generatedMoveId,
      transactionId: moveId,
      playerId: player.id,
      playerUuid: player.uuid?.toString?.(),
      playerLevelId: player.levelId,
      targetRoomId: targetRoom.id,
      targetAddress: targetRoom.address?.toApi?.() ?? targetRoom.address,
      moveNonce: this.createMoveNonce(player, targetRoom),
      splitType: 0,
      status: 'pending',
      createdAt: Date.now()
    };
  }

  moveLevel(levelId, targetRoom) {
    const players = typeof this.players.listActiveInLevel === 'function'
      ? this.players.listActiveInLevel(Number(levelId))
      : this.players.listInLevel(Number(levelId));
    let moved = 0;

    for (const player of players) {
      if (this.movePlayer(player, targetRoom)) {
        moved += 1;
      }
    }

    return moved;
  }

  cancelPlayerMove(player, reason = 0) {
    if (!player) {
      return false;
    }

    this.broadcaster.send(player.session, {
      id: PacketIds.CancelMove,
      payload: {
        reason
      }
    });
    if (player.session.state === ConnectionState.MOVING) {
      player.session.transition(ConnectionState.ACTIVE);
      this.levelService?.rebalanceAuthority(player.levelId);
    }

    for (const [moveId, move] of this.pendingMoves.entries()) {
      if (move.playerId === player.id) {
        const updated = {
          ...move,
          status: 'cancelled',
          cancelReason: reason,
          cancelledAt: Date.now()
        };
        this.pendingMoves.delete(moveId);
        this.recordHistory(moveId, updated);
      }
    }

    return true;
  }

  handleMoveResult(session, payload) {
    const player = this.players.getBySession(session);
    if (!player) {
      return;
    }

    const result = payload?.result ?? payload?.payloadBytes?.[0] ?? 0;
    const matched = this.findPendingByPlayer(player.id);
    if (matched) {
      const updated = {
        ...matched,
        status: result === 0 ? 'acknowledged' : 'failed',
        result,
        acknowledgedAt: Date.now()
      };
      this.pendingMoves.delete(matched.moveId);
      this.recordHistory(matched.moveId, updated);
      if (result !== 0 && session.state === ConnectionState.MOVING) {
        session.transition(ConnectionState.ACTIVE);
        this.levelService?.rebalanceAuthority(player.levelId);
      }
      this.onMoveResult?.({ ...matched, result }, result === 0);
    }

    this.logger.debug({
      playerId: player.id,
      result,
      payloadBytes: payload.payloadBytes?.length ?? 0
    }, 'received move result');
  }

  expireStuckMoves(now = Date.now()) {
    let expired = 0;
    for (const move of [...this.pendingMoves.values()]) {
      if (move.status !== 'pending' || now - move.createdAt < this.moveTimeoutMs) continue;
      const player = this.players.list().find(item => item.id === move.playerId);
      if (player) {
        if (move.transactionId) {
          this.pendingMoves.delete(move.moveId);
          this.recordHistory(move.moveId, { ...move, status: 'aborted', abortReason: 'move_timeout', abortedAt: now });
          this.logger.warn({ moveId: move.moveId, playerId: move.playerId }, 'qwd move timed out; disconnecting lingering source session');
          try {
            this.transport.disconnect(player.session.peerId, 'now');
          } catch (error) {
            this.logger.warn({ err: error, moveId: move.moveId, playerId: move.playerId }, 'failed to disconnect lingering source session');
          }
        } else {
          this.cancelPlayerMove(player, 2);
          this.logger.warn({ moveId: move.moveId, playerId: move.playerId }, 'move timed out; reverted session to active');
        }
      } else {
        this.pendingMoves.delete(move.moveId);
        this.recordHistory(move.moveId, { ...move, status: 'aborted', abortReason: 'move_timeout', abortedAt: now });
      }
      expired += 1;
    }
    return expired;
  }

  forgetPlayerMoves(player, reason = 'player_disconnected') {    if (!player) return 0;
    let removed = 0;
    for (const [moveId, move] of this.pendingMoves.entries()) {
      if (move.playerId !== player.id) continue;
      this.pendingMoves.delete(moveId);
      this.recordHistory(moveId, {
        ...move,
        status: 'aborted',
        abortReason: reason,
        abortedAt: Date.now()
      });
      removed += 1;
    }
    return removed;
  }

  createMoveId(player, targetRoom) {
    return `${player.id}:${targetRoom.id}:${Date.now()}`;
  }

  listPending() {
    return Array.from(this.pendingMoves.values());
  }

  listHistory() {
    return Array.from(this.moveHistory.values());
  }

  findPendingByPlayer(playerId) {
    for (const move of this.pendingMoves.values()) {
      if (move.playerId === playerId && move.status === 'pending') {
        return move;
      }
    }

    return undefined;
  }

  createMoveNonce(player, targetRoom) {
    const high = BigInt(player.id & 0xff);
    const low = BigInt((targetRoom.id?.toString?.().length ?? 0) & 0xff);
    return (BigInt(Date.now()) << 16n) ^ (high << 8n) ^ low;
  }
}
