import { PacketIds } from '../../protocol/PacketIds.js';
import { GameMsgType } from '../../protocol/packets/shared/GameMsgPacket.js';
import { decodeNetLevelDataMsg, encodeNetLevelDataMsg } from '../../protocol/types/NetLevelDataMsg.js';
import { decodePlayerState, decodePlayerStateLite, encodePlayerState } from '../../protocol/types/PlayerState.js';
import { NET_LEVEL_DATA_MAX_BYTES, PLAYER_STATE_MAX_BYTES, SNAPSHOT_MAX_DATA_BYTES } from '../../protocol/snapshot/constants.js';
import { SnapshotWriter } from '../../protocol/snapshot/SnapshotWriter.js';
import { netRpcRouter } from '../../protocol/packets/shared/netRpc/index.js';
import { decodeNetRpcHeader } from '../../protocol/packets/shared/netRpc/NetRpcCodec.js';
import { rpcTap, toHexPreview } from '../rpc/RpcTap.js';
import { decodeAudienceNetPrefix } from '../audience/decodeAudienceNetPrefix.js';

const DECODE_WARN_INTERVAL_MS = 30_000;

function partialPlayerState(raw) {
  if (!raw || raw.length < 13) return null;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const fields = {
    stateKind: bytes[0] & 7,
    position: [bytes.readFloatLE(1), bytes.readFloatLE(5), bytes.readFloatLE(9)]
  };
  return { version: 'partial', partial: true, bits: 13 * 8, rawState: bytes, fields, _originalFields: fields };
}

export class GameMessageService {
  constructor({ players, levels, broadcaster, logger, stateDecode = 'full', packetDebug, onAudienceState }) {
    this.players = players;
    this.levels = levels;
    this.broadcaster = broadcaster;
    this.logger = logger;
    this.packetDebug = packetDebug;
    this.onAudienceState = onAudienceState;
    this.stateDecode = stateDecode === 'basic' ? 'basic' : 'full';
    this.latestAcks = new Map();
    this.decodeWarnAt = new Map();
    // playerId -> { decodedRef, encoded }: the last encoded PlayerState keyed
    this.encodedStateCache = new Map();
    this.decodeDumpSignatures = new Set();
  }

  decodeState(player, data) {
    if (this.stateDecode === 'basic' && player.lastStateLayout) {
      return decodePlayerStateLite(data, { layout: player.lastStateLayout });
    }
    return decodePlayerState(data, { preferredLayout: player.lastStateLayout });
  }

  reportDecodeFailure(playerId, decoded, payload, error) {
    const details = error?.details ?? {};
    const signature = `${details.field ?? details.scope ?? 'unknown'}@${details.bitOffset ?? '?'}:${decoded.data.length}`;
    const shouldDump = !this.decodeDumpSignatures.has(signature) && this.decodeDumpSignatures.size < 5;
    if (shouldDump) this.decodeDumpSignatures.add(signature);

    const now = Date.now();
    const last = this.decodeWarnAt.get(playerId) ?? 0;
    if (!shouldDump && now - last < DECODE_WARN_INTERVAL_MS) return;
    this.decodeWarnAt.set(playerId, now);

    this.warn({
      playerId,
      stateBytes: decoded.data.length,
      statePrefixHex: decoded.data.subarray(0, 96).toString('hex'),
      stateHex: shouldDump ? decoded.data.toString('hex') : undefined,
      firstByteLow3: decoded.data[0] & 7,
      snapshotSave: payload.snapshot?.sequence,
      snapshotBase: payload.snapshot?.base,
      snapshotRaw: decoded.raw,
      error: error?.message,
      details: error?.details
    }, 'failed to decode PlayerState');
  }

  warn(meta, message) {
    if (typeof this.logger?.warn === 'function') {
      this.logger.warn(meta, message);
    } else {
      this.logger?.debug?.(meta, message);
    }
  }

