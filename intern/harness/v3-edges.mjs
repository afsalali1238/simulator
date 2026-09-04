// Edge cases the Dubai-only scenario library cannot reach, plus the malformed
// input the ingestion server must refuse.
import {
  encodeAvlPacket, readAvlFrame, encodeImei, readImeiFrame,
  encodeAck, crc16, CODEC_8, CODEC_8E,
} from '../../telematics/src/protocol/codec.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ProtocolParser } = require('complete-teltonika-parser');

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push({ name, detail }); console.log('  FAIL  ' + name + '  → ' + detail); }
}

const rec = (over = {}) => ({
  timestampMs: 1750000000000,
  priority: 1,
  gps: { lon: 55.2708, lat: 25.2048, altitude: 12, angle: 90, satellites: 11, speed: 40 },
  eventIoId: 0,
  io: [{ id: 239, size: 1, value: 1 }],
  ...over,
});

function roundtrip(r, codecId = CODEC_8E) {
  const pkt = encodeAvlPacket({ codecId, records: [r] });
  const ours = readAvlFrame(pkt).packet.records[0];
  const tp = new ProtocolParser(pkt.toString('hex'));
  const t = tp.Content.AVL_Datas[0];
  return { ours, theirs: t, hex: pkt.toString('hex') };
}

console.log('\n── TRAP 02: negative coordinates (invisible in Dubai) ──');
for (const [label, lat, lon] of [
  ['Buenos Aires  (S, W)', -34.6037, -58.3816],
  ['Reykjavik     (N, W)',  64.1466, -21.9426],
  ['Jakarta       (S, E)',  -6.2088, 106.8456],
  ['Null Island   (0, 0)',      0,        0   ],
  ['extreme SW        ', -89.9999, -179.9999],
]) {
  const { ours, theirs } = roundtrip(rec({ gps: { lon, lat, altitude: 0, angle: 0, satellites: 8, speed: 0 } }));
  const okLat = Math.abs(ours.gps.lat - lat) < 1e-6 && Math.abs(theirs.GPSelement.Latitude - lat) < 1e-6;
  const okLon = Math.abs(ours.gps.lon - lon) < 1e-6 && Math.abs(theirs.GPSelement.Longitude - lon) < 1e-6;
  check(`${label} lat`, okLat, `sent ${lat} ours ${ours.gps.lat} theirs ${theirs.GPSelement.Latitude}`);
  check(`${label} lon`, okLon, `sent ${lon} ours ${ours.gps.lon} theirs ${theirs.GPSelement.Longitude}`);
}

console.log('\n── negative & extreme altitude, angle wrap, speed ──');
{
  const { ours, theirs } = roundtrip(rec({ gps: { lon: 0, lat: 0, altitude: -430, angle: 359, satellites: 0, speed: 0 } }));
  check('altitude -430 (Dead Sea)', ours.gps.altitude === -430 && theirs.GPSelement.Altitude === -430,
    `ours ${ours.gps.altitude} theirs ${theirs.GPSelement.Altitude}`);
  check('satellites 0 = no fix', ours.gps.satellites === 0 && theirs.GPSelement.Satellites === 0,
    `ours ${ours.gps.satellites} theirs ${theirs.GPSelement.Satellites}`);
}
{
  const { ours, theirs } = roundtrip(rec({ gps: { lon: 0, lat: 0, altitude: 8848, angle: 0, satellites: 12, speed: 65535 } }));
  check('altitude 8848 (Everest)', ours.gps.altitude === 8848 && theirs.GPSelement.Altitude === 8848,
    `ours ${ours.gps.altitude}`);
  check('speed 65535 (uint16 max)', ours.gps.speed === 65535 && theirs.GPSelement.Speed === 65535,
    `ours ${ours.gps.speed} theirs ${theirs.GPSelement.Speed}`);
}

console.log('\n── all four IO widths at full range ──');
{
  const io = [
    { id: 239, size: 1, value: 255 },
    { id: 66,  size: 2, value: 65535 },
    { id: 102, size: 4, value: 4294967295 },
    { id: 78,  size: 8, value: 18446744073709551615n },
  ];
  const { ours, theirs } = roundtrip(rec({ io }));
  check('1-byte max 255',  String(ours.io.find(e=>e.id===239).value) === '255', 'got ' + ours.io.find(e=>e.id===239).value);
  check('2-byte max 65535', String(ours.io.find(e=>e.id===66).value) === '65535', 'got ' + ours.io.find(e=>e.id===66).value);
  check('4-byte max 2^32-1', String(ours.io.find(e=>e.id===102).value) === '4294967295', 'got ' + ours.io.find(e=>e.id===102).value);
  check('8-byte max 2^64-1', String(ours.io.find(e=>e.id===78).value) === '18446744073709551615', 'got ' + ours.io.find(e=>e.id===78).value);
  check('third party agrees on 4-byte', String(theirs.IOelement.Elements['102']) === '4294967295',
    'theirs ' + theirs.IOelement.Elements['102']);
}

