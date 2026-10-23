import { isDeepStrictEqual } from 'node:util';
import { BinaryReader } from '../binary/BinaryReader.js';
import { BinaryWriter } from '../binary/BinaryWriter.js';
import { PLAYER_STATE_MAX_BYTES } from '../snapshot/constants.js';
import { ProtocolError } from '../../errors.js';

// Sky.exe 0.35.1 (HotFix 1): sub_140C9F280 and the serializers it calls.
// Native object offsets remain as IDs where no stable semantic name is known.
//
// Cross-checked against the symbolized 0.15.1 libBootloader.so build, which
// still carries the same layout for most sub-records:
//   PlayerState::m_SerializeNet / Move / Body / QueuedState / Action / Energy /
//   Anim / Outfit / WorldQuests, plus PlayerId::Serialize, OutfitState::Serialize
//   and PlayerQueuedState::Serialize.
// That build fixes the semantics of several fields (see OUTFIT_SLOTS, dynU8 and
// the `suspected:` notes below). Where the two builds disagree, the 0.35.1
// serializer wins — noted inline at each such site.
export const PLAYER_STATE_FIELD_SCHEMA = Object.freeze([
  ['stateKind', 'bounded-u8', 0, 4, 'state+0xb0'],
  ['position', 'vector3<float32>', 'state+0x5990'],
  ['net', 'struct', 'sub_140E7F910 (state+0x5120)'],
  ['moveHeader', 'struct', 'sub_140E803C0 (state+0x5130)'],
  ['offset_52cb', 'u8', 'state+0x52cb'],
  ['offset_52b0', 'u16', 'state+0x52b0'],
  ['offset_519c', 'u32', 'state+0x519c'],
  ['offset_52b8', 'u8', 'state+0x52b8'],
  ['move', 'struct', 'sub_140C9E230'],
  ['body', 'BodyKeyFrame[0..4]', 'sub_1415A6B00, stride 0xb0'],
  ['queuedState', 'struct', 'sub_140C9FE70 (state+0x55a0)'],
  ['poseMode', 'bounded-u8', 0, 3, 'state+0x5b71'],
  ['levelMeshId', 'u32', 'state+0x5b48'],
  ['collideOffset', 'vector3<float32>', 'state+0x5a10'],
  ['action', 'struct', 'sub_140C9E5A0'],
  ['energy', 'struct', 'sub_140C9E740'],
  ['offset_5a20', 'vector3<float32>', 'state+0x5a20'],
  ['collideDirection', 'quantized vector3', '-1..1 pivot 0, 5 bits', 'state+0x5a30'],
  ['anim', 'struct', 'sub_140C9E970'],
  ['candle', 'struct', '4 bools + PlayerId + qf', 'state+0x5ba3'],
  ['follower', 'struct', 'f32 + PlayerId + bool + 2 bounded', 'state+0x5ab0'],
  ['lookTarget', 'struct', 'gated bool + PlayerId + vec3', 'state+0x5ba7'],
  ['offset_5198', 'quantized float', '0..50, 8 bits', 'state+0x5198'],
  ['offset_52c0', 'signed bounded', '-1..32', 'state+0x52c0'],
  ['offset_52c4..52d0', 'mixed', 'u16/u8/bounded/bools', 'state+0x52c4'],
  ['offset_5b30', 'PlayerId', 'state+0x5b30'],
  ['pose block', 'mixed', 'u8/bools/6x vec3', 'state+0x58a0'],
  ['outfit', 'OutfitItem[10]', 'sub_140E8D910 (state+0x5920)'],
  ['offset_5b58..5b44', 'mixed', 'u32/u8/bounded(0,255)/PlayerId', 'state+0x5b58'],
  ['buffs', 'Buff[0..5]', 'u8 id + u8 value', 'state+0x5ad0'],
  ['offset_5b64..5ac0', 'mixed', 'u32/u16/PlayerId/bool/qf', 'state+0x5b64'],
  ['offset_5b7d', 'PlayerId[0..7]', 'bounded count then ids', 'state+0x5b7d'],
  ['social', 'struct', 'sub_140C9EC00'],
  ['worldQuests', 'struct', 'sub_140E92270 (state+0x51a0)'],
  ['tail', 'struct', 'sub_140C9ED50'],
  ['trailer', 'mixed', 'u32/16-byte blobs/flags/vec3/32 bytes/10 u8', 'state+0xb4']
]);

const VERSION = 'sky-0.35.1-sub_140C9F280-v5';
const PI = Math.fround(Math.PI);

/**
 * Client builds do not all serialize the same field set: some write an 8-byte
 * value at state+0x52B8 and some omit it entirely, which shifts every later
 * field by 64 bits. Rather than hard-coding one build, each variant is tried
 * and the first one that consumes the record exactly wins.
 */
const LAYOUTS = Object.freeze([
  { id: 'u64-full', offset52b8: true },
  { id: 'u64-no-52b8', offset52b8: false }
]);
const DEFAULT_LAYOUT = LAYOUTS[0];

function resolveLayout(id) {
  return LAYOUTS.find((entry) => entry.id === id) ?? DEFAULT_LAYOUT;
}

// SocialOfferType. Values are 1-based on the wire; the 0.15.1 symbols index
// dword_13A3428[a1-1] for a1 in 1..20 and return 0 outside that range
// (GetRelationshipAbilityIdFromSocialOffer). Names come from the zh_cn
// "relationship_*" strings, which cover the same interaction set.
export const SOCIAL_OFFER_TYPES = Object.freeze([
  'addFriend',        // relationship_addfriend       是否送一支蜡烛和这个玩家成为朋友
  'bearHug',          // relationship_bearhug         熊抱
  'carry',            // relationship_carry           肩背
  'chat',             // relationship_chat            交谈
  'doubleFive',       // relationship_doublefive      双击掌
  'duetBow',          // relationship_duetbow         双人鞠躬
  'duetDance',        // relationship_duetdance       双人舞
  'fistBump',         // relationship_fistbump        碰拳
  'handHold',         // relationship_handhold        牵手
  'handShake',        // relationship_handshake       握手
  'highFive',         // relationship_highfive        击掌
  'hug',              // relationship_hug             拥抱
  'playFight',        // relationship_playfight       打闹
  'princessCarry',    // relationship_princesscarry   摇篮式抱姿
  'revolvingDance',   // relationship_revolvingdance  流转之舞
  'secretHandshake',  // relationship_secrethandshake 秘密握手
  'sideHug',          // relationship_sidehug         侧面拥抱
  'teleport',         // relationship_teleport        瞬移
  'tier',             // relationship_tier            朋友等级
  'whisper'           // relationship_whisper         耳语
]);