  handle(session, payload) {
    const source = this.players.getBySession(session);
    if (!source) {
      return;
    }

    if (typeof payload.levelChangeCount === 'number' && Number.isFinite(payload.levelChangeCount)) {
      const incomingLvSeq = Math.trunc(payload.levelChangeCount) & 0xff;
      if (incomingLvSeq !== source.lvSeq) {
        if (payload.type === GameMsgType.NetRpc) {
          const h = decodeNetRpcHeader(payload.rpcData);
          rpcTap.push({
            direction: 'C->S',
            status: 'stale_dropped',
            playerId: source.id,
            uuid: source.uuid.toString(),
            sessionId: session.id,
            levelId: source.levelId,
            levelChangeCount: payload.levelChangeCount,
            expectedLvSeq: source.lvSeq,
            sourcePlayer: payload.sourcePlayer,
            header: h ? { classIdKey: h.classIdKey, sender: h.sender, receiver: h.receiver, typeFlag: h.typeFlag } : null,
            hex: toHexPreview(payload.rpcData, rpcTap.maxHexBytes),
            error: 'stale_level_generation',
          });
        }
        this.logger.debug?.({
          playerId: source.id,
          expectedLevelChangeCount: source.lvSeq,
          receivedLevelChangeCount: incomingLvSeq,
          type: payload.type
        }, 'ignored GameMsg with stale level generation');
        return;
      }
    }
    source.touch();

    if (payload.type === GameMsgType.NetRpc) {
      const h = decodeNetRpcHeader(payload.rpcData);
      rpcTap.push({
        direction: 'C->S',
        status: 'received',
        playerId: source.id,
        uuid: source.uuid.toString(),
        sessionId: session.id,
        levelId: source.levelId,
        levelChangeCount: payload.levelChangeCount,
        lvSeq: source.lvSeq,
        sourcePlayer: payload.sourcePlayer,
        header: h ? { classIdKey: h.classIdKey, sender: h.sender, receiver: h.receiver, typeFlag: h.typeFlag } : null,
        hex: toHexPreview(payload.rpcData, rpcTap.maxHexBytes),
        bytes: payload.rpcData?.length ?? 0,
      });

      source.lastRpc = {
        bytes: payload.rpcData.length,
        updatedAt: Date.now()
      };

      const rpcData = netRpcRouter.process(payload.rpcData, { source, logger: this.logger });

      const routed = Buffer.from(rpcData).equals(payload.rpcData) ? 'routed' : 'patched';

      const forwardedTo = this.forwardToLevel(source, session, {
        ...payload,
        rpcData,
        sourcePlayer: source.id
      });

      if (forwardedTo !== undefined) {
        const h2 = decodeNetRpcHeader(rpcData);
        rpcTap.push({
          direction: forwardedTo > 0 ? 'S->C' : 'dropped',
          status: forwardedTo > 0 ? 'forwarded' : 'no_receiver',
          playerId: source.id,
          uuid: source.uuid.toString(),
          sessionId: session.id,
          levelId: source.levelId,
          header: h2 ? { classIdKey: h2.classIdKey, sender: h2.sender, receiver: h2.receiver, typeFlag: h2.typeFlag } : h,
          action: routed,
          forwardedTo,
          hex: toHexPreview(rpcData, rpcTap.maxHexBytes),
          bytes: rpcData?.length ?? 0,
        });
      }
      return;
    }

    if (
      payload.type === GameMsgType.Critters ||
      payload.type === GameMsgType.MusicSync
    ) {
      source.lastOpaqueGameMsg = {
        type: payload.type,
        bytes: payload.payloadBytes?.length ?? 0,
        updatedAt: Date.now()
      };
      this.forwardToLevel(source, session, {
        ...payload,
        sourcePlayer: source.id
      });
      return;
    }

    if (payload.type === GameMsgType.Affinity) {
      source.lastAffinity = {
        type: payload.type,
        entries: payload.entries ?? [],
        complete: payload.complete ?? false,
        trailingBytes: payload.trailingBytes ?? 0,
        bytes: payload.payloadBytes?.length ?? 0,
        updatedAt: Date.now()
      };
      return;
    }

    if (
      payload.type === GameMsgType.Metrics ||
      payload.type === GameMsgType.AudienceHint ||
      payload.type === GameMsgType.AudienceSocialBroadcast ||
      payload.type === GameMsgType.AudienceConsensusVote ||
      payload.type === GameMsgType.AudienceChat ||
      payload.type === GameMsgType.LevelStateSideChannel ||
      payload.type === GameMsgType.AudienceSpotlightRequest
    ) {
      source.lastClientOnlyGameMsg = {
        type: payload.type,
        bytes: payload.payloadBytes?.length ?? 0,
        updatedAt: Date.now()
      };
      return;
    }

    if (payload.type === GameMsgType.PlayerStateDelta) {
      const decoded = source.playerDelta.read(payload.snapshot, payload.payload);
      if (!decoded.ok) {
        return;
      }
      if (decoded.data.length > PLAYER_STATE_MAX_BYTES) {
        this.warn({ playerId: source.id, stateBytes: decoded.data.length, max: PLAYER_STATE_MAX_BYTES }, 'ignored oversized PlayerState');
        source.playerDelta.rawState = null;
        return;
      }
      source.playerDelta.rawState = decoded.data;
      const confirmedLayout = source.lastStateLayout;
      let parsed = false;
      try {
        source.playerDelta.decodedState = this.decodeState(source, decoded.data);
        if (source.playerDelta.decodedState.complete) source.lastStateLayout = source.playerDelta.decodedState.layout;
        parsed = true;
      } catch (error) {
        source.playerDelta.decodedState = partialPlayerState(decoded.data);
        this.reportDecodeFailure(source.id, decoded, payload, error);
      }
      const audiencePrefix = decodeAudienceNetPrefix(decoded.data);
      if ((parsed || audiencePrefix) && this.onAudienceState) {
        try {
          this.onAudienceState({ session, source, decodedState: source.playerDelta.decodedState, audiencePrefix,
            confirmedLayout, snapshot: payload.snapshot, payload: payload.payload, generation: payload.levelChangeCount });
        } catch (error) { this.logger.warn?.({ err: error, playerId: source.id }, 'audience state observer failed'); }
      }
      return;
    }

    if (payload.type === GameMsgType.NetLevelData) {
      if (!this.levels.isAuthority(source, source.levelId)) {
        this.warn({
          playerId: source.id,
          levelId: source.levelId,
          authorityPlayerId: this.levels.getAuthority(source.levelId)?.id
        }, 'ignored level data from non-authority player');
        return;
      }

      const decoded = source.levelDelta.read(payload.snapshot, payload.payload);
      if (!decoded.ok) {
        return;
      }

      let levelDataMsg;
      try {
        levelDataMsg = decodeNetLevelDataMsg(decoded.data, {
          skipHeaderBytes: 0,
          maxDataBytes: NET_LEVEL_DATA_MAX_BYTES
        });
      } catch (error) {
        this.warn({
          err: error,
          errMessage: error.message,
          playerId: source.id,
          levelId: source.levelId,
          dataBytes: decoded.data?.length ?? 0,
          dataHex: decoded.data?.slice(0, 32).toString('hex') ?? 'none'
        }, 'ignored invalid level data stream');
        return;
      }

      if (levelDataMsg.trailingBytes !== 0) {
        const isAllZero = decoded.data.every(b => b === 0);
        if (isAllZero) {
          this.logger.debug({
            playerId: source.id,
            levelId: source.levelId,
            packetLevelId: levelDataMsg.levelId,
            trailingBytes: levelDataMsg.trailingBytes,
            dataLength: levelDataMsg.dataLength
          }, 'received empty level data snapshot (all zeros)');
          return;
        }
        // this.warn({
        //   playerId: source.id,
        //   levelId: source.levelId,
        //   packetLevelId: levelDataMsg.levelId,
        //   electedPlayer: levelDataMsg.electedPlayer,
        //   trailingBytes: levelDataMsg.trailingBytes,
        //   dataLength: levelDataMsg.dataLength,
        //   levelHash: levelDataMsg.levelHash
        // }, 'ignored level data stream with trailing bytes');
        return;
      }

      if (levelDataMsg.levelId !== source.levelId) {
        this.warn({
          playerId: source.id,
          sourceLevelId: source.levelId,
          packetLevelId: levelDataMsg.levelId
        }, 'ignored level data for mismatched level');
        return;
      }
      const levelId = source.levelId;
      this.levels.saveLevelData(levelId, {
        mergeState: levelDataMsg.mergeState ?? 0,
        unknown1: levelDataMsg.unknown1 ?? 0,
        unknown2: levelDataMsg.unknown2 ?? 0,
        unknown3: levelDataMsg.unknown3 ?? 0,
        levelHash: levelDataMsg.levelHash ?? 0,
        unknown4: levelDataMsg.unknown4 ?? 0,
        unknown5: levelDataMsg.unknown5 ?? 0,
        unknown6: levelDataMsg.unknown6 ?? 0,
        dataLength: levelDataMsg.dataLength ?? levelDataMsg.levelData?.length ?? 0,
        payload: levelDataMsg.levelData,
        updatedAt: Date.now(),
        authorityPlayerId: source.id
      });

      const signature = `${levelId}:${decoded.data.length}:${levelDataMsg.levelData?.length ?? 0}`;
      if (signature !== this.lastStoredLevelSignature) {
        this.lastStoredLevelSignature = signature;
        this.logger.debug({
          playerId: source.id,
          levelId,
          packetLevelId: levelDataMsg.levelId,
          dataBytes: decoded.data.length,
          levelDataBytes: levelDataMsg.levelData?.length ?? 0
        }, 'stored level data for tick sync');
      }
      return;
    }

    if (payload.type === GameMsgType.NetLevelDataElect) {
      this.warn({ playerId: source.id }, 'ignored server-only NetLevelDataElect from client');
      return;
    }

    if (payload.type === GameMsgType.NetLevelDataHeartbeat) {
      if (payload.levelId !== source.levelId) {
        this.logger.debug({
          playerId: source.id,
          playerLevelId: source.levelId,
          heartbeatLevelId: payload.levelId
        }, 'ignored level heartbeat for non-current level');
        return;
      }

      if (!this.levels.getAuthority(source.levelId)) {
        const players = this.activeInLevel(source.levelId);
        const next = this.selectAuthorityCandidate(source.levelId, players);
        if (next) {
          this.levels.setAuthority(source.levelId, next, { reason: 'heartbeat_no_authority' });
        }
      }
      return;
    }

    if (payload.type === GameMsgType.NetLevelDataRevoke) {
      this.penalizeAuthorityRevokeAttempt(source, payload);
      return;
    }

    if (payload.type === GameMsgType.NetLevelDataRevokeAck) {
      source.lastRevokeAck = {
        snapshot: payload.snapshot,
        bytes: payload.payload?.length ?? 0,
        updatedAt: Date.now()
      };
      this.logger.debug({
        playerId: source.id,
        snapshot: payload.snapshot,
        payloadBytes: payload.payload?.length ?? 0
      }, 'received level data revoke ack');
      return;
    }

    if (payload.type === GameMsgType.NetLevelElectionNominee) {
      if (payload.levelId !== source.levelId) {
        this.logger.debug?.({
          playerId: source.id,
          playerLevelId: source.levelId,
          nomineeLevelId: payload.levelId
        }, 'ignored election nominee for non-current level');
        return;
      }
      source.lastElectionNominee = {
        levelId: payload.levelId,
        reason: payload.reason,
        updatedAt: Date.now()
      };
      // The official server relays election nominees to the rest of the
      // level (capture: 322 C→S up, 74 S→C down in packetdump_20261030203945
      // — selective, same [levelId u32][reason u16] wire, source slot
      // rewritten to the nominee). Peers use it to learn who is running for
      // authority before the Elect lands.
      const nomineeBytes = Buffer.alloc(6);
      nomineeBytes.writeUInt32LE(payload.levelId, 0);
      nomineeBytes.writeUInt16LE(payload.reason ?? 0, 4);
      let relayed = 0;
      for (const peer of this.activeInLevel(source.levelId)) {
        if (peer === source) continue;
        this.broadcaster.send(peer.session, {
          id: PacketIds.GameMsg,
          payload: {
            type: GameMsgType.NetLevelElectionNominee,
            levelChangeCount: peer.lvSeq,
            sourcePlayer: source.id,
            payloadBytes: nomineeBytes
          }
        });
        relayed += 1;
      }
      if (relayed > 0) {
        this.logger.debug?.(
          { playerId: source.id, levelId: source.levelId, relayed },
          'relayed election nominee to the level'
        );
      }
      return;
    }

    if (payload.type === GameMsgType.SnapshotAck) {
      this.latestAcks.set(source.id, {
        playerAckSeq: payload.playerAckSeq,
        levelAckSeq: payload.levelAckSeq,
        updatedAt: Date.now()
      });
      source.playerDelta.ack(payload.playerAckSeq);
      source.levelDelta.ack(payload.levelAckSeq);
    }
  }

