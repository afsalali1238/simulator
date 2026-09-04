// Device-side behaviour: the parts a decoder test cannot reach.
// 1. An annotated byte-by-byte decode of a real simulator packet (Stage 1).
// 2. What the device does when the server rejects the IMEI.
// 3. What the device does when the server withholds the ACK (Rule 1 / Rule 3).
import net from 'node:net';
import { SimDevice } from '../../telematics/src/simulator/device.js';
import { readAvlFrame, CODEC_8E } from '../../telematics/src/protocol/codec.js';
import { buildScenario } from '../../telematics/src/simulator/scenarios.js';

const IMEI = '356307042441013';

// ─── capture one real packet ────────────────────────────────────────────────
function serve({ acceptImei = true, ack = true, onPacket = () => {} }) {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => {
      let buf = Buffer.alloc(0), shook = false;
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (!shook) {
            if (buf.length < 2) return;
            const n = buf.readUInt16BE(0);
            if (buf.length < 2 + n) return;
            buf = buf.subarray(2 + n);
            shook = true;
            s.write(Buffer.from([acceptImei ? 0x01 : 0x00]));
            if (!acceptImei) { s.end(); return; }
            continue;
          }
          let f;
          try { f = readAvlFrame(buf); } catch (e) { s.destroy(); return; }
          if (!f) return;
          const raw = buf.subarray(0, f.bytesConsumed);
          buf = buf.subarray(f.bytesConsumed);
          onPacket(raw, f.packet);
          if (ack) {
            const a = Buffer.alloc(4); a.writeUInt32BE(f.packet.records.length); s.write(a);
          }
        }
      });
      s.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const captured = [];
const { srv, port } = await serve({ onPacket: (raw, p) => captured.push({ raw, p }) });

const built = buildScenario('day-cycle', { seed: 'audit' });
const track = built.tracks[0];
const dev = new SimDevice({ host: '127.0.0.1', port, imei: IMEI, codec: '8E' });
await dev.connect();
const acked = await dev.send(track.records.slice(0, 2));
dev.close();

console.log('=== 1. ANNOTATED DECODE OF A REAL SIMULATOR PACKET ===\n');
const { raw, p } = captured[0];
const hex = raw.toString('hex');
let o = 0;
const take = (n) => { const s = hex.slice(o * 2, (o + n) * 2); o += n; return s; };
const line = (label, bytes, val) => console.log(
  '  ' + String(o - bytes.length / 2).padStart(3, '0') + '  ' +
  bytes.padEnd(20).slice(0, 20) + (bytes.length > 20 ? '…' : '  ') + '  ' +
  label.padEnd(20) + val);

console.log('  off  bytes                   field                 value');
console.log('  ' + '─'.repeat(74));
let b;
b = take(4); line('preamble', b, parseInt(b, 16) === 0 ? '0 — correct' : 'WRONG');
b = take(4); const dlen = parseInt(b, 16); line('data length', b, dlen + ' bytes');
b = take(1); line('codec id', b, b === '8e' ? 'Codec 8 Extended' : b);
b = take(1); line('number of data 1', b, parseInt(b, 16));
b = take(8); const ts = Number(BigInt('0x' + b)); line('timestamp', b, new Date(ts).toISOString());
b = take(1); line('priority', b, parseInt(b, 16));
b = take(4); let v = parseInt(b, 16); if (v & 0x80000000) v -= 0x100000000;
  line('longitude', b, (v / 1e7).toFixed(7) + '°');
b = take(4); v = parseInt(b, 16); if (v & 0x80000000) v -= 0x100000000;
  line('latitude', b, (v / 1e7).toFixed(7) + '°');
b = take(2); v = parseInt(b, 16); if (v & 0x8000) v -= 0x10000; line('altitude', b, v + ' m  (SIGNED)');
b = take(2); line('angle', b, parseInt(b, 16) + '°');
b = take(1); line('satellites', b, parseInt(b, 16));
b = take(2); line('speed', b, parseInt(b, 16) + ' km/h');
b = take(2); line('event io id', b, parseInt(b, 16));
b = take(2); line('total io count', b, parseInt(b, 16));

console.log('\n  hand-decoded values vs the project decoder:');
const r0 = p.records[0];
const hand = { ts, };
console.log('    timestamp  hand=' + new Date(ts).toISOString() + '  decoder=' + new Date(r0.timestampMs).toISOString() +
  '   ' + (ts === r0.timestampMs ? 'MATCH' : 'MISMATCH'));

// ─── 2. IMEI rejection ──────────────────────────────────────────────────────
srv.close();
const { srv: srv2, port: p2 } = await serve({ acceptImei: false });
let rejected = false;
try {
  const d2 = new SimDevice({ host: '127.0.0.1', port: p2, imei: '999999999999999', codec: '8E' });
  await d2.connect();
  d2.close();
} catch (e) { rejected = true; var rejMsg = e.message; }
srv2.close();
console.log('\n=== 2. SERVER REJECTS THE IMEI (0x00) ===');
console.log('  device treated it as a failure : ' + (rejected ? 'YES' : 'NO — it carried on regardless'));
if (rejected) console.log('  error                          : ' + rejMsg);

// ─── 3. server withholds the ACK ────────────────────────────────────────────
const { srv: srv3, port: p3 } = await serve({ ack: false });
console.log('\n=== 3. SERVER WITHHOLDS THE ACK (Rule 1 / Rule 3) ===');
const d3 = new SimDevice({ host: '127.0.0.1', port: p3, imei: IMEI, codec: '8E' });
await d3.connect();
let timedOut = false;
try {
  await Promise.race([
    d3.send(track.records.slice(0, 1)),
    new Promise((_, rej) => setTimeout(() => rej(new Error('no ACK after 3s')), 3000)),
  ]);
} catch (e) { timedOut = true; var toMsg = e.message; }
d3.close(); srv3.close();
console.log('  device blocked waiting for ACK : ' + (timedOut ? 'YES — it does not fire-and-forget' : 'NO — it moved on without an ACK'));
if (timedOut) console.log('  observed                       : ' + toMsg);
console.log('\n  (a real unit holds the record in flash until ACKed; blocking here is');
console.log('   the correct device-side half of the durability contract)');

console.log('\n=== summary ===');
console.log('  packets captured : ' + captured.length);
console.log('  records ACKed    : ' + acked);
process.exit(0);