export function decodePlayerState(buffer, { maxBytes = PLAYER_STATE_MAX_BYTES, mode = 2, idTable = null, layout = null, preferredLayout = null } = {}) {
  const rawState = Buffer.from(buffer ?? []);
  assertStateSize(rawState, maxBytes);
  // Callers that already know which build this player runs can put that layout
  // first and skip the failed first attempt on every frame.
  const ordered = preferredLayout && !layout
    ? [...LAYOUTS.filter((entry) => entry.id === preferredLayout), ...LAYOUTS.filter((entry) => entry.id !== preferredLayout)]
    : null;
  const candidates = layout ? LAYOUTS.filter((entry) => entry.id === layout) : (ordered ?? LAYOUTS);
  let lastError;
  for (const candidate of candidates) {
    const io = new NativeIo(new BinaryReader(rawState), { mode, idTable, layout: candidate });
    try {
      const fields = playerState(io);
      // A correct layout consumes the record to the last byte; anything left
      // over means the variant guessed a different field set and drifted.
      if (io.reader.remainingBits > 7) {
        lastError = new ProtocolError('PlayerState layout left trailing data', {
          layout: candidate.id,
          remainingBits: io.reader.remainingBits
        });
        continue;
      }
      return { version: VERSION, layout: candidate.id, rawState, fields, complete: true, parsed: true,
        bits: io.bits, mode: io.mode, _originalFields: structuredClone(fields) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new ProtocolError('PlayerState could not be decoded');
}

/**
 * Header + move only: stateKind, position and velocity.
 *
 * Cross-room migration is driven by where a player is and how fast they are
 * moving; nothing below the move block is used. Stopping there skips the body
 * frames, the queued pose, the outfit strings and the whole tail, which is
 * where most of the cost — and most of the exposure to layout changes between
 * client builds — lives.
 *
 * The layout is not self-validating in this mode (there is no "consumed the
 * whole record" check), so callers pass the layout confirmed by a previous
 * full decode.
 */
export function decodePlayerStateLite(buffer, { maxBytes = PLAYER_STATE_MAX_BYTES, mode = 2, idTable = null, layout = null } = {}) {
  const rawState = Buffer.from(buffer ?? []);
  assertStateSize(rawState, maxBytes);
  const candidate = resolveLayout(layout);
  const io = new NativeIo(new BinaryReader(rawState), { mode, idTable, layout: candidate });
  const fields = {};
  fields.stateKind = io.bounded(undefined, 0, 4);
  fields.position = io.vec();
  fields.net = netState(io);
  fields.moveHeader = moveHeader(io);
  fields.offset_52cb = io.u8();
  fields.offset_52b0 = io.u16();
  fields.offset_519c = io.u32();
  if (candidate.offset52b8) fields.offset_52b8 = io.u64(0n);
  fields.move = io.scoped('move', () => moveState(io));
  return { version: VERSION, layout: candidate.id, rawState, fields, minimal: true, complete: false,
    parsed: true, bits: io.bits, mode: io.mode };
}

export function encodePlayerState(state, { maxBytes = PLAYER_STATE_MAX_BYTES, preserveRaw = true, mode = 2, idTable = null } = {}) {
  if (Buffer.isBuffer(state) || state instanceof Uint8Array) {
    const raw = Buffer.from(state);
    assertStateSize(raw, maxBytes);
    return raw;
  }
  if (!state || typeof state !== 'object' || !state.fields) {
    throw new ProtocolError('PlayerState must be bytes or a decoded state object');
  }
  if (preserveRaw && state.rawState && state._originalFields &&
      isDeepStrictEqual(state.fields, state._originalFields)) return Buffer.from(state.rawState);
  const writer = new BinaryWriter(PLAYER_STATE_MAX_BYTES);
  playerState(new NativeIo(writer, { mode, idTable, layout: resolveLayout(state.layout) }), state.fields);
  const encoded = writer.toBuffer();
  assertStateSize(encoded, maxBytes);
  return encoded;
}

class NativeIo {
  constructor(stream, { mode = 2, idTable = null, layout = DEFAULT_LAYOUT } = {}) {
    this.reader = stream instanceof BinaryReader ? stream : null;
    this.writer = stream instanceof BinaryWriter ? stream : null;
    this.scopeName = 'PlayerState';
    this.operation = 0;
    // Serialization mode for dynamic id fields (see dynU8).
    this.mode = [1, 2, 3].includes(mode) ? mode : 2;
    // Mode 2 needs the id<->slot table that the native side keeps on the
    // session (stride 23664 entries at +16).
    this.idTable = idTable;
    // Which optional fields this client build actually writes.
    this.layout = layout ?? DEFAULT_LAYOUT;
  }
  get bits() { const s = this.reader ?? this.writer; return s.offset * 8 + s.bitOffset; }
  bool(v = false) { return this.reader ? this.reader.readBool() : (this.writer.writeBool(v), !!v); }
  u8(v = 0) { return this.reader ? this.reader.readUInt8() : (this.writer.writeUInt8(v), v); }
  u16(v = 0) { return this.reader ? this.reader.readUInt16() : (this.writer.writeUInt16(v), v); }
  u32(v = 0) { return this.reader ? this.reader.readUInt32() : (this.writer.writeUInt32(v), v); }
  u64(v = 0n) { return this.reader ? this.reader.readUInt64() : (this.writer.writeUInt64(v), BigInt(v)); }
  f32(v = 0) { return this.reader ? this.reader.readFloat() : (this.writer.writeFloat(v), v); }
  bounded(v, min, max, field) {
    const x = v ?? min;
    const bitOffset = this.bits;
    this.operation += 1;
    try {
      return this.reader ? this.reader.readBounded(min, max) : (this.writer.writeBounded(x, min, max), x);
    } catch (error) {
      error.details = {
        ...error.details,
        scope: this.scopeName,
        field,
        operation: this.operation,
        bitOffset
      };
      throw error;
    }
  }
  // sub_140038A20: same fixed-width bounded integer, but the value is
  // stored as (value ^ 0x80000000) so the range spans negative numbers.
  sbounded(v, min, max, field) {
    const x = v ?? min;
    const offset = 0x80000000;
    const raw = this.reader ? null : ((x + offset) >>> 0);
    return this.reader
      ? (this.reader.readBounded(min + offset, max + offset) - offset)
      : (this.setSBounded(raw, min, max, field), x);
  }
  setSBounded(raw, min, max, field) {
    const bitOffset = this.bits;
    this.operation += 1;
    try {
      this.writer.writeBounded(raw, min + 0x80000000, max + 0x80000000);
    } catch (error) {
      error.details = { ...error.details, scope: this.scopeName, field, operation: this.operation, bitOffset };
      throw error;
    }
  }
  // sub_140E7D8E0 selects one of three wire encodings from the serialization
  // mode stored on the stream context (ctx+0x38):
  //   mode 1 — raw u8 (sub_140037B80)
  //   mode 2 — id compressed to a u8 slot through the id table
  //            (sub_140E745C0 on write, sub_140E74600 on read); the in-memory
  //            value stays a full u32 id.
  //   mode 3 — raw u32 (sub_140037C00)
  // Anything else is a hard error in the native path.
  // The 0.15.1 symbols name this exact function PlayerId::Serialize and its
  // mode-2 helpers NetPlayerBarn::PlayerIdToNetPlayerId / NetPlayerIdToPlayerId,
  // confirming the three-way split and that mode 2 is a u8 net-id slot.
  //
  // The 0.35.1 upload path settles the mode: sub_140E69750 stores 2 into the
  // extra block it passes to sub_140037A80, which copies it verbatim into
  // ctx+0x38. So every PlayerId field on the wire is a u8 net-id slot.
  dynU8(v = 0) {
    if (this.mode === 3) return this.reader ? this.reader.readUInt32() : (this.writer.writeUInt32(v), v);
    if (this.mode === 2) return this._dynMappedId(v);
    if (this.mode === 1) return this.u8(v);
    throw new ProtocolError('dynamic id field has no negotiated mode', { mode: this.mode, scope: this.scopeName });
  }
  // Mode 2: the wire carries the u8 net-id slot, not the full 32-bit id.
  // Without a mapping table the slot is the identity, which is correct for
  // every id that already fits in a byte (the only kind this server hands out:
  // net ids are 1..0xff).
  _dynMappedId(v) {
    if (this.reader) {
      const slot = this.reader.readUInt8();
      return this.idTable ? this.idTable.idForSlot(slot) : slot;
    }
    const slot = this.idTable ? this.idTable.slotForId(v) : v;
    this.writer.writeUInt8(slot & 0xff);
    return v;
  }
  scoped(name, callback) {
    const previous = this.scopeName;
    this.scopeName = name;
    try { return callback(); } finally { this.scopeName = previous; }
  }
  qf(v, min, max, pivot, bits) { const x = v ?? pivot; return this.reader ? this.reader.readQuantizedFloat(min, max, pivot, bits) : (this.writer.writeQuantizedFloat(x, min, max, pivot, bits), x); }
  qv(v, min, max, pivot, bits) { const x = v ?? [0, 0, 0]; return this.reader ? this.reader.readQuantizedVector3(min, max, pivot, bits) : (this.writer.writeQuantizedVector3(x, min, max, pivot, bits), x); }
  vec(v = [0, 0, 0]) { return [this.f32(v[0]), this.f32(v[1]), this.f32(v[2])]; }
  bytes(v, size) {
    if (this.reader) return Buffer.from(this.reader.readBytes(size));
    const b = Buffer.from(v ?? Buffer.alloc(size));
    if (b.length !== size) throw new ProtocolError('fixed PlayerState field has wrong size', { size, actual: b.length });
    this.writer.writeBytes(b); return b;
  }
  string(v = '', max = 64) {
    if (this.reader) {
      const n = this.reader.readUInt32();
      if (n < 1 || n > max) throw new ProtocolError('PlayerState string length out of range', { size: n, max });
      const b = this.reader.readBytes(n);
      if (b[n - 1] !== 0) throw new ProtocolError('PlayerState string is not NUL terminated');
      return b.subarray(0, n - 1).toString('utf8');
    }
    const b = Buffer.concat([Buffer.from(String(v), 'utf8'), Buffer.from([0])]);
    if (b.length > max) throw new ProtocolError('PlayerState string too long', { size: b.length, max });
    this.writer.writeUInt32(b.length); this.writer.writeBytes(b); return v;
  }
}

function playerState(io, v = {}) {
  const o = {};
  o.stateKind = io.bounded(v.stateKind, 0, 4);
  o.position = io.vec(v.position);
  o.net = netState(io, v.net);
  o.moveHeader = moveHeader(io, v.moveHeader);
  o.offset_52cb = io.u8(v.offset_52cb);
  o.offset_52b0 = io.u16(v.offset_52b0);
  o.offset_519c = io.u32(v.offset_519c);
  // 0.35.1 inserts an 8-byte field at state+0x52B8 between offset_519c and
  // move (sub_140C9F280 +0x10B -> sub_140037C30, the 8-byte sizer). Some
  // client builds omit it; see LAYOUTS.
  if (io.layout.offset52b8) o.offset_52b8 = io.u64(v.offset_52b8 ?? 0n);
  o.move = io.scoped('move', () => moveState(io, v.move));
  const bodyCount = io.bounded(v.body?.length ?? v.bodyCount, 0, 4);
  o.body = Array.from({ length: bodyCount }, (_, i) => io.scoped(`body[${i}]`, () => bodyKeyFrame(
    io, v.body?.[i], o.position, o.move.rotation0[0]
  )));
  o.queuedState = io.scoped('queuedState', () => queuedState(io, v.queuedState));
  // state+0x5b71 (A70, 0..3) then state+0x5b48 (C00, u32).
  o.poseMode = io.bounded(v.offset_5b54 ?? v.poseMode, 0, 3);
  o.levelMeshId = io.u32(v.levelMeshId);
  // sub_140C9F280 serializes state+0x5A10 right here, before the action
  // block; the [vec3][qv] collision pair at 0x5A20/0x5A30 comes after energy.
  o.collideOffset = io.vec(v.collideOffset ?? v.offset_5a10);
  o.action = io.scoped('action', () => actionState(io, v.action));
  o.energy = io.scoped('energy', () => energyState(io, v.energy));
  o.offset_5a20 = io.vec(v.offset_5a20);
  o.collideDirection = io.qv(v.collideDirection ?? v.facing ?? v.offset_5a30, -1, 1, 0, 5);
  o.anim = io.scoped('anim', () => animState(io, v.anim));
  // 0.15.1 m_SerializeCandle = [4×bool][PlayerId][qf 0..1, 4 bits], which maps
  // one-to-one onto the 0.35.1 sequence at 0x5ba3..0x5ba6, 0x5b28 and 0x5ab4.
  o.candleState = boolArray(io, v.candleState ?? v.flags_5ba3, 4);
  o.candlePlayerId = io.dynU8(v.candlePlayerId ?? v.offset_5b28);
  o.candleCharge = io.qf(v.candleCharge ?? v.offset_5ab4, 0, 1, 0, 4);
  // 0.15.1 m_SerializeFollower = [f32][PlayerId][u32][u2][u2]; 0.35.1 narrows
  // the u32 to a u8 (0x5bb2) and keeps the two 2-bit enums at 0x52d8/0x52d9.
  o.followerScalar = io.f32(v.followerScalar ?? v.offset_5abc);
  o.followerPlayerId = io.dynU8(v.followerPlayerId ?? v.offset_52d4);
  o.followerState = io.bool(v.followerState ?? v.offset_5bb2);
  o.followerSlotA = io.bounded(v.followerSlotA ?? v.offset_52d8, 0, 3);
  o.followerSlotB = io.bounded(v.followerSlotB ?? v.offset_52d9, 0, 3);
  // Gated triple at state+0x5BA7: when set, a PlayerId at 0x5B2C and a vec3 at
  // 0x5A40 follow. This is 0.15.1's m_SerializeLookTarget — sub_140C9F280 has
  // exactly one [bool][PlayerId][vec3] group, so there is no second one.
  o.offset_5ba7 = io.bool(v.offset_5ba7);
  if (o.offset_5ba7) {
    o.offset_5b2c = io.dynU8(v.offset_5b2c);
    o.offset_5a40 = io.vec(v.offset_5a40);
  }
  // The 0x52xx block is 0.35.1-only (0.15.1 has no such fields), so these are
  // named from their producers in GetPlayerStateFromAvatar (0x140CA0090):
  //   5198 <- [avatar+0x88]+0x260        (f32)
  //   52c0 <- [avatar+0xb89c]            (u32)
  //   52c4 <- [avatar+0xb86c]            (u16)
  //   52c6 <- sub_141795840(avatar+0x80) (u16, 0..0x2a3 clamped on write)
  //   52c8 <- [avatar+0x80]+0x172ba      (u16, 0..0x2a3 clamped on write)
  //   52cc <- sub_1413C0AA0(..., 2)      (u8)
  //   52cd <- sub_1413C0AA0(..., 7)      (u8)
  //   52ce <- [avatar+0x80]+0x172b8      (u8)
  //
  // Two of the producers are now identified further:
  //   - sub_141795840 returns min(used, cap) over the three u16s at
  //     [avatar+0x80]+0x1729c/0x1729e/0x172a0, i.e. a clamped count.
  //   - sub_1413C0AA0(ptr, n) is a plain indexed getter over a u32 array, so
  //     52cc is element[4] and 52cd element[9].
  // The remaining question is only what that array/those offsets mean.
  o.offset_5198 = io.qf(v.offset_5198, 0, 50, 0, 8);
  // Signed 32-bit bounded -1..32 (sub_140038A20 flips the sign bit).
  o.offset_52c0 = io.sbounded(v.offset_52c0, -1, 32);
  o.offset_52c4 = io.u16(v.offset_52c4);
  o.offset_52cc = io.u8(v.offset_52cc);
  o.offset_52ce = io.u8(v.offset_52ce);
  o.offset_52c6 = io.bounded(v.offset_52c6, 0, 0x2a3);
  o.offset_52c8_2 = io.bounded(v.offset_52c8_2, 0, 0x2a3);
  o.offset_52cd = io.u8(v.offset_52cd);
  o.offset_52ca = io.bounded(v.offset_52ca, 0, 0x11);
  // Four independent bools. GetPlayerStateFromAvatar (0x140CA0090) shows the
  // sources for the first two: 0x52cf from avatar+0x80 -> +0x1af62, and
  // 0x52d0 from a `sub_141748570(avatar+0x98, 0x0d) != 0` probe.
  o.offset_52cf = io.bool(v.offset_52cf);
  o.offset_52d0 = io.bool(v.offset_52d0);
  o.offset_5ba8 = io.bool(v.offset_5ba8);
  o.offset_5ba9 = io.bool(v.offset_5ba9);
  // state+0x5b30 goes through PlayerId::Serialize, so it is dynamically sized.
  o.offset_5b30 = io.dynU8(v.offset_5b30);
  o.offset_5bc2 = io.u8(v.offset_5bc2);
  // state+0x5b5c / 0x5b60 are signed bounded (-1..16 and -1..8).
  o.offset_5b5c = io.sbounded(v.offset_5b5c, -1, 0x10);
  o.offset_5b60 = io.sbounded(v.offset_5b60, -1, 8);
  // state+0x5baa bool, then 0x58a0 bool and six raw pose vec3s (0x58b0..0x5900).
  o.offset_5baa = io.bool(v.offset_5baa);
  o.offset_5890 = io.bool(v.offset_5890);
  o.poseVectors = Array.from({ length: 6 }, (_, i) => io.vec(v.poseVectors?.[i]));
  o.offset_5914 = io.u8(v.offset_5914);
  o.offset_5bab = io.bool(v.offset_5bab);
  o.offset_5b8a = io.u8(v.offset_5b8a);
  // Two 2-bit clamps at 0x5B79/0x5B7A sit between 0x5B8A and the outfit block.
  o.offset_5b79 = io.bounded(v.offset_5b79, 0, 2, 'offset_5b79');
  o.offset_5b7a = io.bounded(v.offset_5b7a, 0, 2, 'offset_5b7a');
  // outfit (0x5920), then 0x5B7B u8, 0x5B58 u32, 0x5B6C bounded u8.
  o.outfit = io.scoped('outfit', () => outfitState(io, v.outfit));
  o.offset_5b7b = io.u8(v.offset_5b7b);
  o.offset_5b58 = io.u32(v.offset_5b58);
  o.offset_5b6c = io.bounded(v.offset_5b6c, 0, 255, 'offset_5b6c');
  // PlayerId::Serialize at 0x5b44 — the player this state is attached to.
  o.attachedPlayerId = io.dynU8(v.offset_5b44 ?? v.attachedPlayerId);
  // Active buff list immediately follows the attached PlayerId: sub_140C9F280
  // emits [count 0..5] then `count` pairs of [id:u8][value:u8]. The 0.15.1
  // symbol m_SerializeBuffs describes the same slots over a stride-8 array.
  // `ids` is the pre-rename spelling of the same field; accept whichever list
  // the caller actually populated.
  const buffSrc = (v.buffs?.length ? v.buffs : v.ids) ?? [];
  const buffCount = io.bounded(buffSrc.length || v.buffCount || v.idCount, 0, 5, 'buffCount/offset_5b7c');
  o.buffs = Array.from({ length: buffCount }, (_, i) => {
    const item = buffSrc[i];
    const id = io.u8(typeof item === 'object' && item !== null ? item.id : item);
    const value = io.u8(typeof item === 'object' && item !== null ? item.value ?? item.flags : v.buffValues?.[i] ?? v.idFlags?.[i]);
    return { id, value, flags: value };
  });
  // 0x5b64 u32, 0x5b68 u16, 0x5b34 PlayerId, 0x5bac bool, 0x5ac0 qf(0..1,4bit).
  o.offset_5b64 = io.u32(v.offset_5b64);
  o.offset_5b68 = io.u16(v.offset_5b68);
  o.offset_5b34 = io.dynU8(v.offset_5b34);
  o.offset_5bac = io.bool(v.offset_5bac);
  o.offset_5ac0 = io.qf(v.offset_5ac0, 0, 1, 0, 4);
  // Count at 0x5B7D (0..7) followed by that many PlayerIds from 0x5B08.
  const attachedCount = io.bounded(v.offset_5b7d?.length ?? v.offset_5b7dCount, 0, 7, 'offset_5b7d');
  o.offset_5b7d = Array.from({ length: attachedCount }, (_, i) => io.dynU8(v.offset_5b7d?.[i]));
  o.social = io.scoped('social', () => socialState(io, v.social));
  o.worldQuests = io.scoped('worldQuests', () => worldQuestState(io, v.worldQuests));
  // 0x5bb3 bool, then the four u16s at 0x5b82/0x5b84/0x5b86/0x5b88, then
  // 0x52d1 bool, then the tail record.
  o.offset_5bb3 = io.bool(v.offset_5bb3);
  o.offset_5b82 = io.u16(v.offset_5b82);
  o.offset_5b84 = io.u16(v.offset_5b84);
  o.offset_5b86_u16 = io.u16(v.offset_5b86_u16);
  o.offset_5b88 = io.u16(v.offset_5b88);
  o.offset_52d1 = io.bool(v.offset_52d1 ?? v.offset_52c5);
  o.tail = io.scoped('tail', () => tailState(io, v.tail, o.position));
  o.offset_b4 = io.u32(v.offset_b4);
  o.offset_54 = io.bytes(v.offset_54, 16); o.offset_64 = io.u32(v.offset_64);
  o.offset_68 = io.bytes(v.offset_68, 16); o.offset_78 = io.u8(v.offset_78);
  o.offset_88 = io.u64(v.offset_88 ?? 0n); o.offset_80 = io.u32(v.offset_80);
  o.flags_90 = boolArray(io, v.flags_90, 4); o.offset_a0 = io.vec(v.offset_a0);
  o.flags_b8 = boolArray(io, v.flags_b8, 4); o.offset_5178 = io.bytes(v.offset_5178, 32);
  o.finalFlags = Array.from({ length: 10 }, (_, i) => io.u8(v.finalFlags?.[i]));
  return o;
}

// sub_140E7F910.
function netState(io, v = {}) { return {
  offset_4: io.u16(v.offset_4),
  // suspected: locomotion/connection mode bytes (raw u8, not packed bools).
  modeBytes: [io.u8(v.modeBytes?.[0] ?? v.bytes_6_7?.[0]), io.u8(v.modeBytes?.[1] ?? v.bytes_6_7?.[1])],
  offset_8: io.bounded(v.offset_8, 0, 0x100),
  offset_a: io.u8(v.offset_a),
  offset_c: io.u32(v.offset_c),
  offset_0: io.bounded(v.offset_0, 0, 3),
  flags: boolArray(io, v.flags ?? v.flags_1, 2)
}; }
// sub_140E803C0. Native offsets are relative to state+0x5130.
function moveHeader(io, v = {}) { return {
  // sub_140037C30 is the 64-bit serializer (8-byte memcpy), not a u8.
  offset_0: io.u64(v.offset_0 ?? 0n),
  bytes_c_11_12_13: [io.u8(v.bytes_c_11_12_13?.[0]), io.u8(v.bytes_c_11_12_13?.[1]), io.u8(v.bytes_c_11_12_13?.[2]), io.u8(v.bytes_c_11_12_13?.[3])],
  flags_17_14: boolArray(io, v.flags_17_14, 2),
  offset_15: io.bounded(v.offset_15, 0, 0x30),
  offset_3a: io.bool(v.offset_3a),
  offset_3c: io.u16(v.offset_3c),
  offset_44: io.bounded(v.offset_44, 0, 3),
  offset_46: io.u16(v.offset_46)
}; }

// sub_140C9E230, serialized inside a "move" scope. Rotations are Euler
// triples over ±π; velocity is ±150 units/s, i.e. the flight/glide speed cap.
function moveState(io, v = {}) { return {
  // suspected: body rotation and an animation-relative rotation.
  rotation0: io.qv(v.rotation0, -PI, PI, 0, 6),
  rotation1: io.qv(v.rotation1, -PI, PI, 0, 6),
  // world velocity, the same range used by flight.
  velocity: io.qv(v.velocity, -150, 150, 0, 8),
  // suspected: unit-facing basis plus a wider third axis.
  direction0: io.qv(v.direction0, -1, 1, 0, 5),
  direction1: io.qv(v.direction1, -1, 1, 0, 5),
  direction2: io.qv(v.direction2, -1.5, 1.5, 0, 5),
  // AvatarPose::Update feeds these two straight into the pose's roll/pitch
  // (it reads state+36/37 as floats), so they are body lean angles, not a
  // walk-cycle phase.
  scalar0: io.qf(v.scalar0, -20, 20, 0, 5),
  scalar1: io.qf(v.scalar1, -20, 20, 0, 5),
  // suspected: grounded/flying toggle.
  flag: io.bool(v.flag),
  direction3: io.qv(v.direction3, -1, 1, 0, 5)
}; }

// sub_1415A6B00 — one procedural body keyframe (cape/prop cloth chain).
// Every vector is stored relative to a nearby anchor and quantized over a
// shrinking range (base ±20 → ±4 → ±2), which is what keeps the frame small.
function bodyKeyFrame(io, v = {}, base = [0, 0, 0], anglePivot = 0) {
  const time = io.qf(v.time, 0, 3, 0, 12);
  // suspected: 6-way skinning weights for the body chain.
  const weights = Array.from({ length: 6 }, (_, i) => io.qf(v.weights?.[i], 0, 1, 0, 3));
  const position = add3(base, io.qv(sub3(v.position, base), -20, 20, 0, 12));
  return {
    time,
    weights,
    position,
    // suspected: cloth surface frame.
    normal: io.qv(v.normal, -1, 1, 0, 6),
    tangent: io.qv(v.tangent, -1, 1, 0, 8),
    // suspected: five cloth nodes hanging off the body position.
    point0: add3(position, io.qv(sub3(v.point0, position), -4, 4, 0, 8)),
    point1: add3(position, io.qv(sub3(v.point1, position), -2, 2, 0, 5)),
    point2: add3(position, io.qv(sub3(v.point2, position), -2, 2, 0, 5)),
    point3: add3(position, io.qv(sub3(v.point3, position), -2, 2, 0, 8)),
    point4: add3(position, io.qv(sub3(v.point4, position), -2, 2, 0, 8)),
    // suspected: twist angle around the body axis.
    angle: io.qf(v.angle, -PI, PI, anglePivot, 10),
    flag: io.bool(v.flag)
  };
}

// sub_140C9FE70 (state+0x55a0). A one-slot lookahead buffer for the upcoming
// body pose, which the client uses while transitioning between animations.
// 0.15.1 PlayerQueuedState::Serialize also writes offset_2e0 as a u64; 0.35.1
// keeps the u64 (sub_140C9FE70 -> sub_140037C30, the 8-byte serializer) and
// adds the leading pendingFlag u8.
function queuedState(io, v = {}) {
  const o = {
    pendingFlag: io.u8(v.pendingFlag ?? v.offset_2f9),
    id: io.u32(v.id),
    position: io.vec(v.position),
    rotation: io.qf(v.rotation, -PI, PI, 0, 6)
  };
  const n = io.bounded(v.frames?.length ?? v.count, 0, 4, 'queuedState.count/offset_2f4');
  o.frames = Array.from({ length: n }, (_, i) => bodyKeyFrame(io, v.frames?.[i], o.position, o.rotation));
  o.offset_2f0 = io.u32(v.offset_2f0);
  o.blendByte = io.u64(v.blendByte ?? v.offset_2e0 ?? 0n);
  o.blendWeight = io.qf(v.blendWeight ?? v.offset_2d0, 0, 3, 0, 9);
  o.blendRaw = io.f32(v.blendRaw ?? v.offset_2dc);
  // sub_140C9FE70 emits four consecutive u8s at 0x2F5..0x2F8 before queueMode.
  o.reserved = Array.from({ length: 4 }, (_, i) => io.u8(v.reserved?.[i] ?? v.bytes_2f5?.[i]));
  o.queueMode = io.bounded(v.queueMode ?? v.offset_2ec, 0, 8);
  return o;
}

// sub_140C9E5A0. Drives the emote/expression currently playing
// ("emote_category_gesture" 动作, "emote_category_dance" 舞蹈 …).
// The leading field is a PlayerId::Serialize call, i.e. dynamically sized.
//
// Version split: the 0.15.1 m_SerializeAction ends with four nested bools plus
// a gated u32, while 0.35.1 writes a flat 10-bool block and an unconditional
// actionId. The 0.35.1 shape is used here.
function actionState(io, v = {}) {
  return {
    // target player of the emote, e.g. "accept_highfive" 解锁<2>击掌</2>
    playerId: io.dynU8(v.playerId),
    // suspected: normalized emote progress and its raw float twin.
    progress0: io.qf(v.progress0 ?? v.amount0, 0, 1, 0, 5),
    raw0: io.f32(v.raw0),
    progress1: io.qf(v.progress1 ?? v.amount1, 0, 1, 0, 5),
    raw1: io.f32(v.raw1),
    raw2: io.f32(v.raw2),
    flags: boolArray(io, v.flags, 10),
    // emote/action id, bounded to 0x1401 by the native serializer.
    actionId: io.bounded(v.actionId, 0, 0x1401),
    signed0: io.sbounded(v.signed0, -1, 8),
    signed1: io.sbounded(v.signed1, -1, 8),
    finalFlag: io.u8(v.finalFlag)
  };
}
// sub_140C9E740. Names follow the zh_cn energy/flight strings:
//   "system_loading_wing_buffs" 寻找飞行元气, "buff_effect_energy_charge_mult" 元气满满,
//   "buff_effect_wing_add" 飞行祝福 (the cape/wing charge used to fly).
function energyState(io, v = {}) {
  // maxEnergy is the cape tier (achievement_wing_master_desc: 达到斗篷等级10).
  // wingTier is an accepted input alias only; the canonical output is maxEnergy.
  const maxEnergy = io.bounded(v.wingTier ?? v.maxEnergy, 0, 14);
  return {
    maxEnergy,
    wingTier: maxEnergy,
    normalized: io.qf(v.normalized, 0, 1, 0, 6),
    low: io.bool(v.low),
    // current wing charge, clamped against the tier above.
    current: io.qf(v.wingCharge ?? v.current, -3, maxEnergy, 0, 14),
    velocity: io.qf(v.velocity, -4, 4, 0, 8),
    // "元气满满"/"飞行祝福": charge gained from candles and wing buffs.
    onlyUseFlightEnergy: io.bool(v.onlyUseFlightEnergy),
    charge: io.qf(v.charge, 0, 10, 0, 5),
    flight: io.qf(v.flight, 0, 10, 0, 5),
    flags: boolArray(io, v.flags, 5),
    raw0: io.f32(v.raw0),
    scalar0: io.qf(v.scalar0, -1, 2, 0, 16),
    scalar1: io.qf(v.scalar1, 1, 2, 1.5, 8),
    raw1: io.f32(v.raw1)
  };
}
// sub_140C9E970. Serialized inside an "anim" scope.
// Both builds write this field as a full u64: 0.35.1 calls sub_140037C30,
// which memcpy's 8 bytes.
function animState(io, v = {}) {
  return {
    // animation clip hash.
    id: io.u32(v.id),
    // suspected: playback position in 1/8 s ticks.
    time: io.u64(v.time ?? 0n),
    // suspicious: clip duration, quantized to 12 bits over 0..3 s.
    duration: io.qf(v.duration, 0, 3, 0, 12),
    raw: io.f32(v.raw),
    reserved: Array.from({ length: 4 }, (_, i) => io.u8(v.reserved?.[i] ?? v.bytes?.[i])),
    // AvatarPose::Update treats 7 as "action animation in progress" and uses
    // it to gate the blend weights below.
    mode: io.bounded(v.mode, 0, 8),
    // suspected: clip variant within the layer.
    variant: io.bounded(v.variant, 0, 10),
    // suspected: 3-way animation blend weights.
    weights: Array.from({ length: 3 }, (_, i) => io.qf(v.weights?.[i], 0, 1, 0, 5)),
    flag: io.bool(v.flag),
    // Animation blend weights: AvatarPose::Update smooths the first three of
    // these (state+616/617/618) against the pose's own weights each frame.
    blend: Array.from({ length: 5 }, (_, i) => io.qf(v.blend?.[i], 0, 1, 0, 8)),
    raw2: io.f32(v.raw2),
    // suspected: normalized final blend factor.
    blendFinal: io.qf(v.blendFinal ?? v.final, 0, 1, 0, 4)
  };
}

// Equipped cosmetic slots, named after the zh_cn "buff_effect_outfit_*" strings.
//
// Two independent findings fix the count at 10 for 0.35.1:
//   - the 0.35.1 serializer (sub_140E8D910) walks value slots 0..9;
//     OutfitDefs in the 0.15.1 symbols walks 0..8 (kOutfitSlot_Count = 9,
//     asserted in OutfitDefs::GetOptionCount / GetIdByName), so one slot was
//     added between those builds.
//   - the zh_cn localization exposes exactly these 10 buff_effect_outfit_*
//     entries, which is why the names line up one-to-one.
export const OUTFIT_SLOTS = Object.freeze([
  'hair',   // buff_effect_outfit_hair  发型
  'hat',    // buff_effect_outfit_hat   发饰
  'horn',   // buff_effect_outfit_horn  头饰
  'mask',   // buff_effect_outfit_mask  面具
  'face',   // buff_effect_outfit_face  脸部配件
  'neck',   // buff_effect_outfit_neck  项链
  'body',   // buff_effect_outfit_body  裤子
  'feet',   // buff_effect_outfit_feet  鞋子
  'wing',   // buff_effect_outfit_wing  斗篷
  'prop'    // buff_effect_outfit_prop  道具
]);

function outfitState(io, v = {}) {
  const items = Array.from({ length: OUTFIT_SLOTS.length }, (_, i) => {
    const slot = OUTFIT_SLOTS[i];
    const src = v.item?.[slot] ?? v.items?.[i];
    return {
      slot,
      // selected option id for this slot (OutfitDefs::GetOptionById).
      id: io.u32(src?.id),
      // Dye/variant indices. AvatarOutfit::SetState reduces these with
      // `value % OptionById[130/164/198]` onto the option's three tint lists,
      // so 0..3 is the on-wire cap for each of them.
      tintA: io.bounded(src?.tintA ?? src?.a, 0, 3, `items[${i}].offset_28`),
      tintB: io.bounded(src?.tintB ?? src?.b, 0, 3, `items[${i}].offset_32`),
      tintC: io.bounded(src?.tintC ?? src?.c, 0, 3, `items[${i}].offset_3c`),
      name: io.string(src?.name, 64)
    };
  });
  return {
    items,
    // suspected: dye mix scalars for the equipped slots.
    tintScalar0: io.qf(v.tintScalar0 ?? v.scalar0, -3, 3, 0, 8),
    tintScalar1: io.qf(v.tintScalar1 ?? v.scalar1, -5, 3, 0, 8),
    // suspected: hair tint variant selectors (buff_effect_hairtint*).
    hairTintType: io.bounded(v.hairTintType ?? v.type0, 0, 15, 'type0/offset_65'),
    outfitType: io.bounded(v.outfitType ?? v.type1, 0, 14, 'type1/offset_64'),
    id: io.u32(v.id),
    value: io.u16(v.value)
  };
}
// sub_140C9EC00. Tracks the hand-holding / hug / carry relationships that the
// zh_cn strings expose ("menu_handhold" 手牵手跟着朋友走, "menu_hug" 给我一个拥抱,
// "accept_carry" 解锁<2>肩背</2>). The three player ids are dynamically sized, and a
// trailing u8 (state+0x5b8b) is serialized after the friendship level.
function socialState(io, v = {}) {
  const o = { flags: boolArray(io, v.flags, 2) };
  // suspected: the partner(s) this player is attached to.
  o.playerIds = [io.dynU8(v.playerIds?.[0]), io.dynU8(v.playerIds?.[1]), io.dynU8(v.playerIds?.[2])];
  o.flags2 = boolArray(io, v.flags2, 2);
  // suspected: interaction kind selector.
  o.type = io.bounded(v.type, 1, 2);
  o.mode = io.bounded(v.mode, 0, 3);
  o.scalar = io.qf(v.scalar, 0, 2, 0, 9);
  o.byte0 = io.u8(v.byte0);
  o.byte1 = io.bounded(v.byte1, 0, 2);
  // suspected: friendship level ("accept_tier" 升级<2>朋友等级</2>), -4..4.
  o.signed = io.sbounded(v.friendshipLevel ?? v.signed, -4, 4);
  o.final = io.bool(v.final);
  o.offset_5b8b = io.u8(v.offset_5b8b);
  return o;
}
// sub_140E92270. The flag loop always serializes 0x100 booleans; `count` only
// selects which of them carry state. Indices at or above `count` are written
// as false, and the loop returns after index 0xFF — 256 reads, not 255.
// Version split: 0.15.1 m_SerializeWorldQuests is a completely different shape
// (16 groups of 3 bools + StarFragmentBarn + u4 + i16 + float), so this record
// must be read with the 0.35.1 layout only.
function worldQuestState(io, v = {}) {
  const version = io.u16(v.version);
  const id0 = io.u32(v.id0);
  const id1 = io.u32(v.id1);
  const enabled = io.bool(v.enabled);
  const count = io.bounded(v.count, 0, 0x100);
  return { version, id0, id1, enabled, count,
    flags: Array.from({ length: 0x100 }, (_, i) => io.bool(i < count ? v.flags?.[i] : false)) };
}

// sub_140C9ED50. The "tail" of the state: the cape/prop cloth chain that hangs
// behind the player ("buff_effect_outfit_wing" 斗篷, "buff_effect_outfit_prop" 道具).
// 16 mask triples, then the u32 mask id and the slot table, then the scalars.
function tailState(io, v = {}, position = [0, 0, 0]) {
  const masks = Array.from({ length: 16 }, (_, i) => boolArray(io, v.masks?.[i], 3));
  return {
    masks,
    // suspected: active cape/prop item id for the cloth chain.
    maskId: io.u32(v.maskId),
    table: slotTable(io, v.table, position),
    flag: io.bool(v.flag),
    // suspected: cloth chain type, 26 possible values.
    type: io.bounded(v.type, 0, 25),
    byte: io.u8(v.byte),
    raw0: io.f32(v.raw0),
    flag2: io.bool(v.flag2),
    vector: io.vec(v.vector),
    id: io.u32(v.id),
    raw1: io.f32(v.raw1)
  };
}

// sub_140C9EE00. Both slot counts are serialized back to back, then the
// native serializer makes four *interleaved* passes over the arrays:
//   pass 1: A[i].active, A[i].kind, B[i].active, B[i].flag
//   pass 2: A[i].near0, A[i].near1        (when A[i].active && A[i].kind)
//   pass 3: A[i].value0, A[i].value1
// Each pass is bounded by its own count, so a slot's sub-fields are only
// present when that slot's own gate bit is set on the wire.
function slotTable(io, v = {}, position = [0, 0, 0]) {
  const countA = io.bounded(v.countA, 0, 3);
  const header = { countA, h0: io.bounded(v.h0, 0, 0xa1), h1: io.bounded(v.h1, 0, 7), h2: io.bounded(v.h2, 0, 0xa1), h3: io.bounded(v.h3, 0, 0x200), h4: io.bounded(v.h4, 0, 0x200), h5: io.bounded(v.h5, 0, 0xa1) };

  // sub_140037B80: both counts are plain u8 and adjacent on the wire.
  const wireCountA = io.u8(v.wireCountA ?? countA);
  const wireCountB = io.u8(v.wireCountB ?? v.countB);
  const slotsA = Array.from({ length: wireCountA }, () => ({}));
  const slotsB = Array.from({ length: wireCountB }, () => ({}));

  // pass 1 — sub_140C9EE00 walks A slot by slot: `active`, then `kind` only
  // when that slot is active. B follows with a single bool per slot.
  for (let i = 0; i < wireCountA; i += 1) {
    slotsA[i].active = io.bool(v.slotsA?.[i]?.active);
    if (slotsA[i].active) slotsA[i].kind = io.bool(v.slotsA?.[i]?.kind);
  }
  for (let i = 0; i < wireCountB; i += 1) slotsB[i].active = io.bool(v.slotsB?.[i]?.active);

  // pass 2 — A attachment bits + clamped relative position
  for (let i = 0; i < wireCountA; i += 1) {
    if (!slotsA[i].active || !slotsA[i].kind) continue;
    slotsA[i].nearFlag0 = io.bool(v.slotsA?.[i]?.nearFlag0);
    slotsA[i].nearFlag1 = io.bool(v.slotsA?.[i]?.nearFlag1);
    // Native writer clamps the relative vector's magnitude to four before
    // quantizing; the reader then restores the absolute position.
    const relative = clampVectorLength(sub3(v.slotsA?.[i]?.position, position), 4);
    slotsA[i].position = add3(position, io.qv(relative, -4, 4, 0, 6));
  }

  // pass 3 — A value pairs
  for (let i = 0; i < wireCountA; i += 1) {
    if (!slotsA[i].active) continue;
    slotsA[i].value0 = io.bounded(v.slotsA?.[i]?.value0, 0, 0x7f);
    slotsA[i].value1 = io.bounded(v.slotsA?.[i]?.value1, 0, 0x7f);
  }
  return { ...header, wireCountA, wireCountB, countB: wireCountB, slotsA, slotsB };
}

function boolArray(io, values = [], count) { return Array.from({ length: count }, (_, i) => io.bool(values?.[i])); }
function sub3(value = [0, 0, 0], base = [0, 0, 0]) { return [0, 1, 2].map((i) => (value?.[i] ?? base?.[i] ?? 0) - (base?.[i] ?? 0)); }
function add3(base = [0, 0, 0], delta = [0, 0, 0]) { return [0, 1, 2].map((i) => (base?.[i] ?? 0) + (delta?.[i] ?? 0)); }
function clampVectorLength(value, maxLength) {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length === 0 || length <= maxLength) return value;
  const scale = maxLength / length;
  return value.map((componentValue) => componentValue * scale);
}
function assertStateSize(buffer, maxBytes) { if (buffer.length > maxBytes) throw new ProtocolError('PlayerState exceeds latest serializer limit', { stateBytes: buffer.length, max: maxBytes }); }