  penalizeAuthorityRevokeAttempt(source, payload) {
    const levelId = source.levelId;
    if (!this.levels.isAuthority(source, levelId)) {
      this.warn({
        playerId: source.id,
        levelId,
        authorityPlayerId: this.levels.getAuthority(levelId)?.id
      }, 'ignored NetLevelDataRevoke from non-authority player');
      return;
    }

    const levelPlayers = this.activeInLevel(levelId);
    this.levels.penalizeAuthorityCandidate(levelId, source);

    for (const target of levelPlayers) {
      this.sendRevoke(target, source, levelId, payload.reason ?? 0);
    }

    this.levels.revokeAuthority(levelId, { reason: 'authority_revoke_penalty' });
    const next = this.selectAuthorityCandidate(levelId, levelPlayers);

    if (next) {
      this.levels.setAuthority(levelId, next, {
        previousAuthorityPlayerId: source.id,
        reason: next === source ? 'sole_player_penalty_cleared' : 'authority_revoke_penalty'
      });
    }
  }

  selectAuthorityCandidate(levelId, players) {
    this.levels.pruneAuthorityCandidatePenalties?.(levelId, players);
    let next = players.find(player => !this.levels.isAuthorityCandidatePenalized?.(levelId, player));
    if (!next && players.length === 1) {
      next = players[0];
      this.levels.clearAuthorityPenalty?.(levelId, next);
    }
    return next;
  }

