import { ProtocolError } from '../../errors.js';

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TgcUuid {
  constructor(bytes = Buffer.alloc(16)) {
    if (typeof bytes === 'string') {
      bytes = TgcUuid.parse(bytes);
    }
    if (!Buffer.isBuffer(bytes)) {
      throw new ProtocolError('TgcUuid requires 16 bytes', { type: typeof bytes });
    }
    if (bytes.length !== 16) {
      throw new ProtocolError('TgcUuid must be 16 bytes', { length: bytes.length });
    }

    this.bytes = Buffer.from(bytes);
  }

  // Room IDs and player UUIDs travel through the manager protocol as the same
  // textual form toString() produces, so accept it back symmetrically.
  static parse(text) {
    const value = String(text ?? '');
    if (!UUID_TEXT.test(value)) {
      throw new ProtocolError('invalid uuid text', { value });
    }
    return Buffer.from(value.replace(/-/g, ''), 'hex');
  }

  static isText(text) {
    return UUID_TEXT.test(String(text ?? ''));
  }

  static decode(reader) {
    return new TgcUuid(reader.readBytes(16));
  }

  encode(writer) {
    writer.writeBytes(this.bytes);
  }

  toString() {
    return [
      this.bytes.subarray(0, 4).toString('hex'),
      this.bytes.subarray(4, 6).toString('hex'),
      this.bytes.subarray(6, 8).toString('hex'),
      this.bytes.subarray(8, 10).toString('hex'),
      this.bytes.subarray(10, 16).toString('hex')
    ].join('-');
  }
}
