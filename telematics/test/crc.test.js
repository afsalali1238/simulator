// test/crc.test.js — proves our CRC-16 and decoder match the REAL Teltonika wire
// format, using the canonical example packet from Teltonika's own documentation.
// If this passes, our bytes are the bytes a real FMC130 emits.

import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16, readAvlFrame, CODEC_8 } from '../src/protocol/codec.js';

// The canonical single-record Codec 8 packet documented by Teltonika.
// Data-field length 0x36 (54), documented CRC 0xC7CF.
const CANONICAL_HEX =
  '000000000000003608010000016B40D8EA30' +
  '010000000000000000000000000000000105' +
  '021503010101425E0F01F10000601A014E00' +
  '0000000000000001' + // ...records + Number of Data 2
  '0000C7CF'; // CRC field

const CANONICAL = Buffer.from(CANONICAL_HEX, 'hex');

test('CRC-16/IBM matches the documented 0xC7CF over the data field', () => {
  const dataLen = CANONICAL.readUInt32BE(4);
  const dataField = CANONICAL.subarray(8, 8 + dataLen);
  assert.equal(dataLen, 0x36);
  assert.equal(crc16(dataField), 0xc7cf);
});

test('decodes the canonical packet: 1 record, codec 8, CRC valid', () => {
  const res = readAvlFrame(CANONICAL);
  assert.ok(res, 'should parse a complete frame');
  assert.equal(res.bytesConsumed, CANONICAL.length);
  assert.equal(res.packet.codecId, CODEC_8);
  assert.equal(res.packet.crcValid, true);
  assert.equal(res.packet.records.length, 1);
});

test('decodes the canonical record fields correctly', () => {
  const { records } = readAvlFrame(CANONICAL).packet;
  const r = records[0];
  assert.equal(r.timestampMs, Number(0x0000016b40d8ea30n));
  assert.equal(r.priority, 1);
  assert.equal(r.eventIoId, 1);
  // Known IO values from the documented packet:
  const byId = Object.fromEntries(r.io.map((e) => [e.id, e.value]));
  assert.equal(byId[21], 3); // 1-byte
  assert.equal(byId[1], 1); // 1-byte
  assert.equal(byId[66], 0x5e0f); // 2-byte = 24079
  assert.equal(byId[241], 0x601a); // 4-byte = 24602
  assert.equal(byId[78], 0n); // 8-byte -> BigInt
});

test('readAvlFrame returns null on a partial buffer (stream not complete)', () => {
  assert.equal(readAvlFrame(CANONICAL.subarray(0, 20)), null);
});

test('readAvlFrame throws on a CRC mismatch (corrupted frame)', () => {
  const bad = Buffer.from(CANONICAL);
  bad[10] ^= 0xff; // flip a byte inside the data field
  assert.throws(() => readAvlFrame(bad), /CRC mismatch/);
});
