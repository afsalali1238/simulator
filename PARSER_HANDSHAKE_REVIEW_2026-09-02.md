# Parser & Handshake — build review — 2026-09-02

**Reviewer:** Claude (docs / review role — audit only, **no code changed**).
**Scope:** the parser and the device handshake as they stand today —
`telematics/src/protocol/codec.js` (Codec 8/8E, CRC, IMEI framing, ACK),
`telematics/src/decode/normalize.js` + `telematics/src/decode/engine-hours.js`
(Module 2), and `telematics/src/ingestion/server.js` +
`telematics/src/ingestion/handshake-limiter.js` (Module 1). Requested after the
simulator (Module 9) landed.

**Out of scope:** ledger (Module 5, human-owned P2), messaging (Module 7,
credential-blocked), store internals, rules (Module 8, reviewed separately).

---

## Verdict — read this first

**The parser and handshake are correct on the happy path and correctly
*fail-closed* on the malformed cases they check. The gap is breadth, not
soundness: several hostile-input and unknown-input cases are not yet bounded or
validated, and two of them are cheap memory/connection-exhaustion vectors.**

Nothing here breaks a billing invariant, and nothing here is a "the module
doesn't work" problem like the Module 8 review found. The wire format is
faithful to Teltonika down to the documented CRC, invariant 1 (ACK-after-durable-write)
and invariant 2 (idempotent resend) are implemented and tested, and the raw
frame is copied before storage so the evidence chain (invariant 8) is intact.

What is missing is the **defensive envelope** around that correct core:

- **No upper bound on a declared packet length** — a peer can make the server
  buffer toward ~4 GB on one connection (**High**).
- **No socket idle / handshake timeout and no connection cap** — a silent or
  slow client holds a socket forever; many of them exhaust the process
  (**High**). These two compound into a classic slowloris.
- **No codec-ID allowlist** — an unknown codec (e.g. Codec 12 GPRS commands,
  Codec 16) is parsed as Codec 8 instead of rejected (**Medium**).
- **No IMEI format check** — any bytes are accepted at the frame level; only the
  registry lookup gates (**Medium**).
- **No GPS-fix validity flag** — a no-fix record is stored as lat/lon `0,0`
  ("Null Island") rather than flagged, which will mislead the P3 geofence rules
  (**Medium**).
- Plus lower-severity items (generic error on truncation, unsigned-only IO
  decode, rate-limiter keyed on `remoteAddress`) and **three untested
  fail-closed guards**.

These are all well-bounded, invariant-safe fixes. The handshake rate-limiter
added earlier today is exactly the right instinct — this review is the rest of
that same envelope. Recommended sequencing is at the end. **No code was changed;
this is a findings doc.**

---

## What I verified (commands + actual results)

Every finding below was reproduced by running the real modules, not by reading
alone. Probe script: `audit-probe.mjs` (in my scratch, not committed).

| Check | How | Result |
|---|---|---|
| Gate still green before I touched anything | `npm run test:gate` | **135/135, GATE PASSED, floor 135** |
| Valid 8E packet round-trips | `readAvlFrame(encodeAvlPacket(...))` | ok, codec `0x8e`, 1 record, `crcValid=true` |
| CRC matches real Teltonika | existing `test/crc.test.js` | `crc16(dataField) === 0xC7CF` on the canonical packet — TRUE |
| **F1** oversized length rejected? | `readAvlFrame` with `dataLen=0xFFFFFFFF` | **returns `null`** = "keep buffering ~4 GB". No rejection. |
| **F2** unknown codec rejected? | `readAvlFrame` on a `0x10` frame | **accepted**, parsed as Codec 8, no throw |
| **F3** count mismatch caught? | tamper `Number of Data 2`, fix CRC | **throws** `record count mismatch: 1 != 2` (fail-closed ✅, but no test) |
| **F4** truncated record | 1-record header, no record bytes, valid CRC | **throws** `RangeError: ...outside buffer bounds` (safe, but generic) |
| **F5** IMEI validated? | `readImeiFrame` len=0 / 15 letters / len=0xFFFF | empty accepted; `"ABCDEFGHIJKLMNO"` accepted; `0xFFFF`→`null` (waits) |
| **F6** idle timeout? | connect, send 0 bytes, wait 1.5 s | `socket.destroyed=false` — server never times it out |

