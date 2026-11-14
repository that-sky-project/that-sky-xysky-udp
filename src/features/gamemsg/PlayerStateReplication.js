import { PacketIds } from '../../protocol/PacketIds.js';
import { GameMsgType } from '../../protocol/packets/shared/GameMsgPacket.js';
import { decodePlayerState, decodePlayerStateLite, encodePlayerState } from '../../protocol/types/PlayerState.js';
import { PLAYER_STATE_MAX_BYTES, SNAPSHOT_MAX_DATA_BYTES } from '../../protocol/snapshot/constants.js';

const DECODE_WARN_INTERVAL_MS = 30_000;

function partialPlayerState(raw) {
  if (!raw || raw.length < 13) return null;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const fields = { stateKind: bytes[0] & 7,
    position: [bytes.readFloatLE(1), bytes.readFloatLE(5), bytes.readFloatLE(9)] };
  return { version: 'partial', partial: true, bits: 13 * 8, rawState: bytes, fields, _originalFields: fields };
}

/** Owns representation/diagnostics, while Player owns both existing snapshot channels. */
export class PlayerStateReplication {
  constructor({ delivery, broadcaster, logger, stateDecode = 'full' }) {
    this.delivery = delivery;
    this.broadcaster = broadcaster;
    this.logger = logger;
    this.stateDecode = stateDecode === 'basic' ? 'basic' : 'full';
    this.encodedStates = new WeakMap();
    this.decodeWarnAt = new WeakMap();
    this.decodeDumpSignatures = new Set();
  }

  receive(source, payload) {
    const decoded = source.playerDelta.read(payload.snapshot, payload.payload);
    if (!decoded.ok) return;
    if (decoded.data.length > PLAYER_STATE_MAX_BYTES) {
      this.warn({ playerId: source.id, stateBytes: decoded.data.length, max: PLAYER_STATE_MAX_BYTES }, 'ignored oversized PlayerState');
      source.playerDelta.rawState = null;
      return;
    }
    source.playerDelta.rawState = decoded.data;
    try {
      source.playerDelta.decodedState = this.decode(source, decoded.data);
      if (source.playerDelta.decodedState.complete) {
        source.lastStateLayout = source.playerDelta.decodedState.layout;
        if (source.playerDelta.decodedState.boundWidened?.length) {
          this.logger.debug?.({ playerId: source.id, widened: source.playerDelta.decodedState.boundWidened },
            'player state decoded with within-width bound widening');
        }
      }
    } catch (error) {
      source.playerDelta.decodedState = partialPlayerState(decoded.data);
      this.reportDecodeFailure(source, decoded, payload, error);
    }
  }

  decode(player, data) {
    if (this.stateDecode === 'basic' && player.lastStateLayout) {
      return decodePlayerStateLite(data, { layout: player.lastStateLayout });
    }
    try {
      return decodePlayerState(data, { preferredLayout: player.lastStateLayout });
    } catch (error) {
      // Preserve the established fallback without making assumptions about why
      // the complete record failed or whether its remaining fields are valid.
      const layout = player.lastStateLayout ?? 'u64-full';
      const lite = decodePlayerStateLite(data, { layout });
      const details = error.details;
      const signature = `${details?.field ?? details?.scope ?? 'unknown'}@${details?.bitOffset ?? '?'}:${error.consumedBits ?? '?'}:${data.length}`;
      const shouldDump = !this.decodeDumpSignatures.has(signature) && this.decodeDumpSignatures.size < 8;
      if (shouldDump) this.decodeDumpSignatures.add(signature);
      this.logger.debug?.({ playerId: player.uuid?.toString?.(), layout, consumedBits: error.consumedBits,
        details, signature, stateBytes: data.length, stateHex: shouldDump ? data.toString('hex') : undefined,
        err: error.message }, 'player state full decode failed; degraded to head read');
      return lite;
    }
  }