  sendRevokeAndElect(levelId, revokedAuthority, nextAuthority, initialData, reason = 0) {
    const levelPlayers = this.activeInLevel(levelId);
    for (const target of levelPlayers) {
      this.broadcaster.send(target.session, {
        id: PacketIds.GameMsg,
        payload: {
          type: GameMsgType.NetLevelDataRevoke,
          levelChangeCount: target.lvSeq,
          sourcePlayer: revokedAuthority?.id ?? 0,
          playerId: revokedAuthority?.id ?? 0,
          reason
        }
      });
      if (nextAuthority) {
        this.sendElect(target, nextAuthority, initialData);
      }
    }
  }

  sendRevoke(target, authority, levelId, reason = 0) {
    this.broadcaster.send(target.session, {
      id: PacketIds.GameMsg,
      payload: {
        type: GameMsgType.NetLevelDataRevoke,
        levelChangeCount: target.lvSeq,
        sourcePlayer: authority?.id ?? 0,
        playerId: authority?.id ?? 0,
        reason
      }
    });
  }

  sendElect(target, authority, initialData = undefined) {
    const levelPayload = this.createLevelElectPayload(authority, initialData);
    if (levelPayload.length > SNAPSHOT_MAX_DATA_BYTES) {
      this.warn({ targetPlayerId: target.id, levelId: authority?.levelId, dataBytes: levelPayload.length }, 'skipped oversized elect payload');
      return;
    }
    const electWriter = new SnapshotWriter();
    const frameBuffer = electWriter.write(levelPayload);
    const frame = frameBuffer && {
      sequence: frameBuffer[0],
      base: frameBuffer[1],
      checksum: frameBuffer[2],
      payload: frameBuffer.subarray(3)
    };

    if (!frame) {
      this.logger.debug({
        targetPlayerId: target.id,
        authorityPlayerId: authority?.id,
        levelId: authority?.levelId,
        levelPayloadLength: levelPayload?.length ?? 0
      }, 'sendElect skipped: frame too large');
      return;
    }

    if (this.packetDebug?.isEnabled({ id: PacketIds.GameMsg, payload: { type: GameMsgType.NetLevelDataElect } })) {
      this.logger.debug({
        targetPlayerId: target.id,
        authorityPlayerId: authority?.id,
        levelId: authority?.levelId,
        electedPlayer: authority?.id,
        hasInitialData: levelPayload?.hasInitialData,
        levelDataLength: levelPayload?.levelData?.length ?? 0,
        frameSeq: frame.sequence,
        frameBase: frame.base
      }, 'sending NetLevelDataElect');
    }

    this.broadcaster.send(target.session, {
      id: PacketIds.GameMsg,
      payload: {
        type: GameMsgType.NetLevelDataElect,
        levelChangeCount: target.lvSeq,
        sourcePlayer: 0,
        snapshot: {
          sequence: frame.sequence,
          base: frame.base,
          checksum: frame.checksum
        },
        payload: frame.payload
      }
    });

  }