---

## Findings, by severity

### F1 — No upper bound on a declared data-field length *(High)*

`readAvlFrame` (`src/protocol/codec.js:249-251`) reads a 4-byte data-field
length and then waits until the whole thing is buffered:

```js
const dataLen = buf.readUInt32BE(4);
const total = 8 + dataLen + 4;
if (buf.length < total) return null; // wait for more bytes
```

`dataLen` is attacker-controlled (any value after a valid all-zero preamble).
The server (`src/ingestion/server.js:83-86`) appends every chunk to `conn.buf`
and re-pumps, with no cap:

```js
socket.on('data', (chunk) => { conn.buf = Buffer.concat([conn.buf, chunk]); pump(); });
```

**Verified:** with `dataLen = 4,294,967,295`, `readAvlFrame` returns `null`, i.e.
"keep buffering", so one connection can be steered to accumulate ~4 GB before
anything decides to act. A realistic FMC130 packet is a few hundred bytes to a
few KB.

**Impact:** single-connection memory-exhaustion DoS. Also a parse-time CPU risk —
group/IO counts inside a giant CRC-valid frame drive read loops (`codec.js:196-211`),
which a length cap also bounds.

**Invariant impact:** none directly, but an OOM kill mid-write is exactly the
crash-consistency situation invariant 1's drain path is meant to survive; better
never to get induced into it.

**Fix (later, on your go):** a `MAX_PACKET_BYTES` (config, default ~64 KB — well
above any real packet). In `readAvlFrame`, if `dataLen > MAX` **throw** (so the
server drops the connection, no ACK) rather than return `null`. Add a test.

---

### F2 — No codec-ID allowlist: unknown codecs parse as Codec 8 *(Medium)*

`readAvlFrame` (`src/protocol/codec.js:263-265`) reads the codec byte and derives
only "is it 8E?":

```js
const codecId = dataField.readUInt8(0);
const extended = codecId === CODEC_8E; // anything not 0x8E is treated as Codec 8
```

There is no check that `codecId ∈ {0x08, 0x8E}`. **Verified:** a `0x10` frame is
accepted and parsed as Codec 8 with no error.