console.log('\n── absence is not zero (Rule 2) ──');
{
  const absent = roundtrip(rec({ io: [{ id: 239, size: 1, value: 1 }] }));
  const zero   = roundtrip(rec({ io: [{ id: 239, size: 1, value: 1 }, { id: 102, size: 4, value: 0 }] }));
  check('omitted 102 is absent, not 0',
    absent.ours.io.find(e => e.id === 102) === undefined &&
    absent.theirs.IOelement.Elements['102'] === undefined,
    'ours ' + JSON.stringify(absent.ours.io.map(e=>e.id)) + ' theirs ' + JSON.stringify(Object.keys(absent.theirs.IOelement.Elements)));
  check('present 0 survives as a real 0',
    zero.ours.io.find(e => e.id === 102).value === 0 && zero.theirs.IOelement.Elements['102'] === 0,
    'ours ' + zero.ours.io.find(e=>e.id===102).value);
  check('absent and zero produce DIFFERENT bytes', absent.hex !== zero.hex, 'identical encoding — absence indistinguishable from zero');
}

console.log('\n── multi-record packets & the two count fields ──');
for (const n of [1, 2, 10, 50, 255]) {
  const recs = Array.from({ length: n }, (_, i) => rec({ timestampMs: 1750000000000 + i * 1000 }));
  try {
    const pkt = encodeAvlPacket({ codecId: CODEC_8E, records: recs });
    const ours = readAvlFrame(pkt).packet;
    const tp = new ProtocolParser(pkt.toString('hex'));
    check(`${n} records round-trip`,
      ours.records.length === n && tp.Content.AVL_Datas.length === n,
      `ours ${ours.records.length} theirs ${tp.Content.AVL_Datas.length}`);
  } catch (e) { check(`${n} records round-trip`, false, e.message); }
}

console.log('\n── malformed input MUST be refused ──');
const good = encodeAvlPacket({ codecId: CODEC_8E, records: [rec()] });
function mustThrow(name, mutate) {
  const b = Buffer.from(good);
  mutate(b);
  try { readAvlFrame(b); check(name, false, 'accepted a malformed packet'); }
  catch { check(name, true); }
}
mustThrow('bad preamble rejected',      b => b.writeUInt32BE(1, 0));
mustThrow('corrupt CRC rejected',       b => b.writeUInt8(b[b.length - 1] ^ 0xff, b.length - 1));
mustThrow('flipped payload bit rejected', b => { b[20] ^= 0x01; });
mustThrow('count mismatch rejected',    b => { const n = b.readUInt32BE(4); b.writeUInt8(9, 8 + n - 1); });
mustThrow('unknown codec rejected',     b => { b.writeUInt8(0x10, 8); const n = b.readUInt32BE(4);
  b.writeUInt32BE(crc16(b.subarray(8, 8 + n)), 8 + n); });
{
  const b = Buffer.alloc(12); b.writeUInt32BE(0, 0); b.writeUInt32BE(0xFFFFFFF, 4);
  try { readAvlFrame(b); check('4GB declared length rejected', false, 'accepted'); }
  catch { check('4GB declared length rejected', true); }
}
{
  const partial = good.subarray(0, good.length - 3);
  check('truncated packet returns null (waits for more)', readAvlFrame(partial) === null, 'did not return null');
}

console.log('\n── IMEI handshake ──');
{
  const f = encodeImei('356307042441013');
  check('handshake frame is 17 bytes', f.length === 17, 'got ' + f.length);
  check('length prefix = 15', f.readUInt16BE(0) === 15, 'got ' + f.readUInt16BE(0));
  check('IMEI is ASCII, not BCD', f.subarray(2).toString('ascii') === '356307042441013', 'got ' + f.subarray(2).toString('ascii'));
  const back = readImeiFrame(f);
  check('round-trips', back.imei === '356307042441013', JSON.stringify(back));
  check('partial frame returns null', readImeiFrame(f.subarray(0, 9)) === null, 'did not wait');
}

console.log('\n── ACK ──');
{
  check('ACK is 4 bytes BE', encodeAck(5).length === 4 && encodeAck(5).readUInt32BE(0) === 5, 'bad ack');
  check('ACK 0 is distinct from ACK 1', encodeAck(0).toString('hex') !== encodeAck(1).toString('hex'), 'same');
}

console.log('\n──────────────────────────────');
console.log('PASS ' + pass + '   FAIL ' + fail);
if (fail) { console.log('\nFAILURES:'); fails.forEach(f => console.log(' - ' + f.name + ': ' + f.detail)); }
