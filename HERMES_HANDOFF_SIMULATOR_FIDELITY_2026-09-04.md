# Handoff → @integration-engineer (+ @qa-test-engineer on item 5) — simulator fidelity & verification plan

**From:** simulator-verification discussion, 2026-09-04 (the Actros demo-unit
work + the "how do we know the simulator is actually correct" review that
followed it).
**Owner of this work:** `@integration-engineer` (Module 9 — Simulator, per
`AGENTS.md`) for items 1–4; `@qa-test-engineer` for item 5 (the invariant/
feature→test map is explicitly their charter).
**Blocks:** nothing downstream — every item here is simulator/test-tooling
only, same boundary `HERMES_HANDOFF_VEHICLE_SCENARIOS_2026-09-02.md` drew.
It unblocks confidence, not code: right now "the simulator is correct"
rests on our own tests agreeing with our own implementation, plus one
external check (Teltonika's canonical packet in `test/crc.test.js`). Items
1 and 4 below add checks that don't depend on trusting this codebase's own
judgment of itself.
**Companion docs:** `docs/PROTOCOL.md` (the wire format these tools drive
against), `context/simulator/VEHICLE_SCENARIOS_PLAN.md` and
`HERMES_HANDOFF_VEHICLE_SCENARIOS_2026-09-02.md` (the buffered-offline-burst
work item 3 below deliberately overlaps with — **check that hasn't already
landed before starting item 3**, it may have shipped as part of Tier 4
there).

---

## The ask, in one sentence

Five additions that move "the simulator's tests pass" to "the simulator has
been checked against something outside its own code" and "the whole team,
not just whoever wrote it, can see what's covered" — ranked below by
effort-to-value, not by the order I first raised them.

## Why this is scoped the way it is

Everything already in `src/simulator/` is well-sourced (every AVL ID in
`config.js`'s `IO` map is cross-checked against a named Teltonika source, and
`test/crc.test.js` decodes Teltonika's own documented example packet
byte-for-byte). That's the right foundation, but it has one structural
blind spot common to every hand-built simulator: **it can only ever send
what its author thought to model.** A real device occasionally does things
nobody wrote a scenario for — a buffered burst after reconnect, a firmware
quirk in element ordering, timestamp drift after a cold boot. No amount of
additional hand-written scenarios closes that gap; only real captured data
or an independent second implementation can. Items 1 and 4 are the two
paths to that kind of evidence; items 2, 3, 5 are lower-risk, high-value
tooling and documentation that make the existing simulator easier to trust
and easier to hand to people who didn't build it.

---

## Recommended order (fastest value first, not urgency)

1. Feature-coverage matrix (doc only, zero code risk, immediately useful)
2. Codec 8/8E parity matrix (small, mechanical, extends existing tests)
3. Network-condition stress (medium effort — check Tier 4 overlap first)
4. Live control panel (medium-high effort, biggest team/training payoff)
5. Replay-from-capture tool (build the mechanism now; its real payoff is
   gated on getting an actual device capture, which may wait on D1 hardware)

---

## 1. Feature-coverage matrix — `docs/FEATURE_COVERAGE.md`

**Owner:** `@qa-test-engineer`.

**What it is:** one table, every AVL IO ID in `config.js`'s `IO` map as a
row: `AVL ID | Name | Simulated? (which scenario/phase) | Decoded into a
canonical field? (normalize.js) | Proven by (test file + test name) |
Notes`. Include the deliberately-NOT-implemented IDs too (AVL 12/13, AVL
10) with their documented reason, pulled straight from the comments already
in `config.js` — the point is a reader shouldn't have to open source files
to know what's covered.

**Why this first:** it costs nothing to the running system, and it's the
single artifact that lets someone who isn't `@integration-engineer` — an
intern, a client, an auditor — answer "does this cover everything" without
reading code. Right now that knowledge only exists scattered across
file-header comments.

**How to build it without it silently going stale:** write a small checker
script, `src/tools/coverage-check.js`, that parses `IO` from `config.js`,
greps `test/` for each ID's numeric literal, and flags any ID with zero
test-file hits — not to auto-generate the prose (the "why" column needs a
human), but as a `npm run check:coverage` command that fails loudly if a
future new IO ID is added without ever appearing in a test, so the doc
can't quietly drift out of sync the way a hand-maintained table normally
would. Wire it into `test:gate`'s spirit (a CI check, not necessarily the
same file) — decide with `@qa-test-engineer` whether it blocks the gate or
just warns.

**Acceptance:** the doc exists, every `IO` entry has a row, `npm run
check:coverage` passes (or its warnings are explained), and it's linked
from `README.md` § "Where to read more".

---

## 2. Codec 8 / 8E parity matrix — extend `test/scenarios.test.js`

**Owner:** `@integration-engineer`, reviewed by `@protocol-engineer` (codec
internals are their module).

