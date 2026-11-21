type Field = readonly [number, number | Uint8Array];

class Reader {
  private offset = 0;

  constructor(private bytes: Uint8Array) {}

  get done() {
    return this.offset === this.bytes.length;
  }

  varint(): number {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = this.bytes[this.offset++];
      if (byte === undefined || (shift === 63 && byte > 1)) break;
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("Invalid Antigravity protobuf varint");
  }

  take(length: number): Uint8Array {
    const start = this.offset;
    if (length > this.bytes.length - start) throw new Error("Truncated Antigravity protobuf field");
    this.offset += length;
    return this.bytes.subarray(start, this.offset);
  }
}

export function* fields(bytes: Uint8Array): Iterable<Field> {
  const reader = new Reader(bytes);
  while (!reader.done) {
    const key = reader.varint();
    const number = Math.floor(key / 8);
    if (number < 1 || number > 0x1fffffff) throw new Error("Invalid Antigravity protobuf tag");
    switch (key % 8) {
      case 0:
        yield [number, reader.varint()];
        break;
      case 2:
        yield [number, reader.take(reader.varint())];
        break;
      case 1:
        reader.take(8);
        break;
      case 5:
        reader.take(4);
        break;
      default:
        throw new Error("Unsupported Antigravity protobuf wire type");
    }
  }
}

export function firstIndex(value: Field[1]): number | undefined {
  // Repeated integers can appear as bare varints or a packed field.
  const index = value instanceof Uint8Array && value.length ? new Reader(value).varint() : value;
  return typeof index === "number" && Number.isSafeInteger(index) ? index : undefined;
}

export function milliseconds(value: Field[1] | undefined): number | null {
  if (!(value instanceof Uint8Array)) return null;
  const message = new Map(fields(value));
  const seconds = message.get(1) ?? 0;
  const nanos = message.get(2) ?? 0;
  if (
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    typeof nanos !== "number" ||
    nanos >= 1e9
  ) return null;
  return seconds * 1000 + nanos / 1e6;
}
