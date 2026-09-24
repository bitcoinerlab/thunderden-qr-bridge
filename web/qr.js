import { Buffer } from "buffer";
import { UR, UREncoder, URDecoder } from "@ngraveio/bc-ur";
import Bytewords from "@ngraveio/bc-ur/dist/bytewords.js";

const bytewords = Bytewords.default ?? Bytewords;
export const MAX_MESSAGE = 2 * 1024 * 1024 + 65536;

function require(ok, message) { if (!ok) throw new Error(message); }

// Read only bounded fountain headers and the final byte-string wrapper. The UR
// library never sees unvalidated peer lengths or arbitrary nested CBOR objects.
class Reader {
  constructor(data) { this.data = data; this.pos = 0; }
  head(major) {
    require(this.pos < this.data.length, "Truncated QR data");
    const tag = this.data[this.pos++], info = tag & 31;
    require(tag >> 5 === major && info <= 26, "Invalid QR data type");
    if (info < 24) return info;
    const count = 1 << (info - 24);
    require(this.pos + count <= this.data.length, "Truncated QR header");
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 256 + this.data[this.pos++];
    require(value >= [24, 256, 65536][info - 24], "Non-canonical QR header");
    return value;
  }
  bytes() {
    const length = this.head(2);
    require(length <= MAX_MESSAGE && this.pos + length === this.data.length, "Invalid QR payload length");
    return this.data.subarray(this.pos);
  }
}

export function encoder(payload) {
  require(payload.length <= 1024 * 1024 + 65536, "Request is too large");
  const ur = UR.fromBuffer(Buffer.from(payload));
  return new UREncoder(ur, Math.max(200, Math.ceil(ur.cbor.length / 1024)), 0, 1);
}

export class Decoder {
  constructor() { this.decoder = new URDecoder(); this.header = null; this.seen = new Map(); }
  receive(frame) {
    require(typeof frame === "string" && frame.length <= 4296, "QR frame is too large");
    const match = /^ur:bytes\/(?:([1-9][0-9]*)-([1-9][0-9]*)\/)?([a-z]+)$/i.exec(frame);
    require(match, "Expected a Thunder Den response QR");
    const data = Buffer.from(bytewords.decode(match[3].toLowerCase(), "minimal"), "hex");
    const reader = new Reader(data);
    if (match[1]) {
      const seq = Number(match[1]), parts = Number(match[2]);
      require(seq <= 0xffffffff && parts <= 1024 && reader.head(4) === 5, "Invalid QR fragment count");
      require(reader.head(0) === seq && reader.head(0) === parts, "QR header mismatch");
      const length = reader.head(0), checksum = reader.head(0), fragment = reader.bytes();
      require(length > 0 && length <= MAX_MESSAGE && fragment.length > 0
        && length <= parts * fragment.length && (parts - 1) * fragment.length < length, "Invalid QR fragment size");
      const header = `${parts}:${length}:${checksum}:${fragment.length}`;
      require(this.header === null || this.header === header, "Different QR messages; restart the camera");
      this.header = header;
      const old = this.seen.get(seq), normalized = frame.toLowerCase();
      if (old) { require(old === normalized, "Conflicting QR fragment"); return null; }
      require(this.seen.size < 4 * parts + 64, "Too many fragments; restart the camera");
      this.seen.set(seq, normalized);
    } else {
      require(this.header === null, "Different QR messages; restart the camera");
      reader.bytes();
    }
    this.decoder.receivePart(frame);
    require(!this.decoder.isError(), "Could not assemble QR response");
    if (!this.decoder.isSuccess()) return null;
    const cbor = this.decoder.resultUR().cbor;
    require(cbor.length <= MAX_MESSAGE, "Response is too large");
    return new Reader(cbor).bytes();
  }
  progress() { return Math.min(99, Math.floor(this.decoder.estimatedPercentComplete() * 100)); }
}
