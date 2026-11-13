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
    this.levelReady = false;
    this.lastAuthoritySync = undefined;
    this.joinedAt = Date.now();
    this.lastSeenAt = Date.now();
    this.playerDelta = new PlayerSnapshotState();
    this.levelDelta = new PlayerSnapshotState();
  }

  touch(now = Date.now()) {
    this.lastSeenAt = now;
  }

  changeLevel(levelId, netVersion = this.netVersion, levelChangeCount = undefined) {
    const previousLevelId = this.levelId;
    const previousGeneration = this.lvSeq;
    const wasReady = this.levelReady;
    this.levelId = levelId;
    this.lvSeq = Number.isFinite(levelChangeCount)
      ? (Math.trunc(levelChangeCount) & 0xff)
      : ((this.lvSeq + 1) & 0xff);
    this.levelChangeCount = this.lvSeq;
    this.levelReady = true;
    if (!wasReady || previousLevelId !== this.levelId || previousGeneration !== this.lvSeq) {
      this.lastAuthoritySync = undefined;
    }
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
      levelReady: this.levelReady,
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
