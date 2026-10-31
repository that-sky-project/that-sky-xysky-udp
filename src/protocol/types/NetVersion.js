export class NetVersion {
  constructor(values = []) {
    this.values = Array.from({ length: 6 }, (_, index) => Number(values[index] ?? 0) & 0xffff);
  }

  get levelHash() {
    return this.values[0] ?? 0;
  }

  static decode(reader) {
    return new NetVersion(Array.from({ length: 6 }, () => reader.readUInt16()));
  }

  encode(writer) {
    for (const value of this.values) {
      writer.writeUInt16(value);
    }
  }
}
