export class BinaryWriter {
  constructor(initialSize = 256) {
    this.buffer = Buffer.allocUnsafe(initialSize);
    this.offset = 0;
    this.bitOffset = 0;
  }

  alignToByte() {
    if (this.bitOffset !== 0) {
      this.offset += 1;
      this.bitOffset = 0;
    }
  }

  /**
   * Byte-aligned little-endian write — the client's `sub_1400372F0`.
   *
   * Mirrors {@link BinaryReader.readAlignedUInt}: the field starts on a byte
   * boundary, so any partial byte is closed first. The profile record mixes
   * these with bit-stream writes, and treating the whole thing as one bit
   * stream is what produced drifting, undecodable payloads.
   *
   * @param {number} value field value
   * @param {number} bytes field width in bytes
   */
  writeAlignedUInt(value, bytes) {
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > 8) {
      throw new RangeError(`invalid aligned width: ${bytes}`);
    }
    this.alignToByte();
    const numeric = BigInt.asUintN(
      bytes * 8,
      typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0))
    );
    this.ensure(bytes);
    let remaining = numeric;
    for (let index = 0; index < bytes; index += 1) {
      this.buffer[this.offset + index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    this.offset += bytes;
  }

  ensure(size) {
    const required = this.offset + size;
    if (required <= this.buffer.length) {
      return;
    }

    let nextSize = this.buffer.length;
    while (nextSize < required) {
      nextSize *= 2;
    }

    const next = Buffer.allocUnsafe(nextSize);
    this.buffer.copy(next, 0, 0, this.offset);
    this.buffer = next;
  }

  writeUInt8(value) {
    this.alignToByte();
    this.ensure(1);
    this.buffer.writeUInt8(value & 0xff, this.offset++);
  }

  writeUInt16(value) {
    this.alignToByte();
    this.ensure(2);
    this.buffer.writeUInt16LE(value & 0xffff, this.offset);
    this.offset += 2;
  }

  writeInt8(value) {
    this.alignToByte();
    this.ensure(1);
    this.buffer.writeInt8(Number(value), this.offset++);
  }

  writeInt16(value) {
    this.alignToByte();
    this.ensure(2);
    this.buffer.writeInt16LE(Number(value), this.offset);
    this.offset += 2;
  }

  writeUInt32(value) {
    this.alignToByte();
    this.ensure(4);
    this.buffer.writeUInt32LE(value >>> 0, this.offset);
    this.offset += 4;
  }

  writeUInt64(value) {
    this.alignToByte();
    this.ensure(8);
    this.buffer.writeBigUInt64LE(BigInt(value), this.offset);
    this.offset += 8;
  }

  writeDouble(value) {
    this.alignToByte();
    this.ensure(8);
    this.buffer.writeDoubleLE(Number(value), this.offset);
    this.offset += 8;
  }

  writeFloat(value) {
    this.alignToByte();
    this.ensure(4);
    this.buffer.writeFloatLE(Number(value), this.offset);
    this.offset += 4;
  }

  writeInt32(value) {
    this.alignToByte();
    this.ensure(4);
    this.buffer.writeInt32LE(Number(value) | 0, this.offset);
    this.offset += 4;
  }

  writeBounded(value, min, max) {
    if (!Number.isInteger(value) || !Number.isInteger(min) ||
        !Number.isInteger(max) || min >= max || value < min || value > max) {
      throw new RangeError(`bounded value ${value} is outside [${min}, ${max}]`);
    }
    const bits = Math.ceil(Math.log2(max - min + 1));
    this.writeBits(value - min, bits);
  }

  writeQuantizedFloat(value, min, max, pivot, bits) {
    this.writeBits(encodeQuantized(Number(value), min, max, pivot, bits), bits);
  }

  writeQuantizedVector3(value, min, max, pivot, bits) {
    const vector = value ?? [0, 0, 0];
    for (let index = 0; index < 3; index += 1) {
      this.writeQuantizedFloat(
        vector[index] ?? 0,
        component(min, index),
        component(max, index),
        component(pivot, index),
        bits
      );
    }
  }

  writeBytes(value) {
    this.alignToByte();
    const buffer = Buffer.from(value);
    this.ensure(buffer.length);
    buffer.copy(this.buffer, this.offset);
    this.offset += buffer.length;
  }

  pad(size) {
    this.alignToByte();
    this.ensure(size);
    this.buffer.fill(0, this.offset, this.offset + size);
    this.offset += size;
  }

  toBuffer() {
    this.alignToByte();
    return Buffer.from(this.buffer.subarray(0, this.offset));
  }

  writeBits(value, count) {
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      throw new RangeError(`invalid bit count: ${count}`);
    }
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 0 || (count < 32 && numeric >= 2 ** count)) {
      throw new RangeError(`value ${value} does not fit in ${count} bits`);
    }
    if (count === 0) return;
    this.ensure(Math.ceil((this.bitOffset + count) / 8));
    for (let index = 0; index < count; index += 1) {
      if (this.bitOffset === 0) this.buffer[this.offset] = 0;
      if (Math.floor(numeric / (2 ** index)) % 2 === 1) {
        this.buffer[this.offset] |= 1 << this.bitOffset;
      }
      this.bitOffset += 1;
      if (this.bitOffset === 8) {
        this.bitOffset = 0;
        this.offset += 1;
      }
    }
  }

  writeBool(value) {
    this.writeBits(value ? 1 : 0, 1);
  }

  writeCompressed(value, max = 0xff) {
    if (!Number.isInteger(max) || max < 0 || max > 0xffffffff) {
      throw new RangeError(`invalid compressed maximum: ${max}`);
    }
    const bits = max === 0 ? 0 : Math.ceil(Math.log2(max + 1));
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new RangeError(`compressed value ${value} exceeds ${max}`);
    }
    this.writeBits(value, bits);
  }
}

function component(value, index) {
  return Array.isArray(value) ? value[index] : value;
}

function encodeQuantized(value, min, max, pivot, bits) {
  if (!Number.isFinite(value)) value = 0;
  value = Math.max(min, Math.min(max, value));
  const levels = (2 ** bits) - 1;
  const pivotCode = Math.trunc(((pivot - min) * levels) / (max - min));
  if (value < pivot && pivot > min) {
    return Math.trunc(0.5 + ((value - min) / (pivot - min)) * pivotCode);
  }
  const upperLevels = levels - pivotCode;
  if (upperLevels === 0 || max === pivot) return pivotCode;
  return Math.trunc(0.5 + pivotCode + ((value - pivot) / (max - pivot)) * upperLevels);
}
