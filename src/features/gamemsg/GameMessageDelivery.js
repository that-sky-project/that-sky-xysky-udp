import { PacketIds } from '../../protocol/PacketIds.js';
import { activePlayers, activePlayersInLevel } from '../../domain/playerQueries.js';

/** GameMsg envelopes always use the recipient's generation, not the sender's. */
export class GameMessageDelivery {
  constructor({ players, broadcaster }) {
    this.players = players;
    this.broadcaster = broadcaster;
  }

  activePlayers() { return activePlayers(this.players); }
  activeInLevel(levelId) { return activePlayersInLevel(this.players, levelId); }

  send(target, payload) {
    return this.broadcaster.send(target.session, {
      id: PacketIds.GameMsg,
      payload: { ...payload, levelChangeCount: target.lvSeq }
    });
  }

  snapshot(target, type, frame, sourcePlayer = 0) {
    return this.send(target, {
      type,
      sourcePlayer,
      snapshot: { sequence: frame.sequence, base: frame.base, checksum: frame.checksum },
      payload: frame.payload
    });
  }

  relay(source, sourceSession, payload) {
    let forwarded = 0;
    for (const target of this.activeInLevel(source.levelId)) {
      if (target === source || target.session === sourceSession) continue;
      this.send(target, payload);
      forwarded++;
    }
    return forwarded;
  }
}
