import { PacketIds } from '../../PacketIds.js';
import { ProtocolError } from '../../../errors.js';

const MAX_ENTER_GAME_PLAYERS = 8;

export class EnterGamePacket {
  static id = PacketIds.EnterGame;
  static name = 'EnterGamePacket';

  // Wire format (Server→Client):
  //   [player_count: compressed int 0..8]
  //   per player (stride 37 bytes):
  //     [net_player_id: u08]       (player's assigned ID, 0-based)
  //     [player_uuid: u08[16]]
  //     [session_token: u08[16]]   (zeroed — server has no per-player token)
  //     [level_id: u32 LE]         (FNV-1a hash of the level the player is in)
  //
  // Reversed from sub_140e14760 in the game binary.
  static encode(writer, packet) {
    const players = packet.players ?? [];

    // SerializeCompressed(0, 8) uses four LSB-first bits; the next byte field aligns.
    if (players.length > MAX_ENTER_GAME_PLAYERS) {
      throw new ProtocolError('EnterGame player list too large', {
        count: players.length,
        max: MAX_ENTER_GAME_PLAYERS
      });
    }
    writer.writeCompressed(players.length, MAX_ENTER_GAME_PLAYERS);

    for (const player of players) {
      // Zero is reserved for an unassigned player.
      writer.writeUInt8(player.netId ?? player.id ?? 0);
      // 16-byte player UUID
      player.uuid.encode(writer);
      // 16-byte session token (zeroed — not known server-side)
      writer.pad(16);
      // level_id: FNV-1a hash of the level name the player is currently in.
      writer.writeUInt32(player.levelId ?? 0);
    }
  }
}