  forwardToLevel(source, sourceSession, payload) {
    let forwarded = 0;
    for (const target of this.activeInLevel(source.levelId)) {
      if (target === source || target.session === sourceSession) {
        continue;
      }

      const outgoing = {
        ...payload,
        levelChangeCount: target.lvSeq
      };

      this.broadcaster.send(target.session, {
        id: PacketIds.GameMsg,
        payload: outgoing
      });
      forwarded += 1;
    }
    return forwarded;
  }

  syncLevelData() {
    for (const target of this.activePlayers()) {
      const levelId = target.levelId;
      if (levelId == null) continue;

      const authority = this.levels.getAuthority(levelId);
      if (!authority) continue;
      if (authority === target) continue;

      const levelData = this.levels.loadLevelData(levelId);
      if (!levelData) continue;

      const outgoing = encodeNetLevelDataMsg({
        ...levelData,
        electedPlayer: authority.id,
        levelId,
        hasInitialData: (levelData.payload?.length ?? 0) > 0,
        levelData: levelData.payload ?? Buffer.alloc(0)
      });

      if (outgoing.length > SNAPSHOT_MAX_DATA_BYTES) continue;
      const frame = target.levelDelta.write(outgoing);
      if (!frame) continue;


      this.broadcaster.send(target.session, {
        id: PacketIds.GameMsg,
        payload: {
          type: GameMsgType.NetLevelData,
          levelChangeCount: target.lvSeq,
          sourcePlayer: 0,
          snapshot: {
            sequence: frame.sequence,
            base:     frame.base,
            checksum: frame.checksum
          },
          payload: frame.payload
        }
      });
    }
  }