**What it is:** today, codec choice is a global flag (`SIM_CODEC` / `npm
run sim -- --codec 8`) — nothing currently proves every named scenario
decodes identically under both Codec 8 and Codec 8E. Add a parametrized
pass: for each name in `SCENARIO_NAMES`, build it once, encode+decode the
same records under both `CODEC_8` and `CODEC_8E` (`src/protocol/codec.js`
already exports both), and assert the decoded records are equal except for
the codec-specific framing bytes themselves. This is genuinely mechanical —
a loop around code that already exists — but it's never actually been
asserted, and Codec 8 and 8E differ in field widths in a few places (8E
widens some counts to 2 bytes), so a bug that only shows up under one codec
is currently invisible.

**Files:** `test/scenarios.test.js` (or a new `test/codec-parity.test.js`
if that file is getting long — `@qa-test-engineer`'s call).

**Acceptance:** new test(s) green under both codecs, `DEFAULT_MIN_TESTS`
raised in the same commit per the usual convention (`npm test` locally
first, document the before/after count the way every prior handoff has).

---

## 3. Network-condition stress — new `src/simulator/network-conditions.js`

**Owner:** `@integration-engineer`. **Check `HERMES_HANDOFF_VEHICLE_SCENARIOS_2026-09-02.md`
Tier 4 (buffered-offline-burst: many records arriving in ONE packet after a
gap) before starting — it may already be built. This item is the
complementary, still-open case: ONE record's bytes arriving fragmented
across MANY small TCP writes, which is what a real device on poor cellular
signal actually does, and which nothing currently exercises — every
existing scenario writes each packet as a single, whole `socket.write()`.**

**What it is:**
- `driblet(buffer, { chunkBytes = 4, delayMs = 20 })` — an async generator
  or helper that writes a `Buffer` to a socket in small pieces with a delay
  between each, instead of one `write()` call. `src/ingestion/server.js`'s
  framer already accumulates partial data via `Buffer.concat` in `conn.buf`
  and waits for a complete frame (`readAvlFrame` returns `null` on an
  incomplete buffer) — that logic is exercised today only by whole-packet
  in-memory test buffers, never a genuinely fragmented real socket write.
  This proves the accumulation logic actually works over real TCP
  fragmentation, not just in a unit test that hands it one complete Buffer.
- A mid-frame abrupt disconnect helper: write N bytes of a frame, then
  `socket.destroy()` before the frame completes. Assert the server doesn't
  hang, doesn't corrupt state for the *next* connection (each socket gets
  its own `conn` object already — this should hold, but has never been
  asserted explicitly), and the ingestion server's connection-tracking
  (`sockets` Set) correctly drops the dead one.

**Files:** `src/simulator/network-conditions.js` (new, pure helper — no
dependency, matches the file-style convention across `src/simulator/`),
`test/network-conditions.test.js` (new).

**Acceptance:** a scenario replayed byte-by-byte with `driblet()` decodes
identically to the same scenario sent whole; a mid-frame disconnect leaves
the server able to accept and correctly handshake the *next* connection
with zero cross-contamination; `DEFAULT_MIN_TESTS` raised accordingly.

---

## 4. Live control panel — extend `src/tools/sim-control-server.js` + `dashboard/index.html`

**Owner:** `@integration-engineer`.

**What it is:** today the dashboard's scenario buttons are one-shot: click,
the whole pre-built scenario streams and the connection closes. Add a
**manual control mode** — one persistent `SimDevice` connection per session,
with live toggles instead of a canned timeline:

- `POST /control/:imei/ignition { on }`
- `POST /control/:imei/gps { lat, lon, speedKmh, satellites }` (satellites
  = 0 simulates GPS-fix loss on demand)
- `POST /control/:imei/event { type: 'harsh-brake'|'harsh-accel'|'harsh-corner' }`
  (fires one record with the matching AVL 253/254 pair, reusing the exact
  logic `buildIo()` already has for these)
- `POST /control/:imei/silence { seconds }` (device goes quiet — useful for
  poking at the idle-timeout hardening from the handshake-limiter work)
- `POST /control/:imei/garbage` (writes a deliberately malformed frame —
  reuses the fixtures `test/codec-hardening.test.js` already has for F1/F2/F4)

Each call mutates an in-memory "current state" object for that session and
either sends a record immediately or on the next tick — implementation
detail for whoever builds it, but keep state mutation and record-building
separable (mirrors how `buildIo()` already takes a flat options object, so
this is composition, not new IO logic).

**Dashboard UI:** a new tab/panel next to the existing scenario buttons —
toggle switches, a couple of sliders, and the event/garbage/silence
buttons — wired to the endpoints above via `fetch`. The existing SSE
wire-log panel needs no changes; it already shows whatever bytes go out
regardless of which mode triggered them.

**Why this matters for the "hand it to interns" goal specifically:** this
is what actually lets someone explore instead of only replaying a fixed
story — closer to how an engineer pokes at a real device on a bench, and
the fastest way for a new team member to build intuition for what each
signal means.

