import { ProtocolError } from '../../errors.js';

export class BinaryReader {
  constructor(buffer) {
    this.buffer = Buffer.from(buffer);
    this.offset = 0;
    this.bitOffset = 0;
  }

  get remaining() {
    return this.buffer.length - this.offset - (this.bitOffset ? 1 : 0);
  }

  get remainingBits() {
    return (this.buffer.length - this.offset) * 8 - this.bitOffset;
  }

  alignToByte() {
    if (this.bitOffset !== 0) {
      this.offset += 1;
      this.bitOffset = 0;
    }
  }

  ensure(size) {
    this.alignToByte();
    if (this.remaining < size) {
      throw new ProtocolError('packet buffer underflow', {
        offset: this.offset,
        need: size,
        remaining: this.remaining
      });
    }
  }

  skip(size) {
    this.alignToByte();
    this.ensure(size);
    this.offset += size;
  }

  readUInt8() {
    this.alignToByte();
    this.ensure(1);
    return this.buffer.readUInt8(this.offset++);
  }

  readUInt16() {
    this.alignToByte();
    this.ensure(2);
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  readInt8() {
    this.alignToByte();
    this.ensure(1);
    return this.buffer.readInt8(this.offset++);
  }

  readInt16() {
    this.alignToByte();
    this.ensure(2);
    const value = this.buffer.readInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  readUInt32() {
    this.alignToByte();
    this.ensure(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readUInt64() {
    this.alignToByte();
    this.ensure(8);
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  readDouble() {
    this.alignToByte();
    this.ensure(8);
    const value = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  readFloat() {
    this.alignToByte();
    this.ensure(4);
    const value = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return value;
  }

  readInt32() {
    this.alignToByte();
    this.ensure(4);
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readBounded(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max) {
      throw new ProtocolError('invalid bounded integer range', { min, max });
    }
    const range = max - min;
    const bits = Math.ceil(Math.log2(range + 1));
    const encoded = this.readBits(bits);
    if (encoded > range) {
      throw new ProtocolError('bounded integer exceeds range', { encoded, min, max });
    }
    return min + encoded;
  }

  readQuantizedFloat(min, max, pivot, bits) {
    return decodeQuantized(this.readBits(bits), min, max, pivot, bits);
  }

  readQuantizedVector3(min, max, pivot, bits) {
    return [0, 1, 2].map((index) => this.readQuantizedFloat(
      component(min, index), component(max, index), component(pivot, index), bits
    ));
  }

  readBytes(size) {
    this.alignToByte();
    this.ensure(size);
    const value = this.buffer.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  readBits(count) {
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      throw new ProtocolError('invalid bit count', { count });
    }
    if (this.remainingBits < count) {
      throw new ProtocolError('packet buffer underflow', {
        offset: this.offset,
        bitOffset: this.bitOffset,
        needBits: count,
        remainingBits: this.remainingBits
      });
    }
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const bit = (this.buffer[this.offset] >>> this.bitOffset) & 1;
      value += bit * (2 ** index);
      this.bitOffset += 1;
      if (this.bitOffset === 8) {
        this.bitOffset = 0;
        this.offset += 1;
      }
    }
    return value >>> 0;
  }

  readBool() {
    return this.readBits(1) !== 0;
  }

  // SerializeCompressed(max) uses the minimum fixed bit width, not a varint.
  readCompressed(max = 0xff) {
    if (!Number.isInteger(max) || max < 0 || max > 0xffffffff) {
      throw new ProtocolError('invalid compressed maximum', { max });
    }
    const bits = max === 0 ? 0 : Math.ceil(Math.log2(max + 1));
    const value = bits === 0 ? 0 : this.readBits(bits);
    if (value > max) {
      throw new ProtocolError('compressed value exceeds maximum', { value, max });
    }
    return value;
  }
}

function component(value, index) {
  return Array.isArray(value) ? value[index] : value;
}

function decodeQuantized(code, min, max, pivot, bits) {
  const levels = (2 ** bits) - 1;
  const pivotCode = Math.trunc(((pivot - min) * levels) / (max - min));
  if (code <= pivotCode) {
    return pivotCode === 0 ? min : min + ((pivot - min) * code) / pivotCode;
  }
  const upperLevels = levels - pivotCode;
  return upperLevels === 0 ? max : pivot + ((max - pivot) * (code - pivotCode)) / upperLevels;
}
