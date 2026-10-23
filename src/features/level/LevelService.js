import { PacketIds } from '../../protocol/PacketIds.js';

export class LevelService {
  constructor({ players, levels, broadcaster, logger }) {
    this.players = players;
    this.levels = levels;
    this.broadcaster = broadcaster;
    this.logger = logger;
  }

  changeLevel(session, payload) {
    const player = this.players.getBySession(session);
    if (!player) {
      return;
    }

    const oldLevelId = player.levelId;
    const changedLevel = oldLevelId !== payload.levelId;
    if (changedLevel) {
      this.levels.clearAuthorityPenalty?.(oldLevelId, player);
    }
    player.changeLevel(payload.levelId, payload.netVersion, payload.levelChangeCount);

    if (changedLevel && this.levels.getAuthority(oldLevelId) === player) {
      this.levels.revokeAuthority(oldLevelId, { reason: 'authority_left_level' });
      this.rebalanceAuthority(oldLevelId);
    }

    let authority = this.levels.getAuthority(player.levelId);
    if (!authority) {
      authority = this.rebalanceAuthority(player.levelId, 'level_update_no_authority').authority;
    } else {
      for (const handler of this.levels._authorityElectedHandlers) {
        handler(player.levelId, authority, player);
      }
    }

    if (!changedLevel) {
      return;
    }

    const changedLevelPacket = {
      id: PacketIds.PlayerChangedLevel,
      payload: { playerId: player.id, levelId: player.levelId }
    };
    for (const target of this._activePlayers()) {
      if (target.session !== session) {
        this.broadcaster.send(target.session, changedLevelPacket);
      }
    }

    this.logger.debug({
      playerId: player.id,
      oldLevelId,
      levelId: player.levelId,
      authorityPlayerId: authority?.id
    }, 'player changed level');
  }

  releaseAuthority(player, reason = 'player_disconnected') {
    if (!player) {
      return { authority: undefined };
    }

    const levelId = player.levelId;
    this.levels.clearAuthorityPenalty?.(levelId, player);
    if (this.levels.getAuthority(levelId) === player) {
      this.levels.revokeAuthority(levelId, { reason });
    }

    // PeerEventHandler removes the player before calling this method, so the
    // rebalance sees only viable peers and elects one immediately.
    return this.rebalanceAuthority(levelId);
  }

  rebalanceAuthority(levelId, reason = 'level_rebalance') {
    const current = this.levels.getAuthority(levelId);
    const players = this._activeInLevel(levelId);
    this.levels.pruneAuthorityCandidatePenalties?.(levelId, players);

    if (
      current &&
      players.includes(current) &&
      !this.levels.isAuthorityCandidatePenalized?.(levelId, current)
    ) {
      return { authority: current };
    }

    const previousAuthorityPlayerId = current?.id;
    let next = players.find(player => !this.levels.isAuthorityCandidatePenalized?.(levelId, player));
    if (!next && players.length === 1) {
      next = players[0];
      this.levels.clearAuthorityPenalty?.(levelId, next);
    }
    if (next) {
      // setAuthority fires onAuthorityElected handlers for all-level broadcast.
      this.levels.setAuthority(levelId, next, {
        previousAuthorityPlayerId,
        reason: current ? 'authority_left_level' : reason
      });
      return { authority: next };
    }

    if (players.length === 0) {
      this.levels.reset?.(levelId, { reason: 'level_empty' });
    }
    return { authority: undefined };
  }

  _activeInLevel(levelId) {
    return typeof this.players.listActiveInLevel === 'function'
      ? this.players.listActiveInLevel(levelId)
      : this.players.listInLevel(levelId).filter(player => player.session?.isActive?.() ?? true);
  }

  _activePlayers() {
    if (typeof this.players.listActive === 'function') return this.players.listActive();
    if (typeof this.players.list === 'function') {
      return this.players.list().filter(player => player.session?.isActive?.() ?? true);
    }
    return [];
  }

}
