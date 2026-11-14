import { PacketIds } from '../../protocol/PacketIds.js';
import { GameMsgType } from '../../protocol/packets/shared/GameMsgPacket.js';
import { decodeNetLevelDataMsg, encodeNetLevelDataMsg } from '../../protocol/types/NetLevelDataMsg.js';
import { NET_LEVEL_DATA_MAX_BYTES, SNAPSHOT_MAX_DATA_BYTES } from '../../protocol/snapshot/constants.js';
import { SnapshotWriter } from '../../protocol/snapshot/SnapshotWriter.js';
import { selectAuthorityCandidate } from '../../domain/authorityCandidates.js';

/** Validates/publishes level data; LevelStateStore remains the authority owner. */
export class LevelDataReplication {
  constructor({ levels, delivery, logger, packetDebug }) {
    this.levels = levels;
    this.delivery = delivery;
    this.logger = logger;
    this.packetDebug = packetDebug;
  }

  warn(meta, message) {
    const log = this.logger?.warn ?? this.logger?.debug;
    log?.call(this.logger, meta, message);
  }

  handle(source, payload) {
    switch (payload.type) {
      case GameMsgType.NetLevelData: this.receive(source, payload); return true;
      case GameMsgType.NetLevelDataElect:
        this.warn({ playerId: source.id }, 'ignored server-only NetLevelDataElect from client');
        return true;
      case GameMsgType.NetLevelDataHeartbeat: this.heartbeat(source, payload); return true;
      case GameMsgType.NetLevelDataRevoke: this.revoke(source, payload); return true;
      case GameMsgType.NetLevelDataRevokeAck:
        source.lastRevokeAck = { snapshot: payload.snapshot, bytes: payload.payload?.length ?? 0, updatedAt: Date.now() };
        this.logger.debug({ playerId: source.id, snapshot: payload.snapshot, payloadBytes: payload.payload?.length ?? 0 }, 'received level data revoke ack');
        return true;
      case GameMsgType.NetLevelElectionNominee: this.nominee(source, payload); return true;
      default: return false;
    }
  }

  receive(source, payload) {
    if (!this.levels.isAuthority(source, source.levelId)) {
      this.warn({ playerId: source.id, levelId: source.levelId, authorityPlayerId: this.levels.getAuthority(source.levelId)?.id }, 'ignored level data from non-authority player');
      return;
    }
    const decoded = source.levelDelta.read(payload.snapshot, payload.payload);
    if (!decoded.ok) return;
    let message;
    try {
      message = decodeNetLevelDataMsg(decoded.data, { skipHeaderBytes: 0, maxDataBytes: NET_LEVEL_DATA_MAX_BYTES });
    } catch (error) {
      this.warn({ err: error, errMessage: error.message, playerId: source.id, levelId: source.levelId,
        dataBytes: decoded.data?.length ?? 0, dataHex: decoded.data?.subarray(0, 32).toString('hex') ?? 'none' }, 'ignored invalid level data stream');
      return;
    }
    if (message.trailingBytes !== 0) {
      if (decoded.data.every(byte => byte === 0)) {
        this.logger.debug({ playerId: source.id, levelId: source.levelId, packetLevelId: message.levelId,
          trailingBytes: message.trailingBytes, dataLength: message.dataLength }, 'received empty level data snapshot (all zeros)');
      }
      return;
    }
    if (message.levelId !== source.levelId) {
      this.warn({ playerId: source.id, sourceLevelId: source.levelId, packetLevelId: message.levelId }, 'ignored level data for mismatched level');
      return;
    }
    if (message.authorityVersion !== this.levels.getAuthorityVersion(source.levelId)) {
      this.warn({ playerId: source.id, levelId: source.levelId, receivedVersion: message.authorityVersion,
        expectedVersion: this.levels.getAuthorityVersion(source.levelId) }, 'ignored level data with stale authority version');
      return;
    }
    this.levels.saveLevelData(source.levelId, {
      mergeState: message.mergeState ?? 0, authorityVersion: message.authorityVersion,
      unknown2: message.unknown2 ?? 0, unknown3: message.unknown3 ?? 0,
      levelHash: message.levelHash ?? 0, unknown4: message.unknown4 ?? 0,
      unknown5: message.unknown5 ?? 0, unknown6: message.unknown6 ?? 0,
      dataLength: message.dataLength ?? message.levelData?.length ?? 0,
      payload: message.levelData, updatedAt: Date.now(), authorityPlayerId: source.id
    });
  }

  heartbeat(source, payload) {
    if (payload.levelId !== source.levelId) {
      this.logger.debug({ playerId: source.id, playerLevelId: source.levelId, heartbeatLevelId: payload.levelId }, 'ignored level heartbeat for non-current level');
      return;
    }
    if (!this.levels.getAuthority(source.levelId)) {
      const next = selectAuthorityCandidate(this.levels, source.levelId, this.delivery.activeInLevel(source.levelId));
      if (next) this.levels.setAuthority(source.levelId, next, { reason: 'heartbeat_no_authority' });
    }
  }

