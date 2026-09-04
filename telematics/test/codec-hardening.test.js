// ─────────────────────────────────────────────────────────────────────────────
// test/codec-hardening.test.js — the parser's DEFENSIVE envelope.
//
// codec.test.js and crc.test.js prove the happy path and the CRC. This file
// proves the fail-closed behaviour that the 2026-09-02 parser/handshake review
// found correct-but-untested, plus the new guards it recommended:
//
//   F1  an over-large declared data-field length is refused, not buffered
//   F2  an unsupported codec id is refused, not parsed as Codec 8
//   F4  the IMEI frame length is bounded and the value is format-checked
//   F5  a truncated record throws a LABELLED protocol error, not a RangeError
//   +   the three coverage gaps: bad preamble, Number-of-Data mismatch, truncation
//
// All pure over Buffers — no sockets. The wire-level counterparts (a silent
// socket is timed out; a malformed IMEI is rejected + rate-limited) live in
// test/ingestion-hardening.test.js.
//   run: node --test test/codec-hardening.test.js
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crc16,
  readAvlFrame,
  readImeiFrame,
  isValidImei,
  encodeImei,
  encodeAvlPacket,
  CODEC_8,
  CODEC_8E,
} from '../src/protocol/codec.js';

function sampleRecord() {
  return {
    timestampMs: 1735689600000,
    priority: 1,
    gps: { lon: 55.2708, lat: 25.2048, altitude: 12, angle: 90, satellites: 9, speed: 42 },
    eventIoId: 239,
    io: [
      { id: 239, size: 1, value: 1 },
      { id: 21, size: 2, value: 1234 },
    ],
  };
}

// ── F1 — declared-length cap ────────────────────────────────────────────────

test('F1: readAvlFrame throws on a declared data-field length above the cap (no 4 GB buffer)', () => {
  // A valid all-zero preamble followed by a ~4 GB declared length. Before the
  // fix this returned null ("keep buffering"); now it must refuse up front.
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32BE(0, 0); // preamble
  hdr.writeUInt32BE(0xffffffff, 4); // dataLen = 4,294,967,295
  assert.throws(() => readAvlFrame(hdr), /exceeds max/);
});

test('F1: the cap is honoured, and a within-cap-but-incomplete frame still waits', () => {
  // Over a custom cap of 50 -> throw, quoting the cap.
  const over = Buffer.alloc(8);
  over.writeUInt32BE(0, 0);
  over.writeUInt32BE(100, 4);
  assert.throws(() => readAvlFrame(over, { maxPacketBytes: 50 }), /exceeds max 50/);

  // Under the cap but the body hasn't arrived yet -> null (keep buffering),
  // NOT a throw. The cap must not turn a normal partial read into an error.
  const under = Buffer.alloc(8);
  under.writeUInt32BE(0, 0);
  under.writeUInt32BE(40, 4);
  assert.equal(readAvlFrame(under, { maxPacketBytes: 50 }), null);
});

// ── F2 — codec allowlist ────────────────────────────────────────────────────

test('F2: readAvlFrame throws on an unsupported codec id instead of parsing it as Codec 8', () => {
  // encodeAvlPacket lays 0x10 out Codec-8-style with a valid CRC; the point is
  // that the DECODER refuses the unknown codec once the CRC has been verified.
  const buf = encodeAvlPacket({ codecId: 0x10, records: [sampleRecord()] });
  assert.throws(() => readAvlFrame(buf), /unsupported codec 0x10/);
});

test('F2: both documented codecs (0x08, 0x8E) are still accepted', () => {
  for (const codecId of [CODEC_8, CODEC_8E]) {
    const buf = encodeAvlPacket({ codecId, records: [sampleRecord()] });
    const res = readAvlFrame(buf);
    assert.ok(res, `codec 0x${codecId.toString(16)} should parse`);
    assert.equal(res.packet.codecId, codecId);
    assert.equal(res.packet.records.length, 1);
  }
});

// ── Coverage gaps the review flagged (real behaviour, previously unproven) ────

test('readAvlFrame throws on a non-zero preamble', () => {
  const buf = encodeAvlPacket({ codecId: CODEC_8, records: [sampleRecord()] });
  buf.writeUInt32BE(1, 0); // corrupt the preamble
  assert.throws(() => readAvlFrame(buf), /bad preamble/);
});

test('readAvlFrame throws when Number of Data 1 != Number of Data 2', () => {
  // Tamper Number of Data 2 and recompute the CRC, so it is the COUNT check
  // that fires, not the CRC check that would otherwise mask it.
  const buf = encodeAvlPacket({ codecId: CODEC_8, records: [sampleRecord()] });
  const dataLen = buf.readUInt32BE(4);
  const df = Buffer.from(buf.subarray(8, 8 + dataLen)); // codecId..numData2
  df[df.length - 1] = (df[df.length - 1] + 1) & 0xff; // corrupt Number of Data 2
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc16(df) & 0xffff, 0); // keep CRC valid
  const framed = Buffer.concat([buf.subarray(0, 8), df, crc]);
  assert.throws(() => readAvlFrame(framed), /record count mismatch/);
});

test('F5: a truncated record throws a labelled protocol error, not a bare RangeError', () => {
  // codecId=8, Number of Data 1 = 1, then NO record bytes at all. CRC is valid
  // over the (short) data field, so the failure surfaces in record decoding.
  const df = Buffer.from([0x08, 0x01]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc16(df) & 0xffff, 0);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(df.length, 0);
  const framed = Buffer.concat([Buffer.alloc(4), len, df, crc]);
  assert.throws(
    () => readAvlFrame(framed),
    (err) => {
      assert.ok(!(err instanceof RangeError), 'must not surface a bare RangeError');
      assert.match(err.message, /malformed record: body shorter than declared/);
      return true;
    },
  );
});

// ── F4 — IMEI framing cap + format check ──────────────────────────────────────

test('F4: readImeiFrame throws on an implausibly large declared length (no 64 KB buffer)', () => {
  // A 0xFFFF length used to make the server wait for ~64 KB. Now it is refused.
  assert.throws(() => readImeiFrame(Buffer.from([0xff, 0xff])), /implausible IMEI frame length/);
});

test('F4: readImeiFrame still frames a normal 15-byte IMEI', () => {
  const frame = encodeImei('356307042441013');
  const hs = readImeiFrame(frame);
  assert.equal(hs.imei, '356307042441013');
  assert.equal(hs.bytesConsumed, 17); // 2-byte length + 15 ASCII digits
});

test('F4: isValidImei accepts exactly 15 ASCII digits and rejects everything else', () => {
  assert.equal(isValidImei('356307042441013'), true);
  assert.equal(isValidImei('99999999999999'), false); // 14 digits
  assert.equal(isValidImei('3563070424410134'), false); // 16 digits
  assert.equal(isValidImei('35630704244101a'), false); // trailing non-digit
  assert.equal(isValidImei('ABCDEFGHIJKLMNO'), false); // 15 letters
  assert.equal(isValidImei(''), false);
  assert.equal(isValidImei(null), false);
  assert.equal(isValidImei(356307042441013), false); // a number, not a string
});
