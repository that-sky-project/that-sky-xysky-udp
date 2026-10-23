import { ProtocolError } from '../../errors.js';

function parseIpv6(host) {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

function formatIpv6(groups) {
  const text = groups.map((group) => group.toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < text.length;) {
    if (text[start] !== '0') { start += 1; continue; }
    let end = start;
    while (end < text.length && text[end] === '0') end += 1;
    if (end - start > bestLength) [bestStart, bestLength] = [start, end - start];
    start = end;
  }
  if (bestLength < 2) return text.join(':');
  const left = text.slice(0, bestStart).join(':');
  const right = text.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

export class NetAddress {
  constructor({ host = '127.0.0.1', port = 0, type } = {}) {
    this.host = host;
    this.port = port;
    this.type = type ?? (host.includes(':') ? 2 : 1);
  }

  static fromBytes(bytes) {
    return new NetAddress({
      host: `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`,
      port: bytes.readUInt16LE(4)
    });
  }

  static decode(reader) {
    return NetAddress.fromBytes(reader.readBytes(6));
  }

  static decodeTyped(reader) {
    const type = reader.readCompressed(3);
    let host;
    if (type === 0) {
      host = '0.0.0.0';
    } else if (type === 1) {
      const value = reader.readUInt32();
      host = [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24].join('.');
    } else if (type === 2) {
      const groups = [];
      for (let index = 0; index < 4; index += 1) {
        const word = reader.readUInt32();
        groups.push(
          ((word & 0xff) << 8) | ((word >>> 8) & 0xff),
          (((word >>> 16) & 0xff) << 8) | (word >>> 24)
        );
      }
      host = formatIpv6(groups);
    } else if (type === 3) {
      host = '0.0.0.0';
    } else {
      throw new ProtocolError('unsupported network address type', { type });
    }
    const hasPort = reader.readBool();
    const port = hasPort ? reader.readUInt16() : 0;
    return new NetAddress({ host, port, type });
  }

  encode(writer) {
    const parts = this.host.split('.').map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
      throw new ProtocolError('invalid IPv4 address', { host: this.host });
    }

    writer.writeUInt8(parts[0]);
    writer.writeUInt8(parts[1]);
    writer.writeUInt8(parts[2]);
    writer.writeUInt8(parts[3]);
    writer.writeUInt16(this.port);
  }

  encodeTyped(writer) {
    const type = this.type ?? (this.host.includes(':') ? 2 : 1);
    if (![0, 1, 2, 3].includes(type)) throw new ProtocolError('unsupported network address type', { type });
    writer.writeCompressed(type, 3);
    if (type === 0 || type === 3) {
      // Address-less variants still carry the optional-port bit.
    } else if (type === 1) {
      const parts = this.host.split('.').map(Number);
      if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        throw new ProtocolError('invalid IPv4 address', { host: this.host });
      }
      writer.writeUInt32((parts[0] | (parts[1] << 8) | (parts[2] << 16) | (parts[3] << 24)) >>> 0);
    } else {
      const groups = parseIpv6(this.host);
      if (!groups) {
        throw new ProtocolError('invalid IPv6 address', { host: this.host });
      }
      for (let index = 0; index < 8; index += 2) {
        const first = groups[index];
        const second = groups[index + 1];
        writer.writeUInt32((
          (first >>> 8) |
          ((first & 0xff) << 8) |
          (second >>> 8) << 16 |
          (second & 0xff) << 24
        ) >>> 0);
      }
    }
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 0xffff) {
      throw new ProtocolError('invalid network address port', { port: this.port });
    }
    const hasPort = this.port !== 0;
    writer.writeBool(hasPort);
    if (hasPort) writer.writeUInt16(this.port);
  }

  toApi() {
    return {
      host: this.host,
      port: this.port
    };
  }
}
