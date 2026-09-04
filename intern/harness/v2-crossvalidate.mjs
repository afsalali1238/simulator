// Cross-validation: encode with the project's encoder, decode with an
// INDEPENDENT third-party parser, compare every field. Any disagreement is a
// finding — never a reason to touch the encoder.
import { encodeAvlPacket, readAvlFrame, CODEC_8, CODEC_8E } from '../../telematics/src/protocol/codec.js';
import { buildScenario, SCENARIO_NAMES } from '../../telematics/src/simulator/scenarios.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ProtocolParser } = require('complete-teltonika-parser');

const findings = [];
let checks = 0, matches = 0;

function cmp(ctx, field, ours, theirs, note) {
  checks++;
  const a = typeof ours === 'bigint' ? ours.toString() : ours;
  const b = typeof theirs === 'bigint' ? theirs.toString() : theirs;
  if (String(a) === String(b)) { matches++; return; }
  findings.push({ ...ctx, field, ours: a, theirs: b, note });
}

function runOne(scenarioName, codecId, codecLabel) {
  const built = buildScenario(scenarioName, { seed: 'xval', records: 0 });
  for (const track of built.tracks) {
    // batch them the way the device does: one record per packet, plus one
    // multi-record packet to exercise the count fields.
    const groups = track.records.map(r => [r]);
    if (track.records.length >= 3) groups.push(track.records.slice(0, 3));

    for (let gi = 0; gi < groups.length; gi++) {
      const recs = groups[gi];
      let pkt;
      try {
        pkt = encodeAvlPacket({ codecId, records: recs });
      } catch (e) {
        findings.push({ scenario: scenarioName, codec: codecLabel, track: track.imei,
          field: 'encode', ours: 'threw: ' + e.message, theirs: '—', note: 'encoder refused to build packet' });
        continue;
      }

      const ours = readAvlFrame(pkt).packet;
      let theirs;
      try {
        theirs = new ProtocolParser(pkt.toString('hex'));
      } catch (e) {
        findings.push({ scenario: scenarioName, codec: codecLabel, track: track.imei,
          field: 'thirdparty-parse', ours: 'ok', theirs: 'threw: ' + e.message,
          note: 'third-party parser could not read our packet' });
        continue;
      }

      const theirRecs = theirs.Content && theirs.Content.AVL_Datas;
      const ctxBase = { scenario: scenarioName, codec: codecLabel, track: track.label || track.imei, group: gi };

      if (!Array.isArray(theirRecs)) {
        findings.push({ ...ctxBase, field: 'AVL_Datas', ours: ours.records.length + ' records',
          theirs: 'undefined', note: 'third-party parser returned no records' });
        continue;
      }
      cmp(ctxBase, 'record count', ours.records.length, theirRecs.length);

      for (let i = 0; i < Math.min(ours.records.length, theirRecs.length); i++) {
        const o = ours.records[i], t = theirRecs[i];
        const ctx = { ...ctxBase, rec: i };
        cmp(ctx, 'timestamp', o.timestampMs, Date.parse(t.Timestamp));
        cmp(ctx, 'priority', o.priority, t.Priority);
        const g = t.GPSelement || {};
        cmp(ctx, 'longitude', o.gps.lon, g.Longitude);
        cmp(ctx, 'latitude', o.gps.lat, g.Latitude);
        cmp(ctx, 'altitude', o.gps.altitude, g.Altitude);
        cmp(ctx, 'angle', o.gps.angle, g.Angle);
        cmp(ctx, 'satellites', o.gps.satellites, g.Satellites);
        cmp(ctx, 'speed', o.gps.speed, g.Speed);
        const io = t.IOelement || {};
        cmp(ctx, 'eventIoId', o.eventIoId, io.EventID);
        cmp(ctx, 'io element count', o.io.length, Number(io.ElementCount));
        const theirEls = io.Elements || {};
        for (const el of o.io) {
          cmp(ctx, `io[${el.id}] (${el.size}B)`, el.value, theirEls[String(el.id)],
            theirEls[String(el.id)] === undefined ? 'absent in third-party output' : undefined);
        }
        // absence must stay absence: nothing the third party reports should be
        // an ID we deliberately omitted.
        const ourIds = new Set(o.io.map(e => String(e.id)));
        for (const id of Object.keys(theirEls)) {
          if (!ourIds.has(id)) {
            findings.push({ ...ctx, field: `io[${id}]`, ours: 'ABSENT (omitted)',
              theirs: theirEls[id], note: 'third party invented an element we did not send' });
          }
        }
      }
    }
  }
}

for (const name of SCENARIO_NAMES) {
  runOne(name, CODEC_8E, '8E');
  runOne(name, CODEC_8, '8');
}

console.log('scenarios      : ' + SCENARIO_NAMES.length + ' × 2 codecs');
console.log('field checks   : ' + checks);
console.log('exact matches  : ' + matches);
console.log('disagreements  : ' + findings.length);

if (findings.length) {
  console.log('\n=== DISAGREEMENTS (grouped) ===');
  const by = new Map();
  for (const f of findings) {
    const k = `${f.codec} | ${f.field} | ${f.note || ''}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(f);
  }
  for (const [k, v] of by) {
    console.log(`\n[${v.length}×] ${k}`);
    const s = v[0];
    console.log(`   e.g. scenario=${s.scenario} track=${s.track} rec=${s.rec}`);
    console.log(`        ours   = ${s.ours}`);
    console.log(`        theirs = ${s.theirs}`);
  }
}
