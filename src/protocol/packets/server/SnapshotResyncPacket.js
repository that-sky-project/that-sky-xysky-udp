import { PacketIds } from '../../PacketIds.js'

/**
 * kNetMsg snapshot resync command (id 5) — client asm (sub_1A99E98 id-5
 * branch): unconditionally resets BOTH snapshot channels' Writer (window
 * seeded, 0x0101 "needs keyframe" flag written to state+0x2E3C0) and Reader,
 * then notifies the level layer. Zero payload.
 *
 * The server sends this when it detects a session's snapshot stream is past
 * repair — our SnapshotWriter signals `resyncfailed` when a resync window
 * halves twice without ack. After this packet the next PlayerStateDelta /
 * NetLevelData frame must be a raw keyframe, which the reset writers
 * guarantee.
 */
export class SnapshotResyncPacket {
  static id = PacketIds.SnapshotResync
  static name = 'SnapshotResyncPacket'

  static decode () {
    return {}
  }

  static encode () {
    // zero payload
  }
}
