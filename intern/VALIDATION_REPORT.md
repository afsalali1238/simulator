# Validation Report — Does the simulator behave as a real Teltonika device?

**Date:** 2026-09-04
**Subject:** `src/protocol/codec.js` and `src/simulator/device.js`
**Method:** canonical-vector check, cross-validation against independent decoders,
edge-case matrix, device-side behavioural tests
**Harness:** `intern/harness/v1`–`v4` (re-runnable)

---

## Verdict

**Yes — with one caveat about what has not yet been proven.**

Across **12,631 individual field comparisons**, the encoder produced bytes that
independent third-party decoders read back correctly, with **one disagreement**,
which turned out to be a defect in the third-party library rather than in the
simulator (FINDING-001).

What is now established:

| Property | Status | Evidence |
|---|---|---|
| CRC-16 implementation | **Correct** | Reproduces Teltonika's published `0xC7CF` on their canonical packet, byte for byte |
| Codec 8 record layout | **Correct** | Full agreement with two independent decoders + Traccar source |
| Codec 8E record layout | **Correct** | Same, across all 8 scenarios |
| Header field order & signedness | **Correct** | `lon` before `lat`, both signed int32 ×10⁷; altitude signed int16; angle/speed unsigned |
| IO section, all four widths | **Correct** | 1/2/4/8-byte values at full range round-trip exactly |
| Absence vs zero (Rule 2) | **Correct** | An omitted element and a present `0` produce *different bytes* and decode differently |
| Malformed input rejection | **Correct** | 7/7 — bad preamble, corrupt CRC, single flipped bit, count mismatch, unknown codec, 4 GB length claim, truncation |
| IMEI handshake | **Correct** | 17-byte frame, ASCII not BCD, honours `0x00` rejection |
| ACK discipline (Rule 1) | **Correct** | Device blocks on the ACK; it does not fire-and-forget |

---

## What was actually run

### 1. Teltonika's canonical packet — independent ground truth

Their published Codec 8 example, assembled from labelled parts so a
transcription slip could not be mistaken for a decoder bug:

```
data field length : 54 (0x36)  — matches spec
CRC computed      : 0xC7CF
CRC per Teltonika : 0xC7CF     → PASS
```

Decoded by `codec.js` and by `complete-teltonika-parser`: **identical on every
field** — timestamp `2019-06-10T10:04:46Z`, priority 1, all-zero GPS, event ID 1,
and IO `21=3, 1=1, 66=24079, 241=24602, 78=0`.

This matters because it is the only test in the suite whose expected values come
from Teltonika rather than from this codebase. Everything the project's own test
suite proves is that the encoder agrees with the decoder — which would still hold
if both were wrong in the same direction.

### 2. Cross-validation — the simulator's own output, read by a stranger

Every scenario, both codecs, one-record and multi-record packets, decoded by an
independent parser and compared field by field:

```
scenarios      : 8 × 2 codecs
field checks   : 12,590
exact matches  : 12,590
disagreements  : 0
```

Including the check that matters most for Rule 2: **no third-party decoder ever
reported an IO element the simulator did not send.** Absence stayed absence.

### 3. Edge cases the scenario library cannot reach

`PASS 40 / FAIL 1`. The interesting ones:

- **Negative coordinates.** Buenos Aires (−34.6, −58.4), Reykjavík (64.1, −21.9),
  Jakarta (−6.2, 106.8), Null Island, and the extreme SW corner all round-trip
  exactly. **This was the trap I most expected to catch a bug** — every scenario
  in the library is in Dubai, where latitude and longitude are both positive, so
  a sign-handling error would be invisible in normal use. It isn't there. The
  encoder handles the sign correctly.
- **Negative altitude (−430 m, Dead Sea).** One disagreement → FINDING-001.
- **255 records in one packet.** Both count fields correct. (256 is now refused by
  the encoder — before `f71a29d` it wrapped mod 256 into a CRC-valid frame
  declaring 0 records, which the ingestion server ACKed as 0 while storing
  nothing. This harness did not catch that; it only tested at the ceiling, not
  one past it.)
- **Full-range IO values**, including `2^64−1` in an 8-byte element.