**Acceptance:** manual mode runs alongside the existing scenario buttons
without disturbing them (they're separate code paths — don't refactor
`replayTrack` to share state with this); each control action is visible
in the wire log within one tick; closing the manual session cleanly
disconnects the socket (reuse `SimDevice.close()`).

---

## 5. Replay-from-capture tool — new `src/simulator/replay-capture.js`

**Owner:** `@integration-engineer`, with `@protocol-engineer` reviewing any
decode mismatch a real capture surfaces (that's a Module 0/2 bug by
definition, not a Module 9 one).

**What it is:** feed *real, previously captured* Codec 8/8E bytes — from an
actual Teltonika unit, Teltonika's own device emulator, or a distributor
demo unit — through the exact same TCP path the simulator uses, verbatim,
not re-encoded from our own records. This is the check nothing else here
provides: everything else in this repo, including the simulator itself,
is bytes *we* constructed from our own understanding of the spec. A real
capture is bytes a real device actually put on the wire.

**Capture format (v1 — keep it dependency-free):** don't add a pcap-parsing
library. Accept a simple text format instead — one JSON file per capture:
`{ imei, packets: ["<hex>", "<hex>", ...] }`, each hex string one complete
AVL packet (the IMEI handshake is separate — `imei` field — and sent via
the normal handshake path). Document in the file header exactly how to
produce one: Wireshark → follow the TCP stream → "Show and save data as
Hex Dump" → hand-trim to just the AVL packet bytes (skip the handshake
bytes, which are just 2-byte-length + ASCII IMEI and easy to strip by
eye), or capture with `tcpdump -w` and extract the same way.

**Where captures live:** `telematics/captures/` — **add this to
`.gitignore`.** A real capture may contain a real customer's actual GPS
trail and IMEI; that must never be committed. Ship one small, clearly
synthetic example capture *built from our own `encodeAvlPacket()`* so the
mechanism itself has a committed regression test, with the file header
making unmistakably clear it is NOT a real capture and proves nothing about
real-device fidelity — only that the replay path itself works.

**Function shape:** `replayCapture({ filePath, host, port })` — loads the
JSON, connects a raw `net.Socket` (or reuses `SimDevice`'s connection logic
with a flag to skip its own packet-building), performs the handshake with
`imei`, then writes each packet buffer exactly as stored and reads the
ACK, logging: handshake accepted/rejected, each packet's ACK count, and
any parse-level warning surfaced by the server's own logger (rate-limiter
rejections, F1/F2/F4 hardening rejections, etc. — all real signal if they
fire against genuine device bytes).

**CLI:** `npm run sim:replay -- --file captures/<name>.json` (mirrors
`sim:actros`'s `SIM_SERVER_HOST`/`SIM_SERVER_PORT` override for pointing
at an external receiver too, so the same capture can also be replayed
through Traccar as a cross-check).

**Acceptance:** `test/replay-capture.test.js` proves the mechanism against
the one committed synthetic fixture (round-trips correctly, ACKs as
expected). Explicitly flag in the test file header that this is a
mechanism proof, not a fidelity proof — the fidelity proof only exists once
someone attaches a genuine capture from real hardware or Teltonika's
emulator, which stays a manually-run, not-in-CI step until that data
exists (real device data has no place in the automated test suite by
default — see the `.gitignore` note above).

---

## Overall acceptance criteria (same bar every prior handoff in this repo used)

- Deterministic where determinism is possible (items 2, 3, 5's fixture);
  items 4's manual control panel is explicitly NOT deterministic by design
  — it's an interactive tool, not a scenario, and should not be pulled into
  `test:scenarios`' determinism assertion.
- Every new test lands with `DEFAULT_MIN_TESTS` raised in the same commit,
  verified locally first (`npm test` before bumping the number).
- Nothing here touches `src/decode/`, `src/ledger/`, `src/rules/`, or
  `src/messaging/` — if a real capture (item 5) surfaces a decode bug,
  that's a hand-off to `@protocol-engineer`, written up the same way
  `HERMES_HANDOFF_POWER_SIGNALS.md` did, not a Module 9 fix.
- `npm run test:gate` stays green throughout; nothing here is allowed to
  lower the floor or skip a test to land faster.

## Boundaries

- **Stay in `src/simulator/`, `src/tools/sim-control-server.js`,
  `dashboard/index.html`, `docs/`, and `test/`.** Same boundary as the
  vehicle-scenarios handoff.
- **Item 5's captures folder is gitignored, always.** Never commit real
  device data captured from an actual customer machine — treat it with the
  same care as the ledger's real-fleet-data gate.
- **Don't let item 4 (manual control) turn into a second scenario engine.**
  It's deliberately un-scripted and interactive; if someone wants a new
  *repeatable* story, that belongs in `scenarios.js` as a named scenario,
  not as a sequence of manual-control API calls someone has to remember.
- **Item 1's coverage matrix documents what exists — it does not gate new
  work.** Don't block a future IO addition on updating the doc in the same
  commit unless `@qa-test-engineer` decides to make `check:coverage` part
  of `test:gate` itself; until then it's a warning, not a blocker.
