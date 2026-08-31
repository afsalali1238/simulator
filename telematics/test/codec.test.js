// test/codec.test.js — encode -> decode round-trips for BOTH Codec 8 and 8E,
// plus a byte-identical re-encode. This is what guarantees the simulator and the
// ingestion server agree on the wire format down to the last byte.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeAvlPacket,
  readAvlFrame,
  encodeAck,
  CODEC_8,
  CODEC_8E,
} from '../src/protocol/codec.js';

function sampleRecord() {
  return {
    timestampMs: 1735689600000, // 2025-01-01T00:00:00Z
    priority: 1,
    gps: {
      lon: 55.2708, // Dubai
      lat: 25.2048,
      altitude: 12,
      angle: 90,
      satellites: 9,
      speed: 42,
    },
    eventIoId: 239,
    io: [
      { id: 239, size: 1, value: 1 }, // ignition on
      { id: 240, size: 1, value: 0 }, // not moving
      { id: 21, size: 2, value: 1234 }, // 2-byte sample
      { id: 200, size: 4, value: 3600 }, // engine seconds
      { id: 78, size: 8, value: 1234567890123n }, // 8-byte sample
    ],
  };
}

for (const codecId of [CODEC_8, CODEC_8E]) {
  const label = codecId === CODEC_8E ? 'Codec 8E' : 'Codec 8';

  test(`${label}: encode -> decode preserves all fields`, () => {
    const rec = sampleRecord();
    const buf = encodeAvlPacket({ codecId, records: [rec] });
    const res = readAvlFrame(buf);

    assert.ok(res);
    assert.equal(res.bytesConsumed, buf.length);
    assert.equal(res.packet.codecId, codecId);
    assert.equal(res.packet.crcValid, true);
    assert.equal(res.packet.records.length, 1);

    const d = res.packet.records[0];
    assert.equal(d.timestampMs, rec.timestampMs);
    assert.equal(d.priority, 1);
    assert.ok(Math.abs(d.gps.lon - rec.gps.lon) < 1e-6);
    assert.ok(Math.abs(d.gps.lat - rec.gps.lat) < 1e-6);
    assert.equal(d.gps.altitude, 12);
    assert.equal(d.gps.angle, 90);
    assert.equal(d.gps.satellites, 9);
    assert.equal(d.gps.speed, 42);
    assert.equal(d.eventIoId, 239);

    const byId = Object.fromEntries(d.io.map((e) => [e.id, e.value]));
    assert.equal(byId[239], 1);
    assert.equal(byId[240], 0);
    assert.equal(byId[21], 1234);
    assert.equal(byId[200], 3600);
    assert.equal(byId[78], 1234567890123n);
  });

  test(`${label}: re-encoding a decoded record is byte-identical`, () => {
    const rec = sampleRecord();
    const buf1 = encodeAvlPacket({ codecId, records: [rec] });
    const decoded = readAvlFrame(buf1).packet.records[0];
    const buf2 = encodeAvlPacket({ codecId, records: [decoded] });
    assert.ok(buf1.equals(buf2), 'round-trip must reproduce identical bytes');
  });

  test(`${label}: multi-record packet decodes all records`, () => {
    const recs = [sampleRecord(), sampleRecord(), sampleRecord()];
    recs[1].timestampMs += 1000;
    recs[2].timestampMs += 2000;
    const buf = encodeAvlPacket({ codecId, records: recs });
    const res = readAvlFrame(buf);
    assert.equal(res.packet.records.length, 3);
    assert.equal(res.packet.records[2].timestampMs, recs[2].timestampMs);
  });
}

test('negative coordinates (S/W hemisphere) survive the round-trip', () => {
  const rec = sampleRecord();
  rec.gps.lon = -122.4194; // San Francisco
  rec.gps.lat = -37.8136; // (forced southern for the test)
  const buf = encodeAvlPacket({ codecId: CODEC_8E, records: [rec] });
  const d = readAvlFrame(buf).packet.records[0];
  assert.ok(Math.abs(d.gps.lon - -122.4194) < 1e-6);
  assert.ok(Math.abs(d.gps.lat - -37.8136) < 1e-6);
});

test('ACK encodes the accepted-record count as 4 big-endian bytes', () => {
  assert.deepEqual([...encodeAck(1)], [0, 0, 0, 1]);
  assert.deepEqual([...encodeAck(258)], [0, 0, 1, 2]);
});