### 4. Device-side behaviour

- **Hand-decoded a live captured packet byte by byte** against the spec; every
  field matched the decoder. The annotated dump is in `v4-device.mjs` output.
- **IMEI rejection:** server replies `0x00` → the device raises
  `server rejected IMEI …` rather than carrying on.
- **Withheld ACK:** the device blocks indefinitely rather than moving on. This is
  the correct device half of the durability contract — a real unit keeps the
  record in flash until acknowledged. (As of `f71a29d` that is true only while the
  socket stays *open*; if the server drops the connection without ACKing, `send()`
  now rejects instead of hanging forever. Blocking on a live-but-silent server is
  deliberate; hanging on a dead one was a bug.)

---

## Findings

**FINDING-001** — `complete-teltonika-parser@0.3.6` reads altitude as unsigned.
Classified **(b) library quirk**, not a simulator bug: Traccar
(`readShort()`, signed), `teltonika-parser`, and `codec.js` all agree on −430;
that library alone reports 65106. No change on our side. Full write-up in
`findings/FINDING-001-negative-altitude.md`.

---

## What this does NOT prove — read this part

Three honest gaps.

**1. No live Traccar run.** Docker Hub was unreachable from the environment this
audit ran in, so I could not stand up Traccar and stream into it. I read its
decoder source instead, which is *stronger* evidence for field semantics — it is
the actual production code — but it does not exercise the live socket path:
handshake timing, TCP segmentation, reconnection, or Traccar's own ACK timing.
**Stage 2 of the intern brief remains genuinely unproven and worth doing.**

**2. Traccar cannot validate your engine hours at all.** Its decoder registers
handlers for `239` (ignition) and `240` (movement), but has **no handler for AVL
102, 103, or 449**. Those arrive as generic untyped attributes. So the parameters
that actually back an invoice — the 102-versus-103 distinction, the minutes-to-
seconds conversion — cannot be cross-validated against Traccar by anyone. That
part of the system has no external oracle, and the interns should be told so
rather than discovering it on day nine.

**3. Framing is proven; semantics are only partly proven.** That `102` decodes to
the integer you encoded is now solid. That the integer *means* lifetime engine
minutes on a given CAN program is a hardware question, and no simulator can
answer it.

---

## Recommendations

1. **Add negative coordinates to the scenario library.** Everything is in Dubai
   today. The sign handling is correct, but nothing in the committed test suite
   would catch a regression — the harness that found this is external. A single
   scenario in the western hemisphere would close that permanently.
2. **Add the canonical Teltonika vector to `test/`** if it is not already pinned
   beyond the CRC check, and assert the decoded *field values*, not just the CRC.
3. **Fix the external-target gap** in `run-fleet.js` / `run-actros.js` before the
   interns reach Stage 5 — they cannot load-test against Traccar without it.
4. **Tell the interns about gap 2 up front.** It reframes their Stage 3 work:
   they are validating position, ignition and movement against Traccar, and
   everything else against a second simulator-side reading.

---

## Re-running this

The harness lives in `intern/harness/` and imports the simulator via
`../../telematics/src/...`, so run it from the repo root. The two third-party
decoders are the oracles and are deliberately **not** added to
`telematics/package.json` (that package stays `pg`-only, near-zero-dep):

```bash
cd intern/harness && npm install --no-save complete-teltonika-parser teltonika-parser && cd ../..
node intern/harness/v1-canonical.mjs      # Teltonika's own vector
node intern/harness/v2-crossvalidate.mjs  # all scenarios × both codecs
node intern/harness/v3-edges.mjs          # edge-case matrix
node intern/harness/v4-device.mjs         # handshake / ACK behaviour
```

All four re-verified 2026-09-04 against `f71a29d`: v1 CRC `0xC7CF` PASS and both
decoders identical on every field, v2 **12,590/12,590**, v3 **40 PASS / 1 FAIL**
(the FAIL is FINDING-001, the library's unsigned-altitude defect), v4 hand-decode
MATCH plus IMEI-rejection and withheld-ACK behaviour as described.

`v2` is the one worth wiring into CI — it is the only test in the project whose
oracle is not the project itself.
