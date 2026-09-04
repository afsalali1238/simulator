// ─────────────────────────────────────────────────────────────────────────────
// src/protocol/codec.js — Teltonika Codec 8 / Codec 8 Extended (0x8E)
//
// This is the on-the-wire contract. Because the simulator sends the SAME bytes a
// real FMC130 sends, a physical device can replace the simulator with zero
// server changes. Everything here is pure functions over Buffers — no I/O — so
// it is trivially unit-testable (see test/crc.test.js, test/codec.test.js).
//
// Wire format (big-endian throughout):
//
//   IMEI handshake (device -> server):
//     [2 bytes length=15][15 bytes IMEI ASCII]
//   Server reply: 1 byte  0x01 accept / 0x00 reject
//
//   AVL data packet (device -> server):
//     [4 bytes preamble = 0x00000000]
//     [4 bytes data-field length N]        ; bytes from Codec ID .. Number of Data 2
//     [1 byte Codec ID]                    ; 0x08 = Codec 8, 0x8E = Codec 8 Ext
//     [1 byte Number of Data 1]            ; record count (1 byte in BOTH codecs)
//     [ ...records... ]
//     [1 byte Number of Data 2]            ; must equal Number of Data 1
//     [4 bytes CRC-16]                     ; low 2 bytes = CRC over the data field
//   Server ACK: [4 bytes] = number of records accepted (device clears its buffer)
//
// The only difference in Codec 8E: the IO section uses 2-byte IO IDs and 2-byte
// counts (vs 1-byte in Codec 8), and adds a variable-length ("NX") IO group.
// The record header (timestamp/priority/GPS) is identical in both.
// ─────────────────────────────────────────────────────────────────────────────

export const CODEC_8 = 0x08;
export const CODEC_8E = 0x8e;

// ── CRC-16/IBM (a.k.a. CRC-16/ARC): poly 0xA001, init 0x0000, reflected ───────
// This is the CRC Teltonika specifies. Verified against the canonical documented
// packet (CRC 0xC7CF) in test/crc.test.js.
export function crc16(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xa001;
      else crc >>>= 1;
    }
  }
  return crc & 0xffff;
}

// ── IMEI handshake ────────────────────────────────────────────────────────────
export function encodeImei(imei) {
  const ascii = Buffer.from(String(imei), 'ascii');
  const out = Buffer.alloc(2 + ascii.length);
  out.writeUInt16BE(ascii.length, 0);
  ascii.copy(out, 2);
  return out;
}

// A real Teltonika IMEI handshake declares exactly 15 bytes. Cap the declared
// length so a bogus 0xFFFF can't make the server buffer ~64 KB waiting for an
// IMEI frame that will never complete (F4, and it closes the handshake half of
// the F6 slowloris). Above this, readImeiFrame throws and the server drops the
// connection — this is framing-level "that is not a handshake at all".
export const MAX_IMEI_FRAME_LEN = 64;

// A valid IMEI is exactly 15 ASCII digits. This is a POLICY check, kept separate
// from framing: readImeiFrame still returns a well-formed-but-invalid value (e.g.
// 15 letters, or an empty string) so the SERVER can route it through the same
// rate-limited reject path as an unknown IMEI, rather than silently dropping the
// socket. Keeping the two concerns apart mirrors the AVL path (readAvlFrame
// frames; the server decides policy). See src/ingestion/server.js.
export function isValidImei(imei) {
  return typeof imei === 'string' && /^[0-9]{15}$/.test(imei);
}

// Returns { imei, bytesConsumed } or null if the buffer doesn't yet hold a full
// IMEI frame (TCP is a stream — the caller keeps accumulating and retries).
// Throws only when the declared length is implausibly large (> MAX_IMEI_FRAME_LEN):
// that is not a device we should keep buffering for.
export function readImeiFrame(buf) {
  if (buf.length < 2) return null;
  const len = buf.readUInt16BE(0);
  if (len > MAX_IMEI_FRAME_LEN) {
    throw new Error(
      `implausible IMEI frame length ${len} (max ${MAX_IMEI_FRAME_LEN})`,
    );
  }
  if (buf.length < 2 + len) return null;
  const imei = buf.toString('ascii', 2, 2 + len);
  return { imei, bytesConsumed: 2 + len };
}

// ── IO element grouping ────────────────────────────────────────────────────────
// An ioElement is { id, size, value }. size ∈ {1,2,4,8} are fixed-width groups;
// any other size goes to the NX (variable) group, which only exists in 8E.
function groupIo(elements) {
  const groups = { 1: [], 2: [], 4: [], 8: [], x: [] };
  for (const el of elements) {
    if (el.size === 1 || el.size === 2 || el.size === 4 || el.size === 8) {
      groups[el.size].push(el);
    } else {
      groups.x.push(el);
    }
  }
  return groups;
}

