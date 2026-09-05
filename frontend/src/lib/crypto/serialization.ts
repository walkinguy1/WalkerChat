/**
 * Canonical wire encoding for ratchet messages.
 *
 * Every variable-length field is explicitly length-prefixed and every fixed field has
 * a checked length. Ambiguous concatenation -- where two different field splits produce
 * the same bytes -- is a classic source of protocol breaks, and it matters doubly here
 * because these bytes are fed to AES-GCM as associated data. If a receiver could parse
 * the same bytes two ways, the AD binding would not actually bind anything.
 */
import { KEY_LEN, concat, fromUtf8, utf8 } from './primitives';

export const MESSAGE_TYPE_PREKEY = 1;
export const MESSAGE_TYPE_NORMAL = 2;

/** Fixed 40-byte ratchet header: ratchet public key, previous chain length, index. */
export const HEADER_LEN = KEY_LEN + 4 + 4;

export type MessageHeader = {
  /** Sender's current ratchet public key. */
  dh: Uint8Array;
  /** Number of messages in the previous sending chain. */
  pn: number;
  /** Index of this message within the current sending chain. */
  n: number;
};

export type PreKeyMessageFields = {
  /** Initiator's long-term identity key, so the responder can run X3DH. */
  identityKey: Uint8Array;
  /** Initiator's ephemeral key. */
  ephemeralKey: Uint8Array;
  /** Which of the responder's one-time prekeys was consumed, if any. */
  oneTimePreKeyId: string | null;
  /** Which signed prekey was used, so rotation does not break in-flight messages. */
  signedPreKeyId: string;
};

export type RatchetMessage =
  | { type: typeof MESSAGE_TYPE_NORMAL; header: MessageHeader; ciphertext: Uint8Array }
  | {
      type: typeof MESSAGE_TYPE_PREKEY;
      prekey: PreKeyMessageFields;
      header: MessageHeader;
      ciphertext: Uint8Array;
    };

class Writer {
  private readonly parts: Uint8Array[] = [];

  byte(value: number): this {
    this.parts.push(new Uint8Array([value & 0xff]));
    return this;
  }

  uint32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error('uint32 out of range: ' + value);
    }
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    this.parts.push(out);
    return this;
  }

  fixed(value: Uint8Array, length: number): this {
    if (value.length !== length) {
      throw new Error('Expected ' + length + ' bytes, got ' + value.length);
    }
    this.parts.push(value);
    return this;
  }

  /** Length-prefixed variable-length field. */
  bytes(value: Uint8Array): this {
    if (value.length > 0xffff) {
      throw new Error('Field too long to encode: ' + value.length);
    }
    const prefix = new Uint8Array(2);
    new DataView(prefix.buffer).setUint16(0, value.length, false);
    this.parts.push(prefix, value);
    return this;
  }

  /** Optional string, encoded as a presence flag plus a length-prefixed body. */
  optionalString(value: string | null): this {
    if (value === null) {
      return this.byte(0);
    }
    return this.byte(1).bytes(utf8(value));
  }

  string(value: string): this {
    return this.bytes(utf8(value));
  }

  /** Everything remaining, with no prefix. Only valid as the final field. */
  rest(value: Uint8Array): this {
    this.parts.push(value);
    return this;
  }

  finish(): Uint8Array {
    return concat(...this.parts);
  }
}

class Reader {
  private offset = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  private take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.data.length) {
      throw new Error('Malformed message: truncated at offset ' + this.offset);
    }
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  byte(): number {
    return this.take(1)[0];
  }

  uint32(): number {
    const slice = this.take(4);
    return new DataView(slice.buffer, slice.byteOffset, 4).getUint32(0, false);
  }

  fixed(length: number): Uint8Array {
    return Uint8Array.from(this.take(length));
  }

  bytes(): Uint8Array {
    const prefix = this.take(2);
    const length = new DataView(prefix.buffer, prefix.byteOffset, 2).getUint16(0, false);
    return Uint8Array.from(this.take(length));
  }

  optionalString(): string | null {
    return this.byte() === 0 ? null : fromUtf8(this.bytes());
  }

  string(): string {
    return fromUtf8(this.bytes());
  }

  rest(): Uint8Array {
    return Uint8Array.from(this.take(this.data.length - this.offset));
  }

  get exhausted(): boolean {
    return this.offset === this.data.length;
  }
}

export const encodeHeader = (header: MessageHeader): Uint8Array =>
  new Writer().fixed(header.dh, KEY_LEN).uint32(header.pn).uint32(header.n).finish();

export const decodeHeader = (bytes: Uint8Array): MessageHeader => {
  if (bytes.length !== HEADER_LEN) {
    throw new Error('Malformed header: expected ' + HEADER_LEN + ' bytes, got ' + bytes.length);
  }
  const reader = new Reader(bytes);
  return { dh: reader.fixed(KEY_LEN), pn: reader.uint32(), n: reader.uint32() };
};

export const encodeMessage = (message: RatchetMessage): Uint8Array => {
  const writer = new Writer().byte(message.type);

  if (message.type === MESSAGE_TYPE_PREKEY) {
    writer
      .fixed(message.prekey.identityKey, KEY_LEN)
      .fixed(message.prekey.ephemeralKey, KEY_LEN)
      .string(message.prekey.signedPreKeyId)
      .optionalString(message.prekey.oneTimePreKeyId);
  }

  return writer.fixed(encodeHeader(message.header), HEADER_LEN).rest(message.ciphertext).finish();
};

export const decodeMessage = (bytes: Uint8Array): RatchetMessage => {
  const reader = new Reader(bytes);
  const type = reader.byte();

  if (type === MESSAGE_TYPE_NORMAL) {
    return {
      type: MESSAGE_TYPE_NORMAL,
      header: decodeHeader(reader.fixed(HEADER_LEN)),
      ciphertext: reader.rest(),
    };
  }

  if (type === MESSAGE_TYPE_PREKEY) {
    const prekey: PreKeyMessageFields = {
      identityKey: reader.fixed(KEY_LEN),
      ephemeralKey: reader.fixed(KEY_LEN),
      signedPreKeyId: reader.string(),
      oneTimePreKeyId: reader.optionalString(),
    };
    return {
      type: MESSAGE_TYPE_PREKEY,
      prekey,
      header: decodeHeader(reader.fixed(HEADER_LEN)),
      ciphertext: reader.rest(),
    };
  }

  throw new Error('Unknown message type: ' + type);
};
