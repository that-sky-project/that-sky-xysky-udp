import { PacketIds } from '../../PacketIds.js'
import { ProtocolError } from '../../../errors.js'
const MAX_ENTER_GAME_PLAYERS = 8
export class EnterGamePacket {
  static id = PacketIds.EnterGame
  static name = 'EnterGamePacket'
  static encode (writer, packet) {
    const players = packet.players ?? []
    if (players.length > MAX_ENTER_GAME_PLAYERS) {
      throw new ProtocolError('EnterGame player list too large', {
        count: players.length,
        max: MAX_ENTER_GAME_PLAYERS
      })
    }
    writer.writeCompressed(players.length, MAX_ENTER_GAME_PLAYERS)
    for (const player of players) {
      writer.writeUInt8(player.netId ?? player.id ?? 0)
      player.uuid.encode(writer)
      writer.pad(16)
      writer.writeUInt32(player.levelId ?? 0)
    }
  }
}
