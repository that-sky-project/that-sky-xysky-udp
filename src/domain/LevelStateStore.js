import { StateError } from '../errors.js';

export class LevelStateStore {
  constructor({ roomId, logger }) {
    this.roomId = roomId;
    this.logger = logger;
    this.authorities = new Map();
    this.penalizedAuthorityCandidates = new Map();
    this.levelData = new Map();
    this._authorityElectedHandlers = [];
  }

  // Subscribe to authority election events.
  // Callback signature: (levelId: number, authority: Player) => void
  onAuthorityElected(callback) {
    this._authorityElectedHandlers.push(callback);
  }

  getAuthority(levelId) {
    return this.authorities.get(levelId);
  }

  setAuthority(levelId, player, context = {}) {
    if (!player || (player.levelId !== undefined && player.levelId !== levelId)) {
      throw new StateError('authority player is not in level', {
        levelId,
        playerId: player?.id,
        playerLevelId: player?.levelId
      });
    }
    const previous = this.authorities.get(levelId);
    this.authorities.set(levelId, player);

    if (previous !== player) {
      this.logger?.info({
        roomId: this.roomId,
        levelId,
        authorityPlayerId: player.id,
        previousAuthorityPlayerId: context.previousAuthorityPlayerId ?? previous?.id,
        peerId: player.session?.peerId?.toString(),
        uuid: player.uuid?.toString(),
        reason: context.reason
      }, 'level authority elected');

      for (const handler of this._authorityElectedHandlers) {
        handler(levelId, player, context.targetPlayer);
      }
    }
  }

  revokeAuthority(levelId, context = {}) {
    const previous = this.authorities.get(levelId);
    const revoked = this.authorities.delete(levelId);

    if (revoked) {
      this.logger?.info({
        roomId: this.roomId,
        levelId,
        authorityPlayerId: previous?.id,
        peerId: previous?.session?.peerId?.toString(),
        uuid: previous?.uuid?.toString(),
        reason: context.reason
      }, 'level authority revoked');
    }
  }

  isAuthority(player, levelId = player.levelId) {
    return this.getAuthority(levelId) === player;
  }

  penalizeAuthorityCandidate(levelId, player) {
    let penalized = this.penalizedAuthorityCandidates.get(levelId);
    if (!penalized) {
      penalized = new Set();
      this.penalizedAuthorityCandidates.set(levelId, penalized);
    }
    penalized.add(player);
  }

  clearAuthorityPenalty(levelId, player) {
    const penalized = this.penalizedAuthorityCandidates.get(levelId);
    if (!penalized) return;
    penalized.delete(player);
    if (penalized.size === 0) this.penalizedAuthorityCandidates.delete(levelId);
  }

  isAuthorityCandidatePenalized(levelId, player) {
    return this.penalizedAuthorityCandidates.get(levelId)?.has(player) ?? false;
  }

  pruneAuthorityCandidatePenalties(levelId, activePlayers) {
    const penalized = this.penalizedAuthorityCandidates.get(levelId);
    if (!penalized) return;
    const active = new Set(activePlayers);
    for (const player of penalized) {
      if (!active.has(player)) penalized.delete(player);
    }
    if (penalized.size === 0) this.penalizedAuthorityCandidates.delete(levelId);
  }

  saveLevelData(levelId, data) {
    const authority = this.getAuthority(levelId);
    this.levelData.set(levelId, {
      electedPlayer: authority?.id ?? data.authorityPlayerId ?? 0,
      mergeState: data.mergeState ?? 0,
      unknown1: data.unknown1 ?? 0,
      unknown2: data.unknown2 ?? 0,
      unknown3: data.unknown3 ?? 0,
      levelHash: data.levelHash ?? data.unknown4 ?? 0,
      unknown4: data.unknown4 ?? 0,
      unknown5: data.unknown5 ?? 0,
      unknown6: data.unknown6 ?? 0,
      dataLength: data.payload?.length ?? 0,
      payload: Buffer.from(data.payload ?? Buffer.alloc(0)),
      updatedAt: data.updatedAt ?? Date.now(),
      authorityPlayerId: data.authorityPlayerId
    });
  }

  loadLevelData(levelId) {
    return this.levelData.get(levelId);
  }

  reset(levelId, context = {}) {
    if (levelId === undefined) {
      this.authorities.clear();
      this.penalizedAuthorityCandidates.clear();
      this.levelData.clear();
      return;
    }

    this.revokeAuthority(levelId, context);
    this.penalizedAuthorityCandidates.delete(levelId);
    this.levelData.delete(levelId);
  }

  toApi() {
    return Array.from(new Set([
      ...this.authorities.keys(),
      ...this.penalizedAuthorityCandidates.keys(),
      ...this.levelData.keys()
    ])).map(levelId => ({
      roomId: this.roomId,
      levelId,
      authorityPlayerId: this.authorities.get(levelId)?.id,
      penalizedAuthorityPlayerIds: Array.from(this.penalizedAuthorityCandidates.get(levelId) ?? [], player => player.id),
      hasLevelData: this.levelData.has(levelId),
      levelDataBytes: this.levelData.get(levelId)?.payload?.length ?? 0,
      levelHash: this.levelData.get(levelId)?.levelHash ?? 0,
      mergeState: this.levelData.get(levelId)?.mergeState ?? 0,
      updatedAt: this.levelData.get(levelId)?.updatedAt
    }));
  }
}
