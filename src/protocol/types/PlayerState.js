import { isDeepStrictEqual } from 'node:util';
import { BinaryReader } from '../binary/BinaryReader.js';
import { BinaryWriter } from '../binary/BinaryWriter.js';
import { PLAYER_STATE_MAX_BYTES } from '../snapshot/constants.js';
import { ProtocolError } from '../../utils/errors.js';

// Sky.exe 0.34.5: sub_140c45090 and the serializers it calls.
// Native object offsets remain as IDs where no stable semantic name is known.
export const PLAYER_STATE_FIELD_SCHEMA = Object.freeze([
  ['stateKind', 'bounded-u8', 0, 4, 'state+0xb0'],
  ['position', 'vector3<float32>', 'state+0x5980'],
  ['net', 'struct', 'sub_140e149b0'],
  ['moveHeader', 'struct', 'sub_140e153c0'],
  ['move', 'struct', 'sub_140c44060'],
  ['body', 'BodyKeyFrame[0..4]', 'sub_1414f34f0'],
  ['queuedState', 'struct', 'sub_140c45c60'],
  ['action', 'struct', 'sub_140c443d0'],
  ['energy', 'struct', 'sub_140c44560'],
  ['anim', 'struct', 'sub_140c44790'],
  ['outfit', 'OutfitItem[10]', 'sub_140e228c0'],
  ['worldQuests', 'struct', 'sub_140e26fc0'],
  ['tail', 'struct', 'sub_140c44b60+']
]);

const VERSION = 'sky-0.34.5-sub_140c45090-v1';
const PI = Math.fround(Math.PI);

export function decodePlayerState(buffer, { maxBytes = PLAYER_STATE_MAX_BYTES } = {}) {
  const rawState = Buffer.from(buffer ?? []);
  assertStateSize(rawState, maxBytes);
  const io = new NativeIo(new BinaryReader(rawState));
  const fields = playerState(io);
  // const paddingBits = io.reader.bitOffset === 0 ? 0 : 8 - io.reader.bitOffset;
  // if (io.reader.remainingBits > paddingBits) {
  //   throw new ProtocolError('PlayerState has trailing data', { remainingBits: io.reader.remainingBits });
  // }
  return { version: VERSION, rawState, fields, complete: true, parsed: true,
    bits: io.bits, _originalFields: structuredClone(fields) };
}

export function encodePlayerState(state, { maxBytes = PLAYER_STATE_MAX_BYTES, preserveRaw = true } = {}) {
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
  playerState(new NativeIo(writer), state.fields);
  const encoded = writer.toBuffer();
  assertStateSize(encoded, maxBytes);
  return encoded;
}

