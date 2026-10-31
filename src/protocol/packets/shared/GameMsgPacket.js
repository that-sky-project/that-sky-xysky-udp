import { PacketIds } from '../../PacketIds.js'
import {
  decodeAffinityEntries,
  encodeAffinityEntries
} from '../../types/Affinity.js'
import { decodeMusicSyncEntries } from '../../types/MusicSync.js'
export const GameMsgType = Object.freeze({
  NetRpc: 2,
  PlayerStateDelta: 3,
  Critters: 4,
  Affinity: 7,
  NetLevelDataElect: 8,
  NetLevelDataRevoke: 9,
  NetLevelDataRevokeAck: 10,
  NetLevelData: 11,
  NetLevelDataHeartbeat: 12,
  SnapshotAck: 14,
  MusicSync: 15,
  Metrics: 16,
  NetLevelElectionNominee: 17,
  AudienceHint: 19,
  AudienceSocialBroadcast: 20,
  AudienceConsensusVote: 21,
  AudienceChat: 22,
  LevelStateSideChannel: 23,
  AudienceSpotlightRequest: 24
})
function readSnapshotPayload (reader) {
  return {
    snapshot: {
      sequence: reader.readUInt8(),
      base: reader.readUInt8(),
      checksum: reader.readUInt8()
    },
    payload: reader.readBytes(reader.remaining)
  }
}
function writeHeader (writer, packet) {
  writer.writeUInt8(packet.type)
  writer.writeUInt8(packet.levelChangeCount ?? 0)
  writer.writeUInt8(packet.sourcePlayer ?? 0)
}
function writeSnapshotPayload (writer, packet) {
  writer.writeUInt8(packet.snapshot?.sequence ?? 0)
  writer.writeUInt8(packet.snapshot?.base ?? 0)
  writer.writeUInt8(packet.snapshot?.checksum ?? 0)
  writer.writeBytes(packet.payload ?? Buffer.alloc(0))
}
export class GameMsgPacket {
  static id = PacketIds.GameMsg
  static name = 'GameMsgPacket'
  static decode (reader) {
    const type = reader.readUInt8()
    const levelChangeCount = reader.readUInt8()
    const sourcePlayer = reader.readUInt8()
    const base = { type, levelChangeCount, sourcePlayer }
    if (type === GameMsgType.NetRpc) {
      return {
        ...base,
        playerId: reader.readUInt8(),
        rpcData: reader.readBytes(reader.remaining)
      }
    }
    if (type === GameMsgType.Affinity) {
      const raw = reader.readBytes(reader.remaining)
      return {
        ...base,
        ...decodeAffinityEntries(raw),
        payloadBytes: raw
      }
    }
    if (
      type === GameMsgType.PlayerStateDelta ||
      type === GameMsgType.NetLevelData ||
      type === GameMsgType.NetLevelDataElect
    ) {
      return {
        ...base,
        ...readSnapshotPayload(reader)
      }
    }
    if (type === GameMsgType.NetLevelDataRevoke) {
      const raw = reader.readBytes(reader.remaining)
      const parsed =
        raw.length >= 3
          ? {
              playerId: raw.readUInt8(0),
              reason: raw.readUInt16LE(1)
            }
          : {}
      return {
        ...base,
        ...parsed,
        payloadBytes: raw
      }
    }
    if (type === GameMsgType.NetLevelDataRevokeAck) {
      return {
        ...base,
        ...readSnapshotPayload(reader)
      }
    }
    if (type === GameMsgType.NetLevelDataHeartbeat) {
      return {
        ...base,
        ready: reader.readBool(),
        netPlayerId: reader.readUInt8(),
        levelId: reader.readUInt32(),
        authorityVersion: reader.readUInt16()
      }
    }
    if (type === GameMsgType.SnapshotAck) {
      return {
        ...base,
        playerAckSeq: reader.readUInt8(),
        levelAckSeq: reader.readUInt8()
      }
    }
    if (type === GameMsgType.MusicSync) {
      const raw = reader.readBytes(reader.remaining)
      const music = decodeMusicSyncEntries(raw)
      return {
        ...base,
        payloadBytes: raw,
        entries: music.entries,
        trailingBytes: music.trailingBytes,
        complete: music.complete
      }
    }
    if (type === GameMsgType.NetLevelElectionNominee) {
      if (reader.remaining >= 6) {
        return {
          ...base,
          levelId: reader.readUInt32(),
          reason: reader.readUInt16()
        }
      }
      return {
        ...base,
        payloadBytes: reader.readBytes(reader.remaining)
      }
    }
    return {
      ...base,
      payloadBytes: reader.readBytes(reader.remaining)
    }
  }
  static encode (writer, packet) {
    writeHeader(writer, packet)
    if (packet.type === GameMsgType.NetRpc) {
      writer.writeUInt8(packet.playerId ?? 0)
      writer.writeBytes(packet.rpcData ?? Buffer.alloc(0))
      return
    }
    if (packet.type === GameMsgType.Affinity) {
      writer.writeBytes(
        packet.payloadBytes ?? encodeAffinityEntries(packet.entries)
      )
      return
    }
    if (
      packet.type === GameMsgType.PlayerStateDelta ||
      packet.type === GameMsgType.NetLevelData ||
      packet.type === GameMsgType.NetLevelDataElect
    ) {
      writeSnapshotPayload(writer, packet)
      return
    }
    if (packet.type === GameMsgType.NetLevelDataRevoke) {
      if (packet.payloadBytes) {
        writer.writeBytes(packet.payloadBytes)
        return
      }
      writer.writeUInt8(packet.playerId ?? packet.authorityPlayerId ?? 0)
      writer.writeUInt16(packet.reason ?? 0)
      return
    }
    if (packet.type === GameMsgType.NetLevelDataRevokeAck) {
      writeSnapshotPayload(writer, packet)
      return
    }
    if (packet.type === GameMsgType.NetLevelDataHeartbeat) {
      writer.writeBool(packet.ready)
      writer.writeUInt8(packet.netPlayerId ?? 0)
      writer.writeUInt32(packet.levelId ?? 0)
      writer.writeUInt16(packet.authorityVersion ?? packet.unknown3 ?? 0)
      return
    }
    if (packet.type === GameMsgType.SnapshotAck) {
      writer.writeUInt8(packet.playerAckSeq ?? 0)
      writer.writeUInt8(packet.levelAckSeq ?? 0)
      return
    }
    if (packet.type === GameMsgType.NetLevelElectionNominee) {
      if (packet.payloadBytes) {
        writer.writeBytes(packet.payloadBytes)
        return
      }
      writer.writeUInt32(packet.levelId ?? packet.playerId ?? 0)
      writer.writeUInt16(packet.reason ?? 0)
      return
    }
    writer.writeBytes(packet.payloadBytes ?? Buffer.alloc(0))
  }
}