function writeUIntW(buf, value, offset, width) {
  if (width === 1) buf.writeUInt8(value, offset);
  else buf.writeUInt16BE(value, offset);
  return offset + width;
}

// ── Encode one AVL record ──────────────────────────────────────────────────────
export function encodeRecord(rec, extended) {
  const idW = extended ? 2 : 1; // IO id / count width
  const g = groupIo(rec.io || []);

  // Header: timestamp(8) priority(1) + GPS(15)
  const head = Buffer.alloc(24);
  head.writeBigUInt64BE(BigInt(rec.timestampMs), 0);
  head.writeUInt8(rec.priority ?? 0, 8);
  head.writeInt32BE(Math.round((rec.gps?.lon ?? 0) * 1e7), 9);
  head.writeInt32BE(Math.round((rec.gps?.lat ?? 0) * 1e7), 13);
  head.writeInt16BE(rec.gps?.altitude ?? 0, 17);
  head.writeUInt16BE(rec.gps?.angle ?? 0, 19);
  head.writeUInt8(rec.gps?.satellites ?? 0, 21);
  head.writeUInt16BE(rec.gps?.speed ?? 0, 22);

  const parts = [head];

  // IO header: eventIoId + total count (width depends on codec)
  const total =
    g[1].length + g[2].length + g[4].length + g[8].length + g.x.length;
  const ioHead = Buffer.alloc(idW * 2);
  let o = 0;
  o = writeUIntW(ioHead, rec.eventIoId ?? 0, o, idW);
  o = writeUIntW(ioHead, total, o, idW);
  parts.push(ioHead);

  // Fixed-width groups, in order 1,2,4,8
  for (const size of [1, 2, 4, 8]) {
    const list = g[size];
    const b = Buffer.alloc(idW + list.length * (idW + size));
    let p = 0;
    p = writeUIntW(b, list.length, p, idW);
    for (const el of list) {
      p = writeUIntW(b, el.id, p, idW);
      if (size === 8) {
        b.writeBigUInt64BE(BigInt(el.value), p);
      } else {
        b.writeUIntBE(el.value, p, size);
      }
      p += size;
    }
    parts.push(b);
  }

  // Variable-length (NX) group — 8E only
  if (extended) {
    const list = g.x;
    const chunks = [];
    const cnt = Buffer.alloc(2);
    cnt.writeUInt16BE(list.length, 0);
    chunks.push(cnt);
    for (const el of list) {
      const val = Buffer.isBuffer(el.value)
        ? el.value
        : Buffer.from(String(el.value), 'ascii');
      const hdr = Buffer.alloc(4);
      hdr.writeUInt16BE(el.id, 0);
      hdr.writeUInt16BE(val.length, 2);
      chunks.push(hdr, val);
    }
    parts.push(Buffer.concat(chunks));
  }

  return Buffer.concat(parts);
}

// ── Encode a full AVL TCP packet (preamble..CRC) ────────────────────────────────
export function encodeAvlPacket({ codecId = CODEC_8E, records }) {
  const extended = codecId === CODEC_8E;
  const recs = Buffer.concat(records.map((r) => encodeRecord(r, extended)));
  const n = records.length;

  const dataField = Buffer.concat([
    Buffer.from([codecId, n]), // Codec ID, Number of Data 1
    recs,
    Buffer.from([n]), // Number of Data 2
  ]);

  const preamble = Buffer.alloc(4); // 0x00000000
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dataField.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc16(dataField) & 0xffff, 0);

  return Buffer.concat([preamble, len, dataField, crc]);
}