class NativeIo {
  constructor(stream) {
    this.reader = stream instanceof BinaryReader ? stream : null;
    this.writer = stream instanceof BinaryWriter ? stream : null;
    this.scopeName = 'PlayerState';
    this.operation = 0;
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
  // o.offset_52bf = io.u8(v.offset_52bf);
  // o.offset_52b0 = io.u16(v.offset_52b0);
  // o.offset_519c = io.u32(v.offset_519c);
  // o.move = io.scoped('move', () => moveState(io, v.move));
  // const bodyCount = io.bounded(v.body?.length ?? v.bodyCount, 0, 4);
  // o.body = Array.from({ length: bodyCount }, (_, i) => io.scoped(`body[${i}]`, () => bodyKeyFrame(
  //   io, v.body?.[i], o.position, o.move.rotation0[0]
  // )));
  // o.queuedState = io.scoped('queuedState', () => queuedState(io, v.queuedState));
  // o.offset_5b54 = io.bounded(v.offset_5b54, 0, 3);
  // o.offset_5b30 = io.u32(v.offset_5b30);
  // o.offset_5a00 = io.vec(v.offset_5a00);
  // o.action = io.scoped('action', () => actionState(io, v.action));
  // o.energy = io.scoped('energy', () => energyState(io, v.energy));
  // o.offset_5a10 = io.vec(v.offset_5a10);
  // // suspected: look/facing direction; exact wire range is [-1, 1], pivot 0.
  // o.offset_5a20 = io.qv(v.offset_5a20, -1, 1, 0, 5);
  // o.anim = io.scoped('anim', () => animState(io, v.anim));
  // o.flags_5b87 = boolArray(io, v.flags_5b87, 4);
  // o.offset_5b10 = io.u8(v.offset_5b10);
  // o.offset_5aa4 = io.qf(v.offset_5aa4, 0, 1, 0, 4);
  // o.offset_5aac = io.f32(v.offset_5aac);
  // o.offset_52c8 = io.u8(v.offset_52c8);
  // o.offset_5b96 = io.bool(v.offset_5b96);
  // o.offset_52cc = io.bounded(v.offset_52cc, 0, 3);
  // o.offset_52cd = io.bounded(v.offset_52cd, 0, 3);
  // o.hasLookTarget = io.bool(v.hasLookTarget);
  // if (o.hasLookTarget) { o.lookTargetPlayerId = io.u8(v.lookTargetPlayerId); o.lookTarget = io.vec(v.lookTarget); }
  // o.offset_5198 = io.qf(v.offset_5198, 0, 50, 0, 8);
  // o.offset_52b4 = io.bounded(v.offset_52b4, -1, 32);
  // o.offset_52b8 = io.u16(v.offset_52b8);
  // // suspected: movement state bytes. These are raw u8, not packed bools.
  // o.bytes_52c0_52c2 = [io.u8(v.bytes_52c0_52c2?.[0]), io.u8(v.bytes_52c0_52c2?.[1])];
  // o.offset_52ba = io.bounded(v.offset_52ba, 0, 0x2a3);
  // o.offset_52bc = io.bounded(v.offset_52bc, 0, 0x2a3);
  // o.offset_52c1 = io.u8(v.offset_52c1);
  // o.offset_52be = io.bounded(v.offset_52be, 0, 0x11);
  // o.flags_52c3 = boolArray(io, v.flags_52c3, 4);
  // o.offset_5b53 = io.bounded(v.offset_5b53, 0, 0xd);
  // o.offset_5b18 = io.u8(v.offset_5b18);
  // o.offset_5ba5 = io.u8(v.offset_5ba5);
  // o.offset_5b44 = io.bounded(v.offset_5b44, -1, 0x10);
  // o.offset_5b48 = io.bounded(v.offset_5b48, -1, 8);
  // o.offset_5b8e = io.bool(v.offset_5b8e);
  // o.offset_5890 = io.bool(v.offset_5890);
  // o.poseVectors = Array.from({ length: 6 }, (_, i) => io.vec(v.poseVectors?.[i]));
  // o.offset_5904 = io.u8(v.offset_5904);
  // o.offset_5b8f = io.bool(v.offset_5b8f);
  // o.offset_5b6e = io.u8(v.offset_5b6e);
  // o.offset_5b5c = io.bounded(v.offset_5b5c, 0, 2);
  // o.offset_5b5d = io.bounded(v.offset_5b5d, 0, 2);
  // o.outfit = io.scoped('outfit', () => outfitState(io, v.outfit));
  // o.offset_5b5e = io.u8(v.offset_5b5e);
  // o.offset_5b40 = io.u32(v.offset_5b40 ?? 1);
  // o.offset_5b52 = io.bounded(v.offset_5b52, 0, 0xff);
  // o.offset_5b2c = io.u8(v.offset_5b2c);
  // const idCount = io.bounded(v.ids?.length ?? v.idCount, 0, 5, 'idCount/offset_5b5f');
  // o.ids = Array.from({ length: idCount }, (_, i) => io.u64(v.ids?.[i]));
  // o.offset_5b4c = io.u32(v.offset_5b4c);
  // o.offset_5b50 = io.u16(v.offset_5b50);
  // o.offset_5b1c = io.u8(v.offset_5b1c);
  // o.offset_5b90 = io.bool(v.offset_5b90);
  // o.offset_5ab0 = io.qf(v.offset_5ab0, 0, 1, 0, 4);
  // const playerCount = io.bounded(v.players?.length ?? v.playerCount, 0, 7);
  // o.players = Array.from({ length: playerCount }, (_, i) => io.u8(v.players?.[i]));
  // o.social = io.scoped('social', () => socialState(io, v.social));
  // o.worldQuests = io.scoped('worldQuests', () => worldQuestState(io, v.worldQuests));
  // o.offset_5b97 = io.bool(v.offset_5b97);
  // o.offset_5b66 = io.u16(v.offset_5b66); o.offset_5b68 = io.u16(v.offset_5b68);
  // o.offset_5b6a = io.u16(v.offset_5b6a); o.offset_5b6c = io.u16(v.offset_5b6c);
  // o.offset_52c5 = io.bool(v.offset_52c5);
  // o.tail = io.scoped('tail', () => tailState(io, v.tail, o.position));
  // o.offset_b4 = io.u32(v.offset_b4);
  // o.offset_54 = io.bytes(v.offset_54, 16); o.offset_64 = io.u32(v.offset_64);
  // o.offset_68 = io.bytes(v.offset_68, 16); o.offset_78 = io.u8(v.offset_78);
  // o.offset_88 = io.u64(v.offset_88); o.offset_80 = io.u32(v.offset_80);
  // o.flags_90 = boolArray(io, v.flags_90, 4); o.offset_a0 = io.vec(v.offset_a0);
  // o.flags_b8 = boolArray(io, v.flags_b8, 4); o.offset_5178 = io.bytes(v.offset_5178, 32);
  // o.finalFlags = Array.from({ length: 10 }, (_, i) => io.u8(v.finalFlags?.[i]));
  return o;
}

function netState(io, v = {}) { return {
  offset_4: io.u16(v.offset_4),
  // suspected: connection/movement modes; confirmed raw u8 values.
  bytes_6_7: [io.u8(v.bytes_6_7?.[0]), io.u8(v.bytes_6_7?.[1])],
  offset_8: io.bounded(v.offset_8, 0, 0x100), offset_a: io.u8(v.offset_a),
  offset_c: io.u32(v.offset_c), offset_0: io.bounded(v.offset_0, 0, 3),
  flags_1: boolArray(io, v.flags_1, 2)
}; }
function moveHeader(io, v = {}) { return {
  offset_0: io.u64(v.offset_0),
  // suspected: locomotion modes/timestamps; non-contiguous native fields.
  bytes_c_11_12_13: [io.u8(v.bytes_c_11_12_13?.[0]), io.u8(v.bytes_c_11_12_13?.[1]), io.u8(v.bytes_c_11_12_13?.[2]), io.u8(v.bytes_c_11_12_13?.[3])],
  flags_17_14: boolArray(io, v.flags_17_14, 2), offset_15: io.bounded(v.offset_15, 0, 0x30),
  offset_3a: io.bool(v.offset_3a), offset_3c: io.u16(v.offset_3c),
  offset_44: io.bounded(v.offset_44, 0, 3), offset_46: io.u16(v.offset_46)
}; }

function moveState(io, v = {}) { return {
  rotation0: io.qv(v.rotation0, -PI, PI, 0, 6), rotation1: io.qv(v.rotation1, -PI, PI, 0, 6),
  velocity: io.qv(v.velocity, -150, 150, 0, 8), direction0: io.qv(v.direction0, -1, 1, 0, 5),
  direction1: io.qv(v.direction1, -1, 1, 0, 5), direction2: io.qv(v.direction2, -1.5, 1.5, 0, 5),
  scalar0: io.qf(v.scalar0, -20, 20, 0, 5), scalar1: io.qf(v.scalar1, -20, 20, 0, 5),
  flag: io.bool(v.flag), direction3: io.qv(v.direction3, -1, 1, 0, 5)
}; }

function bodyKeyFrame(io, v = {}, base = [0, 0, 0], anglePivot = 0) {
  const time = io.qf(v.time, 0, 3, 0, 12);
  const weights = Array.from({ length: 6 }, (_, i) => io.qf(v.weights?.[i], 0, 1, 0, 3));
  const position = add3(base, io.qv(sub3(v.position, base), -25, 20, 0, 12));
  return { time, weights,
    position, normal: io.qv(v.normal, -1, 1, 0, 6), tangent: io.qv(v.tangent, -1, 1, 0, 8),
    point0: add3(position, io.qv(sub3(v.point0, position), -4, 4, 0, 8)),
    point1: add3(position, io.qv(sub3(v.point1, position), -2, 2, 0, 5)),
    point2: add3(position, io.qv(sub3(v.point2, position), -2, 2, 0, 5)),
    point3: add3(position, io.qv(sub3(v.point3, position), -2, 2, 0, 8)),
    point4: add3(position, io.qv(sub3(v.point4, position), -2, 2, 0, 8)),
    angle: io.qf(v.angle, -PI, PI, anglePivot, 10), flag: io.bool(v.flag) };
}

function queuedState(io, v = {}) {
  const o = { enabled: io.u8(v.enabled), id: io.u32(v.id), position: io.vec(v.position), rotation: io.qf(v.rotation, -PI, PI, 0, 6) };
  const n = io.bounded(v.frames?.length ?? v.count, 0, 4);
  o.frames = Array.from({ length: n }, (_, i) => bodyKeyFrame(io, v.frames?.[i], o.position, o.rotation));
  o.offset_2f0 = io.u32(v.offset_2f0); o.offset_2e0 = io.u64(v.offset_2e0);
  o.offset_2d0 = io.qf(v.offset_2d0, 0, 3, 0, 9); o.offset_2dc = io.f32(v.offset_2dc);
  o.bytes_2f5 = Array.from({ length: 4 }, (_, i) => io.u8(v.bytes_2f5?.[i]));
  o.offset_2ec = io.bounded(v.offset_2ec, 0, 8); return o;
}

function actionState(io, v = {}) { return { playerId: io.u8(v.playerId), amount0: io.qf(v.amount0, 0, 1, 0, 5), raw0: io.f32(v.raw0), amount1: io.qf(v.amount1, 0, 1, 0, 5), raw1: io.f32(v.raw1), raw2: io.f32(v.raw2), flags: boolArray(io, v.flags, 9), actionId: io.bounded(v.actionId, 0, 0x1401), signed0: io.bounded(v.signed0, -1, 8), signed1: io.bounded(v.signed1, -1, 8), finalFlag: io.u8(v.finalFlag) }; }
function energyState(io, v = {}) { const maxEnergy = io.bounded(v.maxEnergy, 0, 14); return { maxEnergy, normalized: io.qf(v.normalized, 0, 1, 0, 6), low: io.bool(v.low), current: io.qf(v.current, -3, maxEnergy, 0, 14), velocity: io.qf(v.velocity, -4, 4, 0, 8), onlyUseFlightEnergy: io.bool(v.onlyUseFlightEnergy), charge: io.qf(v.charge, 0, 10, 0, 5), flight: io.qf(v.flight, 0, 10, 0, 5), flags: boolArray(io, v.flags, 5), raw0: io.f32(v.raw0), scalar0: io.qf(v.scalar0, -1, 2, 0, 16), scalar1: io.qf(v.scalar1, 1, 2, 1.5, 8), raw1: io.f32(v.raw1) }; }
function animState(io, v = {}) { return { id: io.u32(v.id), time: io.u64(v.time), duration: io.qf(v.duration, 0, 3, 0, 12), raw: io.f32(v.raw), bytes: Array.from({ length: 4 }, (_, i) => io.u8(v.bytes?.[i])), mode: io.bounded(v.mode, 0, 8), variant: io.bounded(v.variant, 0, 10), weights: Array.from({ length: 3 }, (_, i) => io.qf(v.weights?.[i], 0, 1, 0, 5)), flag: io.bool(v.flag), blend: Array.from({ length: 5 }, (_, i) => io.qf(v.blend?.[i], 0, 1, 0, 8)), raw2: io.f32(v.raw2), final: io.qf(v.final, 0, 1, 0, 4) }; }

function outfitState(io, v = {}) {
  // sub_140e228c0 iterates r14 from 0x28 through 0x31 inclusive: 10 entries.
  // suspected: equipped cosmetic slots; exact per-slot semantic names are unknown.
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: io.u32(v.items?.[i]?.id),
    a: io.bounded(v.items?.[i]?.a, 0, 3, `items[${i}].offset_28`),
    b: io.bounded(v.items?.[i]?.b, 0, 3, `items[${i}].offset_32`),
    c: io.bounded(v.items?.[i]?.c, 0, 3, `items[${i}].offset_3c`),
    name: io.string(v.items?.[i]?.name, 64)
  }));
  return {
    items,
    scalar0: io.qf(v.scalar0, -3, 3, 0, 8),
    scalar1: io.qf(v.scalar1, -5, 3, 0, 8),
    type0: io.bounded(v.type0, 0, 15, 'type0/offset_65'),
    type1: io.bounded(v.type1, 0, 14, 'type1/offset_64'),
    id: io.u32(v.id),
    value: io.u16(v.value)
  };
}
function socialState(io, v = {}) { return { flags: boolArray(io, v.flags, 2), playerIds: [io.u8(v.playerIds?.[0]), io.u8(v.playerIds?.[1]), io.u8(v.playerIds?.[2])], flags2: boolArray(io, v.flags2, 2), type: io.bounded(v.type, 1, 2), mode: io.bounded(v.mode, 0, 3), scalar: io.qf(v.scalar, 0, 2, 0, 9), byte0: io.u8(v.byte0), byte1: io.bounded(v.byte1, 0, 2), signed: io.bounded(v.signed, -4, 4), final: io.u8(v.final) }; }
function worldQuestState(io, v = {}) {
  const version = io.u16(v.version);
  const id0 = io.u32(v.id0);
  const id1 = io.u32(v.id1);
  const enabled = io.bool(v.enabled);
  const count = io.bounded(v.count, 0, 0x100);
  return { version, id0, id1, enabled, count,
    flags: Array.from({ length: 0xff }, (_, i) => io.bool(i < count ? v.flags?.[i] : false)) };
}