  revoke(source, payload) {
    const levelId = source.levelId;
    if (!this.levels.isAuthority(source, levelId)) {
      this.warn({ playerId: source.id, levelId, authorityPlayerId: this.levels.getAuthority(levelId)?.id }, 'ignored NetLevelDataRevoke from non-authority player');
      return;
    }
    const players = this.delivery.activeInLevel(levelId);
    this.levels.penalizeAuthorityCandidate(levelId, source);
    for (const target of players) this.sendRevoke(target, source, payload.reason ?? 0);
    this.levels.revokeAuthority(levelId, { reason: 'authority_revoke_penalty' });
    const next = selectAuthorityCandidate(this.levels, levelId, players);
    if (next) this.levels.setAuthority(levelId, next, { previousAuthorityPlayerId: source.id,
      reason: next === source ? 'sole_player_penalty_cleared' : 'authority_revoke_penalty' });
  }

  nominee(source, payload) {
    if (payload.levelId !== source.levelId) {
      this.logger.debug?.({ playerId: source.id, playerLevelId: source.levelId, nomineeLevelId: payload.levelId }, 'ignored election nominee for non-current level');
      return;
    }
    source.lastElectionNominee = { levelId: payload.levelId, reason: payload.reason, updatedAt: Date.now() };
    const bytes = Buffer.alloc(6);
    bytes.writeUInt32LE(payload.levelId, 0);
    bytes.writeUInt16LE(payload.reason ?? 0, 4);
    const relayed = this.delivery.relay(source, source.session, { type: GameMsgType.NetLevelElectionNominee,
      sourcePlayer: source.id, payloadBytes: bytes });
    if (relayed) this.logger.debug?.({ playerId: source.id, levelId: source.levelId, relayed }, 'relayed election nominee to the level');
  }

  sendRevoke(target, authority, reason = 0) {
    this.delivery.send(target, { type: GameMsgType.NetLevelDataRevoke,
      sourcePlayer: authority?.id ?? 0, playerId: authority?.id ?? 0, reason });
  }

  sendRevokeAndElect(levelId, revokedAuthority, nextAuthority, initialData, reason = 0) {
    for (const target of this.delivery.activeInLevel(levelId)) {
      this.sendRevoke(target, revokedAuthority, reason);
      if (nextAuthority) this.sendElect(target, nextAuthority, initialData);
    }
  }

  createElectPayload(authority, initialData) {
    const data = Buffer.from(initialData?.payload ?? initialData?.levelData ?? Buffer.alloc(0));
    const cached = this.levels.loadLevelData(authority.levelId);
    const payload = cached?.payload ? Buffer.from(cached.payload) : data;
    return encodeNetLevelDataMsg({ ...(cached ?? {}), electedPlayer: authority.id,
      authorityVersion: this.levels.getAuthorityVersion(authority.levelId), levelId: authority.levelId,
      hasInitialData: payload.length > 0, levelData: payload });
  }

  sendElect(target, authority, initialData) {
    const bytes = this.createElectPayload(authority, initialData);
    if (bytes.length > SNAPSHOT_MAX_DATA_BYTES) {
      this.warn({ targetPlayerId: target.id, levelId: authority?.levelId, dataBytes: bytes.length }, 'skipped oversized elect payload');
      return;
    }
    const buffer = new SnapshotWriter().write(bytes);
    if (!buffer) return;
    const frame = { sequence: buffer[0], base: buffer[1], checksum: buffer[2], payload: buffer.subarray(3) };
    if (this.packetDebug?.isEnabled({ id: PacketIds.GameMsg, payload: { type: GameMsgType.NetLevelDataElect } })) {
      const message = decodeNetLevelDataMsg(bytes);
      this.logger.debug({ targetPlayerId: target.id, authorityPlayerId: authority.id, levelId: message.levelId,
        electedPlayer: message.electedPlayer, authorityVersion: message.authorityVersion,
        hasInitialData: message.hasInitialData, levelDataLength: message.levelData.length,
        messageBytes: bytes.length, compressedBytes: frame.payload.length,
        frameSeq: frame.sequence, frameBase: frame.base }, 'sending NetLevelDataElect');
    }
    this.delivery.snapshot(target, GameMsgType.NetLevelDataElect, frame);
  }

  sync() {
    for (const target of this.delivery.activePlayers()) {
      const levelId = target.levelId;
      if (levelId == null) continue;
      const authority = this.levels.getAuthority(levelId), cached = this.levels.loadLevelData(levelId);
      if (!authority || authority === target || !cached) continue;
      const bytes = encodeNetLevelDataMsg({ ...cached, electedPlayer: authority.id,
        authorityVersion: (this.levels.getAuthorityVersion(levelId) + 1) & 0xffff,
        levelId, hasInitialData: (cached.payload?.length ?? 0) > 0, levelData: cached.payload ?? Buffer.alloc(0) });
      if (bytes.length > SNAPSHOT_MAX_DATA_BYTES) continue;
      const frame = target.levelDelta.write(bytes);
      if (frame) this.delivery.snapshot(target, GameMsgType.NetLevelData, frame);
    }
  }
}