  reportDecodeFailure(player, decoded, payload, error) {
    const details = error?.details ?? {};
    const signature = `${details.field ?? details.scope ?? 'unknown'}@${details.bitOffset ?? '?'}:${decoded.data.length}`;
    const shouldDump = !this.decodeDumpSignatures.has(signature) && this.decodeDumpSignatures.size < 5;
    if (shouldDump) this.decodeDumpSignatures.add(signature);
    const now = Date.now();
    if (!shouldDump && now - (this.decodeWarnAt.get(player) ?? 0) < DECODE_WARN_INTERVAL_MS) return;
    this.decodeWarnAt.set(player, now);
    this.warn({ playerId: player.id, stateBytes: decoded.data.length,
      statePrefixHex: decoded.data.subarray(0, 96).toString('hex'),
      stateHex: shouldDump ? decoded.data.toString('hex') : undefined,
      firstByteLow3: decoded.data[0] & 7, snapshotSave: payload.snapshot?.sequence,
      snapshotBase: payload.snapshot?.base, snapshotRaw: decoded.raw,
      error: error?.message, details: error?.details }, 'failed to decode PlayerState');
  }

  warn(meta, message) {
    const log = this.logger?.warn ?? this.logger?.debug;
    log?.call(this.logger, meta, message);
  }

  serializedState(player) {
    let raw = player.playerDelta.rawState;
    const decoded = player.playerDelta.decodedState;
    if (decoded && !decoded.minimal && !decoded.partial) {
      const cached = this.encodedStates.get(player);
      if (cached?.decodedRef === decoded) return cached.encoded;
      try {
        raw = encodePlayerState(decoded);
        this.encodedStates.set(player, { decodedRef: decoded, encoded: raw });
      } catch (error) {
        this.warn({ sourcePlayerId: player.id, levelId: player.levelId, error: error?.message },
          'PlayerState field serialization failed; relaying raw state');
      }
    }
    return raw;
  }

  sync() {
    const players = this.delivery.activePlayers();
    if (players.length < 2) return;
    // Existing behavior checks both channels at the PlayerState tick boundary.
    for (const player of players) {
      for (const channel of [player.playerDelta, player.levelDelta]) {
        if (!channel.resyncRequired) continue;
        channel.resyncRequired = false;
        this.broadcaster.send(player.session, { id: PacketIds.SnapshotResync, payload: {} });
        this.logger.debug?.({ playerId: player.id, levelId: player.levelId }, 'snapshot window unrecoverable; sent resync command');
      }
    }
    const entries = [];
    for (const player of players) {
      const raw = this.serializedState(player);
      if (!raw?.length) continue;
      const entryBytes = 5 + raw.length;
      if (raw.length > PLAYER_STATE_MAX_BYTES || entryBytes > SNAPSHOT_MAX_DATA_BYTES) {
        this.warn({ sourcePlayerId: player.id, levelId: player.levelId, stateBytes: raw.length }, 'syncPlayerStates: dropped oversized player state');
        continue;
      }
      const header = Buffer.allocUnsafe(5);
      header.writeUInt8(player.id, 0);
      header.writeUInt32LE(raw.length, 1);
      entries.push({ player, bytes: Buffer.concat([header, raw], entryBytes) });
    }
    // PlayerState is room-wide; RPC/level data use different recipient policies.
    for (const target of players) {
      let batch = [], batchBytes = 0;
      const flush = () => {
        if (!batch.length) return;
        const frame = target.playerDelta.write(Buffer.concat(batch, batchBytes));
        if (frame) this.delivery.snapshot(target, GameMsgType.PlayerStateDelta, frame);
        batch = []; batchBytes = 0;
      };
      for (const { player, bytes } of entries) {
        if (player === target) continue;
        if (batchBytes + bytes.length > SNAPSHOT_MAX_DATA_BYTES) flush();
        batch.push(bytes); batchBytes += bytes.length;
      }
      flush();
    }
  }
}