// ── Decode one AVL record at cursor; returns { record, offset } ─────────────────
function decodeRecord(buf, offset, extended) {
  const idW = extended ? 2 : 1;
  const readW = (o) => (extended ? buf.readUInt16BE(o) : buf.readUInt8(o));

  try {
    const timestampMs = Number(buf.readBigUInt64BE(offset));
    const priority = buf.readUInt8(offset + 8);
    const lon = buf.readInt32BE(offset + 9) / 1e7;
    const lat = buf.readInt32BE(offset + 13) / 1e7;
    const altitude = buf.readInt16BE(offset + 17);
    const angle = buf.readUInt16BE(offset + 19);
    const satellites = buf.readUInt8(offset + 21);
    const speed = buf.readUInt16BE(offset + 22);
    let o = offset + 24;

    const eventIoId = readW(o);
    o += idW;
    o += idW; // total count — we recompute from groups, so skip the value

    const io = [];
    for (const size of [1, 2, 4, 8]) {
      const count = readW(o);
      o += idW;
      for (let i = 0; i < count; i++) {
        const id = readW(o);
        o += idW;
        let value;
        if (size === 8) {
          value = buf.readBigUInt64BE(o);
        } else {
          value = buf.readUIntBE(o, size);
        }
        o += size;
        io.push({ id, size, value });
      }
    }

    if (extended) {
      const count = buf.readUInt16BE(o);
      o += 2;
      for (let i = 0; i < count; i++) {
        const id = buf.readUInt16BE(o);
        o += 2;
        const len = buf.readUInt16BE(o);
        o += 2;
        const value = buf.subarray(o, o + len);
        o += len;
        io.push({ id, size: len, value });
      }
    }

    return {
      record: {
        timestampMs,
        priority,
        gps: { lon, lat, altitude, angle, satellites, speed },
        eventIoId,
        io,
      },
      offset: o,
    };
  } catch (err) {
    // A truncated record — a body shorter than its header/counts imply — makes a
    // fixed-offset read run off the end of the buffer. Node throws a bare
    // RangeError ("...outside buffer bounds"); relabel it so the operator's log
    // says WHAT was malformed, not just WHERE (F5). Behaviour is unchanged: the
    // server still treats the throw as "drop the connection, do NOT ACK".
    if (err instanceof RangeError) {
      throw new Error('malformed record: body shorter than declared');
    }
    throw err;
  }
}

// ── Read one full AVL packet from a stream buffer ───────────────────────────────
// Returns { packet, bytesConsumed } or null if the buffer doesn't yet contain a
// whole packet. Throws on a malformed preamble, an over-large declared length,
// a CRC mismatch, or an unsupported codec — the caller (ingestion server) treats
// a throw as "drop the connection, do NOT ACK".
//
// `maxPacketBytes` (F1) bounds the declared data-field length BEFORE we agree to
// buffer that many bytes: without it a peer can declare ~4 GB and steer one
// connection toward OOM. Defaults to DEFAULT_MAX_PACKET_BYTES; the server passes
// the configured INGEST_MAX_PACKET_BYTES.
export const DEFAULT_MAX_PACKET_BYTES = 64 * 1024;

export function readAvlFrame(buf, { maxPacketBytes = DEFAULT_MAX_PACKET_BYTES } = {}) {
  if (buf.length < 8) return null; // need preamble + length first
  const preamble = buf.readUInt32BE(0);
  if (preamble !== 0) {
    throw new Error(`bad preamble 0x${preamble.toString(16)} (expected 0)`);
  }
  const dataLen = buf.readUInt32BE(4);
  // F1: reject an implausibly large declared length up front, so we never wait
  // to buffer it. Checked BEFORE the "need more bytes" return below on purpose.
  if (dataLen > maxPacketBytes) {
    throw new Error(
      `declared data-field length ${dataLen} exceeds max ${maxPacketBytes}`,
    );
  }
  const total = 8 + dataLen + 4; // preamble + len + data + crc
  if (buf.length < total) return null; // wait for more bytes

  const dataField = buf.subarray(8, 8 + dataLen);
  const crcExpected = buf.readUInt32BE(8 + dataLen) & 0xffff;
  const crcActual = crc16(dataField);
  const crcValid = crcExpected === crcActual;
  if (!crcValid) {
    throw new Error(
      `CRC mismatch: got 0x${crcActual.toString(16)} expected 0x${crcExpected.toString(16)}`,
    );
  }

  const codecId = dataField.readUInt8(0);
  // F2: fail closed on an unknown codec instead of parsing it as Codec 8. Placed
  // AFTER the CRC check — we only pass judgement on a codec byte we know is
  // intact. Codec 12 (GPRS commands) and Codec 16 have different structures;
  // mis-parsing one as AVL data could put a garbage record into the store.
  if (codecId !== CODEC_8 && codecId !== CODEC_8E) {
    throw new Error(
      `unsupported codec 0x${codecId.toString(16)} (expected 0x08 or 0x8e)`,
    );
  }
  const numData1 = dataField.readUInt8(1);
  const extended = codecId === CODEC_8E;

  let o = 2;
  const records = [];
  for (let i = 0; i < numData1; i++) {
    const { record, offset } = decodeRecord(dataField, o, extended);
    records.push(record);
    o = offset;
  }
  const numData2 = dataField.readUInt8(o);
  if (numData1 !== numData2) {
    throw new Error(`record count mismatch: ${numData1} != ${numData2}`);
  }

  return {
    packet: { codecId, records, crc: crcExpected, crcValid },
    bytesConsumed: total,
  };
}

// Server ACK = 4-byte big-endian count of accepted records.
export function encodeAck(count) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(count, 0);
  return b;
}