function tailState(io, v = {}, position = [0, 0, 0]) { const masks = Array.from({ length: 16 }, (_, i) => boolArray(io, v.masks?.[i], 3)); return { masks, maskId: io.u32(v.maskId), table: slotTable(io, v.table, position), flag: io.bool(v.flag), type: io.bounded(v.type, 0, 25), byte: io.u8(v.byte), raw0: io.f32(v.raw0), flag2: io.bool(v.flag2), vector: io.vec(v.vector), id: io.u32(v.id), raw1: io.f32(v.raw1) }; }
function slotTable(io, v = {}, position = [0, 0, 0]) {
  const countA = io.bounded(v.countA, 0, 3);
  const header = { countA, h0: io.bounded(v.h0, 0, 0xa1), h1: io.bounded(v.h1, 0, 7), h2: io.bounded(v.h2, 0, 0xa1), h3: io.bounded(v.h3, 0, 0x200), h4: io.bounded(v.h4, 0, 0x200), h5: io.bounded(v.h5, 0, 0xa1) };
  const wireCountA = io.u8(v.wireCountA ?? countA); const countB = io.u8(v.countB);
  const slotsA = Array.from({ length: wireCountA }, (_, i) => ({ active: io.bool(v.slotsA?.[i]?.active) }));
  const slotsB = Array.from({ length: countB }, (_, i) => ({ active: io.bool(v.slotsB?.[i]?.active) }));
  for (let i = 0; i < slotsA.length; i += 1) if (slotsA[i].active) slotsA[i].kind = io.bool(v.slotsA?.[i]?.kind);
  for (let i = 0; i < slotsB.length; i += 1) if (slotsB[i].active) slotsB[i].flag = io.bool(v.slotsB?.[i]?.flag);
  for (let i = 0; i < slotsA.length; i += 1) if (slotsA[i].active) {
    slotsA[i].flag0 = io.bool(v.slotsA?.[i]?.flag0);
    slotsA[i].flag1 = io.bool(v.slotsA?.[i]?.flag1);
  }
  for (let i = 0; i < slotsA.length; i += 1) if (slotsA[i].active && slotsA[i].kind) {
    // suspected: nearby-player attachment flags and relative position.
    slotsA[i].nearFlag0 = io.bool(v.slotsA?.[i]?.nearFlag0);
    slotsA[i].nearFlag1 = io.bool(v.slotsA?.[i]?.nearFlag1);
    // Native writer clamps the relative vector's magnitude to four before
    // quantizing; the reader then restores the absolute position.
    const relative = clampVectorLength(sub3(v.slotsA?.[i]?.position, position), 4);
    slotsA[i].position = add3(position, io.qv(relative, -4, 4, 0, 6));
  }
  for (let i = 0; i < slotsA.length; i += 1) if (slotsA[i].active) { slotsA[i].value0 = io.bounded(v.slotsA?.[i]?.value0, 0, 0x7f); slotsA[i].value1 = io.bounded(v.slotsA?.[i]?.value1, 0, 0x7f); }
  return { ...header, wireCountA, countB, slotsA, slotsB };
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