  syncPlayerStates() {
    const activePlayers = this.activePlayers();
    if (activePlayers.length < 2) {
      return;
    }

    // A session whose outgoing snapshot window collapsed (resyncfailed twice)
    // gets the id-5 SnapshotResync command: the client resets both channels
    // and demands a keyframe (asm-verified: sub_1A99E98 id-5 branch re-inits
    // both Writer/Reader pairs and writes the 0x0101 keyframe-needed flags).
    // The next write after the client's reset is a raw keyframe by
    // construction, so clear the flag right after sending.
    for (const peer of activePlayers) {
      for (const channel of [peer.playerDelta, peer.levelDelta]) {
        if (!channel.resyncRequired) continue;
        channel.resyncRequired = false;
        this.broadcaster.send(peer.session, {
          id: PacketIds.SnapshotResync,
          payload: {}
        });
        this.logger.debug?.(
          { playerId: peer.id, levelId: peer.levelId },
          'snapshot window unrecoverable; sent resync command'
        );
      }
    }

    const entries = [];
    for (const peer of activePlayers) {
      let raw = peer.playerDelta.rawState;
      const decoded = peer.playerDelta.decodedState;
      if (decoded && !decoded.minimal && !decoded.partial) {
        const cached = this.encodedStateCache.get(peer.id);
        if (cached && cached.decodedRef === decoded) {
          raw = cached.encoded;
        } else {
          try {
            raw = encodePlayerState(decoded);
            this.encodedStateCache.set(peer.id, { decodedRef: decoded, encoded: raw });
          } catch (error) {
            this.warn({
              sourcePlayerId: peer.id,
              levelId: peer.levelId,
              error: error?.message
            }, 'PlayerState field serialization failed; relaying raw state');
          }
        }
      }
      if (!raw || raw.length === 0) continue;

      const entryBytes = 1 + 4 + raw.length;
      if (raw.length > PLAYER_STATE_MAX_BYTES || entryBytes > SNAPSHOT_MAX_DATA_BYTES) {
        this.warn({ sourcePlayerId: peer.id, levelId: peer.levelId, stateBytes: raw.length }, 'syncPlayerStates: dropped oversized player state');
        continue;
      }

      const header = Buffer.allocUnsafe(5);
      header.writeUInt8(peer.id, 0);
      header.writeUInt32LE(raw.length, 1);
      entries.push({ peer, entry: Buffer.concat([header, raw], entryBytes) });
    }

    for (const target of activePlayers) {
      let batch = [];
      let batchBytes = 0;
      const flush = () => {
        if (batch.length === 0) return;
        const frame = target.playerDelta.write(Buffer.concat(batch.map(item => item.entry), batchBytes));
        if (frame) {
          this.broadcaster.send(target.session, {
            id: PacketIds.GameMsg,
            payload: {
              type: GameMsgType.PlayerStateDelta,
              levelChangeCount: target.lvSeq,
              sourcePlayer: 0,
              snapshot: {
                sequence: frame.sequence,
                base: frame.base,
                checksum: frame.checksum
              },
              payload: frame.payload
            }
          });
        }
        batch = [];
        batchBytes = 0;
      };

      for (const { peer, entry } of entries) {
        if (peer === target) continue;
        if (batchBytes + entry.length > SNAPSHOT_MAX_DATA_BYTES) flush();
        batch.push({ peer, entry });
        batchBytes += entry.length;
      }
      flush();
    }
  }

