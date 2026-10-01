import { PacketIds } from '../protocol/PacketIds.js';
import { ConnectionState } from '../session/ConnectionSession.js';

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

    // The client owns the old UDP connection lifecycle after MoveGame. The
    // server keeps the session in MOVING until the client's actual disconnect,
    // which lets the target JoinGame complete without a forced server kick.
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
      // Every moving client receives the same complete group list. The native
      // split flow is transactional: a partial publication would leave some
      // clients with a roster that can never be completed at the destination.
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
        this.moveHistory.set(pending.moveId, {
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
    // if (disconnect) for (const player of moved) this.transport.disconnect(player.session.peerId, 'later', 2);
    // Do not force-disconnect the source peers. Each client closes its old
    // connection after processing MoveGame; PeerEventHandler then emits the
    // authoritative player.leave event.
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
        this.moveHistory.set(moveId, updated);
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
      this.moveHistory.set(matched.moveId, updated);
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
        // Client neither completed the move nor disconnected in time. Revert it
        // to ACTIVE so the slot and authority are reclaimed instead of leaking.
        this.cancelPlayerMove(player, 2);
        this.logger.warn({ moveId: move.moveId, playerId: move.playerId }, 'move timed out; reverted session to active');
      } else {
        this.pendingMoves.delete(move.moveId);
        this.moveHistory.set(move.moveId, { ...move, status: 'aborted', abortReason: 'move_timeout', abortedAt: now });
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
      this.moveHistory.set(moveId, {
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