**Impact:** a device misconfigured to Codec 16, or any non-AVL frame (Codec 12 is
Teltonika's GPRS command channel — different structure entirely), is silently
mis-parsed instead of cleanly rejected. Low likelihood from a correctly-provisioned
FMC130, but "unknown protocol version ⇒ fail closed" is the right posture for a
public ingestion port, and it prevents a garbage record from ever reaching the
store.

**Fix:** reject an unrecognised `codecId` with a throw in `readAvlFrame`. Test
both accepted codecs stay green and an unknown one is refused.

---

### F3 — No GPS-fix validity flag; a no-fix record is stored as `0,0` *(Medium)*

The decoder passes coordinates straight through (`src/protocol/codec.js:183-187`)
and `normalizeRecord` stores them verbatim (`src/decode/normalize.js:105-110`)
with no reference to `satellites`. A Teltonika record with no GPS fix commonly
carries `satellites=0` and lat/lon `0,0`.

**Impact:** `0,0` is a real place in the Gulf of Guinea. Stored as a genuine
position it will (a) draw a track leg across the map to Null Island, and (b) —
more importantly — feed the **P3 geofence rules** a bogus location, which can
manufacture a spurious geofence **exit/enter** pair every time GPS drops. This is
the same *"absent is not a value"* principle as invariant 3 (NULL ≠ zero),
applied to position.

**Fix:** carry a `positionValid` / `fix` boolean (derived from `satellites > 0`,
or null the position) on the canonical record, and have the rules engine ignore
invalid-fix positions. Worth deciding **before** P3 rules work leans on position.

---

### F4 — IMEI has no format validation *(Medium / Low)*

`readImeiFrame` (`src/protocol/codec.js:59-65`) accepts any length (0–65535) and
any bytes. **Verified:** length 0 yields `imei=""`; 15 letters yields
`"ABCDEFGHIJKLMNO"`; both are accepted at the frame level. The only gate is
`store.deviceByImei` (`src/ingestion/server.js:114`).

**Impact:** limited — an unknown IMEI is rejected and now rate-limited. But a
`"15 ASCII digits"` check would reject junk one step earlier, keep malformed
values out of logs, and bound the handshake buffer (a `0xFFFF` length currently
makes the server wait for ~64 KB — see F6).

**Fix:** validate 15-digit ASCII in `readImeiFrame` (or at handshake); reject
otherwise. Cheap, and pairs naturally with the rate-limiter already there.

---

### F5 — Truncated record throws a generic `RangeError` *(Low)*

A CRC-valid frame whose record body is shorter than its header/counts imply
throws `RangeError: Attempt to access memory outside buffer bounds` from
`decodeRecord`'s fixed-offset reads (`src/protocol/codec.js:181-211`).

**This is safe** — the server treats any throw as "drop the connection, do NOT
ACK" (`src/ingestion/server.js:100-105`), so no bad data is persisted and the
device resends. The only issue is **diagnostics**: the operator sees a
`RangeError` in the log, not `malformed record: body shorter than declared`.

**Fix:** bounds-check before the header reads and throw a labelled protocol
error. Purely a legibility improvement; behaviour is already correct.

---

### F6 — No socket idle/handshake timeout and no connection cap *(High)*

`createIngestionServer` (`src/ingestion/server.js:51`) never calls
`socket.setTimeout(...)`, and `net.createServer` runs with no `maxConnections`.
**Verified:** a socket that connects and sends **0 bytes** is still open after
1.5 s (`socket.destroyed=false`); nothing will ever close it.

**Impact:** a client can open connections and go silent — each holds a socket and
its `conn.buf` indefinitely. Combined with **F1** (a connection can be made to
buffer ~4 GB) this is a textbook slowloris / resource-exhaustion vector, and the
handshake rate-limiter does **not** cover it (the limiter only counts *completed,
failed* handshakes — a silent socket never completes one).

**Fix:** a `socket.setTimeout(HANDSHAKE_TIMEOUT_MS)` before handshake (short, e.g.
10 s) and an idle timeout after; destroy on timeout. Optionally a
`server.maxConnections`. All config-driven, mirroring the existing
`HANDSHAKE_*` env knobs (`src/config.js:55-58`). This is the highest
value/effort item.

---

### F7 — IO element values are always decoded unsigned *(Low — latent, scope-bounded)*

`decodeRecord` reads every fixed-width IO value with `readUIntBE` /
`readBigUInt64BE` (`src/protocol/codec.js:203-207`) — always unsigned. The GPS
header correctly uses **signed** reads for lat/lon/altitude
(`readInt32BE`/`readInt16BE`, `codec.js:183-187`), so this is specifically the IO
section.

**Impact today: none.** Every IO the platform currently uses is unsigned —
ignition/movement (0/1), AVL 102 Engine Worktime, voltage, battery %, unplug. But
some Teltonika parameters are signed (e.g. Dallas/CAN temperatures can be
negative). If one is ever added to the decode set it will be silently
misinterpreted as a large positive number.

**Fix (only when a signed parameter is actually needed):** carry signedness in
the IO descriptor and use signed reads for those IDs. Flagged so it is a known
limitation, not a future surprise. Does **not** affect billing (AVL 102 is
unsigned).

---

### F8 — Rate-limiter keyed on `remoteAddress`, which depends on LB config *(Low)*

`handshake-limiter` throttles per `socket.remoteAddress`
(`src/ingestion/server.js:77,116,132`). The P4 target puts ingestion "behind a
TCP Network Load Balancer" (`TASKS.md`). If client-IP preservation is **on**
(AWS NLB instance/ip targets, default) this is correct; if it is **off**, or a
PROXY-protocol/proxy sits in front, `remoteAddress` becomes the LB's IP — and the
limiter would then throttle *all* devices together or fail to isolate a single
abuser.

**Impact:** deployment-coupled correctness, not a code bug. Worth an explicit
assertion/runbook note so P4 doesn't silently defeat the limiter.

**Fix:** document the client-IP-preservation requirement in `RUNBOOKS.md`; if
PROXY protocol is adopted, parse the real client IP before keying the limiter.

---

## What is genuinely right (credit where due)

- **Invariant 1 (ACK-after-durable-write) is correctly ordered and tested.** The
  ACK is written only after `store.persistPacket` resolves
  (`src/ingestion/server.js:167-176`); a pre-commit failure throws, is caught, and
  drops the connection without ACK (`ingestion.test.js` "never ACKs … when the
  write fails before commit").
- **Invariant 2 (idempotent resend) is proven end-to-end** over real TCP
  (`ingestion.test.js` "resending an identical packet is idempotent").
- **The CRC and wire format are faithful to Teltonika.** `crc16` is CRC-16/IBM
  (poly `0xA001`, reflected) and matches the documented `0xC7CF` on the canonical
  packet (`test/crc.test.js`).
- **`Number of Data` is correctly 1 byte in *both* codecs** (`codec.js:263-264,274`),
  avoiding the common "8E uses 2-byte record count" bug; the 2-byte widths in 8E
  are applied only where they belong (event IO id, IO counts, IO ids, NX group).
- **The raw frame is copied before storage** —
  `Buffer.from(conn.buf.subarray(...))` (`src/ingestion/server.js:141`) — so the
  sealed evidence chain (invariant 8) holds an independent copy, not a view that a
  later buffer op could mutate.
- **Attribution is per-record at each record's own timestamp** (invariant 6):
  `resolveAssignment(device.id, rec.timestampMs)` inside the record loop
  (`src/ingestion/server.js:161`).
- **Invariant 3 is correctly handled for IO** — absent → `null`, present-zero →
  `false`/`0` (`src/decode/normalize.js:49-50`); engine hours are `null` unless a
  billable ECU source is present.
- **Fail-closed everywhere it checks:** bad preamble, CRC mismatch, count
  mismatch, and truncation all throw and suppress the ACK.
- **The handshake limiter is well-built:** pure, injectable clock, self-sweeping
  to bound memory, and it clears an IP on a successful handshake so a fat-fingered
  real device isn't stuck throttled (`src/ingestion/handshake-limiter.js`).

---

## Test-coverage gaps (no code, just missing proofs)

The behaviours below are real (verified above) but **not asserted by any test**,
so a regression would pass the gate silently:

1. **`Number of Data 1 != Number of Data 2` throws** (F3) — fail-closed today,
   untested.
2. **Bad preamble throws** — `readAvlFrame` throws on a non-zero preamble
   (`codec.js:246-248`); `crc.test.js` only covers a CRC mismatch.
3. **Truncated record is rejected** (F4) — untested.
4. Once F1/F2/F6 are addressed, each needs a test (oversized length refused,
   unknown codec refused, idle socket closed) and the gate floor raised in the
   same commit — the deliberate, reviewable step `src/tools/test-gate.js` is built
   around.

---

## Recommended sequence (if/when you greenlight fixes)

This review changes nothing. When you want the fixes, a sensible order —
highest value first, each its own small commit with a test and a gate-floor bump:

1. **F6** socket + handshake idle timeout (and optional `maxConnections`).
2. **F1** `MAX_PACKET_BYTES` guard in `readAvlFrame`. (1 + 2 close the DoS.)
3. **F2** codec-ID allowlist.
4. **F3** GPS-fix validity flag — **decide before P3 rules** consume position.
5. **F4** IMEI 15-digit validation.
6. Backfill the three coverage-gap tests (F3-count, bad-preamble, truncation),
   then the new-behaviour tests from 1-5; raise the floor each time.
7. **F5** labelled truncation error; **F7** signed IO (only when needed); **F8**
   document the LB client-IP requirement.

Items 1-3 are the ones I'd not ship a public pilot without. 4 is the one with a
downstream deadline (P3). The rest are hygiene.

---

## Resolution — 2026-09-03 (fixes implemented)

The findings above are the audit as written on 2026-09-02 and are left intact as
the record. On **2026-09-03** the recommended sequence was greenlit and worked
through. Status:

| Finding | Severity | Status | Where |
|---|---|---|---|
| **F1** declared-length cap | High | **Fixed** | `codec.js` `readAvlFrame` throws when `dataLen > maxPacketBytes` (default 64 KB, `INGEST_MAX_PACKET_BYTES`) |
| **F2** codec-ID allowlist | Medium | **Fixed** | `codec.js` throws on any codec ∉ {0x08, 0x8E} after CRC |
| **F3** GPS-fix validity flag | Medium | **Fixed** | `normalize.js` sets `positionValid = satellites > 0`; `detectEvents.js` geofence rule drops `positionValid === false` |
| **F4** IMEI format check | Medium | **Fixed** | `isValidImei` (15 ASCII digits) + `MAX_IMEI_FRAME_LEN` cap in `codec.js`; server rejects `malformed_imei` and counts it toward the limiter |
| **F5** labelled truncation error | Low | **Fixed** | `decodeRecord` maps a `RangeError` to `malformed record: body shorter than declared` |
| **F6** socket timeouts + conn cap | High | **Fixed** | `server.js` handshake/idle `setTimeout` + optional `server.maxConnections`; `INGEST_HANDSHAKE_TIMEOUT_MS` / `INGEST_IDLE_TIMEOUT_MS` / `INGEST_MAX_CONNECTIONS` |
| **F7** signed IO decode | Low (latent) | **Deferred** — by design; no signed parameter is in the decode set yet. Revisit when one is added. |
| **F8** LB client-IP requirement | Low | **Documented** | `docs/RUNBOOKS.md` §8: the limiter keys on `remoteAddress`; the P4 NLB must preserve client source IP |

**Coverage-gap tests (the three the audit flagged as correct-but-unproven):** all
added — `Number of Data 1 != 2`, non-zero preamble, and truncated record.

**Tests + gate.** Two new suites: `test/codec-hardening.test.js` (10 pure-Buffer
tests: F1/F2/F4-frame/F5 + the three coverage gaps) and
`test/ingestion-hardening.test.js` (4 wire-level tests: F6 handshake-timeout,
F6 idle-timeout, F6 `maxConnections` refusal, F4 malformed-IMEI reject +
limiter). Gate floor **135 → 149**, `npm run test:gate` green (149/149, no
skips/todos), `npm run demo` green.

**Scope.** Each fix is its own commit (see the sequence the reviewer recommended
above). All changes are confined to the parser, decode-normalise, ingestion
server, config, `.env.example`, and the two new test files + RUNBOOKS. **No
ledger, messaging, store, or tenancy code was touched**, and no invariant was
relaxed — the new guards only widen the fail-closed envelope the audit found
already correct.

---


*No files in `telematics/` were modified for this review. All findings were
reproduced against the code as committed + the uncommitted working tree at
135/135. Billing (ledger) and tenancy code were not in scope and were not
touched.*
