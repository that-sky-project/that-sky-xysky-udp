import { GameMsgType } from '../../protocol/packets/shared/GameMsgPacket.js';
import { GameMessageDelivery } from './GameMessageDelivery.js';
import { PlayerStateReplication } from './PlayerStateReplication.js';
import { LevelDataReplication } from './LevelDataReplication.js';
import { RpcRelay } from './RpcRelay.js';

const RETIRED_TYPES = new Set([18, 19, 20, 21, 22, 24]);

/** Entry policy and dispatch. Replication components own their complete workflows. */
export class GameMessageService {
  constructor({ players, levels, broadcaster, logger, stateDecode = 'full', packetDebug }) {
    this.players = players;
    this.logger = logger;
    this.delivery = new GameMessageDelivery({ players, broadcaster });
    this.playerStates = new PlayerStateReplication({ delivery: this.delivery, broadcaster, logger, stateDecode });
    this.levelData = new LevelDataReplication({ levels, delivery: this.delivery, logger, packetDebug });
    this.rpc = new RpcRelay({ delivery: this.delivery, logger });
  }

  handle(session, payload) {
    // Rejected before lookup/touch: removed features have no residual side effects.
    if (RETIRED_TYPES.has(payload.type)) return;
    const source = this.players.getBySession(session);
    if (!source) return;
    if (Number.isFinite(payload.levelChangeCount)) {
      const incoming = Math.trunc(payload.levelChangeCount) & 0xff;
      if (incoming !== source.lvSeq) {
        if (payload.type === GameMsgType.NetRpc) this.rpc.stale(source, session, payload);
        this.logger.debug?.({ playerId: source.id, expectedLevelChangeCount: source.lvSeq,
          receivedLevelChangeCount: incoming, type: payload.type }, 'ignored GameMsg with stale level generation');
        return;
      }
    }
    source.touch();
    switch (payload.type) {
      case GameMsgType.NetRpc:
        this.rpc.receive(source, session, payload);
        return;
      case GameMsgType.PlayerStateDelta:
        this.playerStates.receive(source, payload);
        return;
      case GameMsgType.Critters:
      case GameMsgType.MusicSync:
        source.lastOpaqueGameMsg = { type: payload.type, bytes: payload.payloadBytes?.length ?? 0, updatedAt: Date.now() };
        this.delivery.relay(source, session, { ...payload, sourcePlayer: source.id });
        return;
      case GameMsgType.Affinity:
        source.lastAffinity = { type: payload.type, entries: payload.entries ?? [], complete: payload.complete ?? false,
          trailingBytes: payload.trailingBytes ?? 0, bytes: payload.payloadBytes?.length ?? 0, updatedAt: Date.now() };
        return;
      case GameMsgType.Metrics:
      case GameMsgType.LevelStateSideChannel:
        source.lastClientOnlyGameMsg = { type: payload.type, bytes: payload.payloadBytes?.length ?? 0, updatedAt: Date.now() };
        return;
      case GameMsgType.SnapshotAck:
        source.playerDelta.ack(payload.playerAckSeq);
        source.levelDelta.ack(payload.levelAckSeq);
        return;
      default:
        this.levelData.handle(source, payload);
    }
  }

  syncPlayerStates() { this.playerStates.sync(); }
  syncLevelData() { this.levelData.sync(); }
  sendElect(target, authority, initialData) { this.levelData.sendElect(target, authority, initialData); }
  sendRevokeAndElect(levelId, revokedAuthority, nextAuthority, initialData, reason = 0) {
    this.levelData.sendRevokeAndElect(levelId, revokedAuthority, nextAuthority, initialData, reason);
  }

  sendSnapshotAcks() {
    for (const target of this.delivery.activePlayers()) {
      this.delivery.send(target, { type: GameMsgType.SnapshotAck, sourcePlayer: 0,
        playerAckSeq: target.playerDelta.readAckSequence ?? 1, levelAckSeq: target.levelDelta.readAckSequence ?? 1 });
    }
  }
}
