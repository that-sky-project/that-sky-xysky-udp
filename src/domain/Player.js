import { PlayerSnapshotState } from '../features/gamemsg/PlayerSnapshotState.js';

export class Player {
  constructor({ id, uuid, session, levelId, netVersion, levelChangeCount = 0 }) {
    this.id = id;
    this.uuid = uuid;
    this.session = session;
    this.levelId = levelId ?? 0;
    this.netVersion = netVersion;
    this.lvSeq = Number.isFinite(levelChangeCount) ? (Math.trunc(levelChangeCount) & 0xff) : 0;
    this.levelChangeCount = this.lvSeq;
    this.joinedAt = Date.now();
    this.lastSeenAt = Date.now();
    // PlayerState decoding belongs in GameMessageService after the snapshot
    // body has been reconstructed and its native 0x4b5 limit checked.
    this.playerDelta = new PlayerSnapshotState();
    this.levelDelta = new PlayerSnapshotState();
  }

  touch(now = Date.now()) {
    this.lastSeenAt = now;
  }

  changeLevel(levelId, netVersion = this.netVersion, levelChangeCount = undefined) {
    this.levelId = levelId;
    this.lvSeq = Number.isFinite(levelChangeCount)
      ? (Math.trunc(levelChangeCount) & 0xff)
      : ((this.lvSeq + 1) & 0xff);
    this.levelChangeCount = this.lvSeq;
    this.netVersion = netVersion;
    this.touch();
  }

  toApi() {
    return {
      id: this.id,
      roomId: this.session.roomId,
      uuid: this.uuid.toString(),
      peerId: this.session.peerId.toString(),
      levelId: this.levelId,
      levelChangeCount: this.levelChangeCount,
      netVersion: this.netVersion?.values,
      levelHash: this.netVersion?.levelHash,
      joinedAt: this.joinedAt,
      lastSeenAt: this.lastSeenAt,
      lastRpc: this.lastRpc,
      lastOpaqueGameMsg: this.lastOpaqueGameMsg,
      snapshots: {
        player: this.playerDelta.toApi(),
        level: this.levelDelta.toApi()
      }
    };
  }
}