  forwardSnapshotToLevel(source, sourceSession, type, data, { levelId = source.levelId } = {}) {
    let forwarded = 0;
    let dropped = 0;

    for (const target of this.activeInLevel(levelId)) {
      if (target === source || target.session === sourceSession) {
        continue;
      }

      const state = type === GameMsgType.PlayerStateDelta
        ? target.playerDelta
        : target.levelDelta;
      if (data.length > SNAPSHOT_MAX_DATA_BYTES) {
        dropped += 1;
        continue;
      }
      const frame = state.write(data);

      if (!frame) {
        dropped += 1;
        this.warn({
          sourcePlayerId: source.id,
          targetPlayerId: target.id,
          levelId,
          type,
          dataBytes: data?.length ?? 0
        }, 'dropped snapshot forward because frame was too large');
        continue;
      }

      this.broadcaster.send(target.session, {
        id: PacketIds.GameMsg,
        payload: {
          type,
          levelChangeCount: target.lvSeq,
          sourcePlayer: source.id,
          snapshot: {
            sequence: frame.sequence,
            base: frame.base,
            checksum: frame.checksum
          },
          payload: frame.payload
        }
      });
      forwarded += 1;
    }

    if (type === GameMsgType.NetLevelData && forwarded === 0) {
      this.logger.debug({
        sourcePlayerId: source.id,
        levelId,
        playersInLevel: this.activeInLevel(levelId).map(player => player.id),
        dropped
      }, 'level data had no receiver in level');
    }

    return forwarded;
  }

  sendSnapshotAcks() {
    for (const target of this.activePlayers()) {
      this.broadcaster.send(target.session, {
        id: PacketIds.GameMsg,
        payload: {
          type: GameMsgType.SnapshotAck,
          levelChangeCount: target.lvSeq,
          sourcePlayer: 0,
          playerAckSeq: target.playerDelta.readAckSequence ?? 1,
          levelAckSeq: target.levelDelta.readAckSequence ?? 1
        }
      });
    }
  }

  createLevelElectPayload(authority, initialData) {
    const data = Buffer.from(initialData?.payload ?? initialData?.levelData ?? Buffer.alloc(0));
    const cached = this.levels.loadLevelData(authority.levelId);
    const payload = cached?.payload ? Buffer.from(cached.payload) : data;
    return encodeNetLevelDataMsg({
      ...(cached ?? {}),
      electedPlayer: authority.id,
      levelId: authority.levelId,
      hasInitialData: payload.length > 0,
      levelData: payload
    });
  }

  activePlayers() {
    const players = typeof this.players.listActive === 'function'
      ? this.players.listActive()
      : this.players.list();
    return players.filter(player => player.session?.isActive?.() ?? true);
  }

  activeInLevel(levelId) {
    const players = typeof this.players.listActiveInLevel === 'function'
      ? this.players.listActiveInLevel(levelId)
      : this.players.listInLevel(levelId);
    return players.filter(player => player.session?.isActive?.() ?? true);
  }
}