# Dozr Telematics — Intern Mission Brief

**Programme:** Codec 8/8E cross-validation
**Duration:** 2 weeks
**Prerequisite:** Node ≥ 20, Docker, and the ability to read a hex dump without crying.

---

## 0. What you have been handed

You have been given a GPS tracker.

It is not a physical box. It is a program. But **nothing about the bytes it puts on
the wire is fake** — it opens a real TCP socket, performs the real Teltonika IMEI
handshake, and streams real Codec 8 / Codec 8E binary frames. A server on the other
end cannot tell it apart from an FMC130 bolted inside an excavator, and that is the
entire point.

Treat it as hardware. You have been issued a device. Go find out whether it tells
the truth.

### Why this matters commercially

Dozr rents heavy machinery. We bill by **engine hours**. The tracker is the meter.

If the meter is wrong, the invoice is wrong, and a customer who disputes an invoice
does not want a philosophical answer — they want the byte that proves it. Everything
you are about to do exists because a number on an invoice has to be defensible three
months after the machine left the site.

---

## 1. Vocabulary — read this once, it unlocks everything else

| Term | What it actually means |
|---|---|
| **FMC130** | The Teltonika tracker model we standardised on. GPS receiver + LTE modem + CAN bus adapter + a few IO pins, in a box, wired into a machine. |
| **IMEI** | The device's identity — 15 digits, globally unique, ends in a Luhn check digit. The *only* thing the device presents at connection time. It is **not a secret**. |
| **AVL** | "Automatic Vehicle Location". Teltonika's name for a telemetry record. One AVL record = one moment in time. |
| **AVL ID / IO ID** | A numbered channel inside a record. `239` is ignition. `102` is engine worktime. There are hundreds; we use nine. |
| **Codec 8 / 8E** | The two binary record formats. 8E is the extended one: wider ID fields and a variable-length section. |
| **ACK** | The server's 4-byte reply saying "I have N records". A real device keeps the records in flash until it sees this, and resends them if it doesn't. (Our simulator waits for the ACK but does not auto-resend — see Stage 5.) |
| **CAN bus** | The machine's internal network. An adapter taps it to read the engine's own hour-meter — the number that can legitimately be billed. |

---

## 1b. Your device roster — read before Stage 2

The simulator ships with a fixed set of identities. These are the IMEIs that will
actually appear on the wire, and **the ones you must register on any server you
test against.** They are real Luhn-valid IMEIs on Teltonika's FMC130 TAC
(`35630704`); they are not registered to any physical hardware anywhere.

| IMEI | Label | Model | Fitted with CAN? | Used by |
|---|---|---|---|---|
| `356307042441013` | **D1** | FMC130 | yes — reports AVL 102 | every scenario except `yard-idle` |
| `356307042441099` | **D2** | FMC920 | **no** — position + ignition only | `yard-idle`, `dic-to-reem` |
| `356307045000006` | Actros demo | FMC130 | yes | `sim:actros` only |

D2 is the important one for Rule 2. It has no CAN adapter, so it never sends engine
hours at all — not zero, *absent*. How a server represents that absence is one of
the things you are here to find out.

### Which runner can talk to an external server

This matters and it is not obvious:

| Command | Targets | Can point at Traccar? |
|---|---|---|
| `npm run sim` | `SIM_SERVER_HOST` / `SIM_SERVER_PORT` | **yes — this is your workhorse** |
| `npm run sim:actros` | boots its own loopback server | no |
| `npm run sim:fleet` | boots its own loopback server | no |

`sim:actros` and `sim:fleet` are self-contained demos: they start an internal
ingestion server on localhost and stream into it. They are for Stage 0 only.
**Everything from Stage 2 onward uses `npm run sim`.**

If you find yourself wanting `sim:fleet` pointed at Traccar for a load test, that is
a legitimate gap — raise it, do not hack around it.

---

## 2. The protocol, in one page

The full byte-level spec is in **`docs/PROTOCOL.md`** in your package. Read it
properly before Stage 1. This is only the mental model.

```
device                                    server
  |                                          |
  |---- TCP connect ------------------------>|
  |                                          |
  |---- [0x00 0x0F]["356307045000006"] ----->|   IMEI handshake, ASCII
  |<--- [0x01] ------------------------------|   0x01 accept / 0x00 reject
  |                                          |
  |---- [preamble][len][AVL data][CRC16] --->|   one packet, N records
  |<--- [0x00 0x00 0x00 0x05] ---------------|   ACK: "I have 5"
  |                                          |
  |---- ... keeps streaming ---------------->|
```

Four things worth burning into memory:

1. **The device is the client.** The server never initiates. It sits on a port and
   waits. This is why a tracker works behind carrier NAT with no public IP.
2. **Everything is big-endian.** Every length, every coordinate, every counter.
3. **Longitude comes before latitude.** Teltonika's record header is `lon, lat`.
   Almost every other system in the world is `lat, lon`. This has broken more
   integrations than any other single fact in this document.
4. **The ACK is a promise, not a receipt.** When a server ACKs, the device *deletes
   its only copy*. A server that ACKs before it has durably stored the record has
   quietly agreed to lose data on its next crash. Remember this — you will see it
   happen in Stage 3.

---

## 3. Three rules you are validating against

These are not style preferences. They are the properties that make telemetry
admissible as billing evidence.

**Rule 1 — ACK only after a durable write.**
The ACK is the moment responsibility transfers from device to server. Sending it
early is a silent data-loss bug that only appears under crash conditions.

**Rule 2 — Absent is not zero.**
If a machine has no CAN adapter fitted, its engine hours are `null`, not `0`. A
zero is a *claim* ("the engine ran for zero hours"). A null is an *admission* ("I do
not know"). One of those is defensible in a dispute; the other is a lie with a
number attached. On the wire, absence is expressed by **omitting the IO element
entirely** — not by sending it with value 0.

**Rule 3 — A resent packet must never double-count.**
The device resends anything it did not see an ACK for. That is correct device
behaviour. If the server counts those records twice, engine hours inflate and the
customer is overbilled.

Watch how each third-party server you test handles all three. **That is your job.**

---

## 4. The mission

Six stages. Each has a definition of done. Do not start a stage until the previous
one is genuinely done — this pipeline is cumulative and Stage 1 is a gate.

### Stage 0 — Boot it *(half a day)*

Get the simulator running against its own loopback ingestion server. No external
anything. This only proves your machine works.

```bash
npm install          # pg only; near-zero dependency by design
npm run sim:list     # see the scenario library
npm run sim:actros   # single device, self-contained, zero setup
```

**Done when:** you have watched a simulated Mercedes Actros complete a working day
and you can explain what a "scenario" is to the person next to you.

---

### Stage 1 — Read the wire by hand *(one day)* — **THIS IS THE GATE**

Capture the actual bytes leaving the simulator. Then decode **one AVL record by
hand**, on paper or in a text file, using `docs/PROTOCOL.md` and nothing else.

You must produce, for a single record you captured:

- the timestamp, converted to a human date
- longitude and latitude, as decimal degrees
- altitude, angle, satellites, speed
- every IO element: its ID, its width, its raw value, its meaning

Do it with `xxd`, a calculator, and the spec table. **Do not use the project's own
decoder to check your answer until you have finished** — you are calibrating
yourself, and the decoder is one of the things under test.

**Why this gate exists:** in Stage 3 you will have to judge whether a server's
interpretation of a byte is right or wrong. You cannot referee a disagreement
between two decoders if you cannot decode it yourself. Every intern who skipped
this stage produced findings that were useless.

**Done when:** your hand-decoded record matches the simulator's own decoder field
for field, and you found at least one field where you initially got it wrong and
understand why.

---

### Stage 2 — First contact: Traccar *(one day)*

[Traccar](https://www.traccar.org/) is the most widely deployed open-source GPS
server in the world. Its Teltonika decoder is independent of ours, written in Java,
maintained by people who have never seen our code. That independence is exactly what
makes it valuable.

```bash
docker run -d --name traccar \
  -p 8082:8082 -p 5027:5027 \
  traccar/traccar:latest
```

Port `5027` is Traccar's Teltonika port. Web UI is on `8082`.

**Then — and interns lose half a day to this every single time —**
**register the devices in Traccar before you send anything.** Settings → Devices →
Add, with the *Identifier* field set to the exact IMEI. You need **both**:

```
356307042441013     ← D1
356307042441099     ← D2
```

Traccar will happily complete the handshake with an unregistered IMEI and then
silently discard every position that follows. You will see a connection, no errors,
and no data on the map, and you will assume the simulator is broken. It is not.

(Note this is itself a Rule-1-adjacent design decision on Traccar's part, and worth
a line in your report: accepting a handshake you intend to discard data from is a
defensible choice, but it is a choice.)

Then point the simulator at it:

```bash
SIM_SERVER_HOST=127.0.0.1 SIM_SERVER_PORT=5027 npm run sim -- --scenario day-cycle
```

**Done when:** a simulated machine appears on the Traccar map and moves.

**Note before you celebrate:** "it appeared on a map" proves the handshake, framing
and CRC are right. It proves *almost nothing* about field correctness. A record with
latitude and longitude swapped still appears on a map — just in the wrong ocean.
Stage 3 is the actual work.

---

### Stage 3 — Field-by-field validation *(two to three days)* — the real work

For every scenario in the library, compare **what the simulator intended to send**
against **what Traccar believes it received**, field by field.

Build yourself a comparison harness. Do not do this by eye across two browser tabs;
you will make mistakes and you will not be able to prove your results later.

Cover at minimum:

- timestamp — including the millisecond/second question
- latitude, longitude — **including negative values** (see the traps below)
- altitude, angle, satellites, speed
- every IO element we emit: `239`, `240`, `69`, `102`, `103`, `100`, `66`, `113`, `252`, `449`
- how Traccar represents an IO element that was **omitted** vs one sent as `0`
- what Traccar does with a duplicate packet (resend the same records — does the
  count double?)
- when exactly Traccar sends its ACK relative to writing to its database

**Done when:** you have a table with one row per field per scenario, every row is
either `MATCH` or has a filed finding, and there are no unexplained cells.

---

### Stage 4 — Second opinion *(one to two days)*

One server agreeing with you is weak evidence. Two independent servers agreeing is
strong evidence. Two servers *disagreeing with each other* is the most interesting
result available to you, and it means the spec is ambiguous.

Repeat the core of Stage 3 against a second implementation — [Flespi](https://flespi.com/)
has a free tier and a genuinely excellent protocol inspector that shows you the
decoded frame next to the raw hex. Wialon is the third option if you can get access.

**Done when:** you can state, for each field, whether all three implementations
(ours, Traccar, Flespi) agree — and where they don't, which one you think is right
and why.

---

### Stage 5 — Edge cases *(two to three days)*

The happy path is done. Now try to break something.

- **Codec 8 vs 8E.** Run everything again with `SIM_CODEC=8`. The IO ID width
  changes from 2 bytes to 1. Do both servers handle both? (Every ID we currently
  emit fits in one byte, so all scenarios work in Codec 8 today. An ID above 255
  — 318 GNSS Jamming, 449 ignition counter — cannot be expressed in Codec 8 at
  all, and our encoder now says so instead of surfacing a raw range error.)
- **Multi-record packets.** Many records in one frame. Does the ACK count match?
  255 is the protocol ceiling (`Number of Data` is one byte); our encoder throws
  above it rather than let the count wrap. Worth checking what each server does
  with a frame that declares a count near the limit.
- **All four IO widths.** 1, 2, 4 and 8-byte values in the same record.
- **The `tamper` scenario.** Ignition goes *absent*, not zero. What does each server
  show — unknown, or off? This is Rule 2 under a microscope, and it is the single
  most commercially important cell in your entire results table.
- **The `handover` scenario.** One device, two machines, a timestamp boundary.
- **Satellites = 0.** No GPS fix. Does the server accept the coordinates anyway?
- **Reconnection.** Kill the socket mid-stream. Does the server double-count on
  the next connection? (Note: the *simulator* does not auto-resend — `send()`
  rejects on a missed ACK and the run stops. That is a known gap, not something
  for you to fix. To test a resend, reconnect and send the same records again;
  that is what `test:ingestion` does.)

**Done when:** every scenario in `npm run sim:list` has been run against both
servers and the results are recorded.

---

### Stage 6 — The report *(one day)*

One document. Your findings, your evidence, your recommendation. Format below.

---

## 5. The one rule that makes all of this worth doing

> **Do not "fix" the simulator to make a server happy. Ever.**

When the simulator and a server disagree, exactly one of three things is true, and
your only job is to determine which:

**(a) The simulator encodes it wrong.** → File it. Cite the Teltonika spec section
that proves it. This is a real bug and we will fix it.

**(b) The server decodes it wrong, or has a quirk.** → File it. Cite the spec, note
the exact server version. This is a real finding about *them*, and it may be the
reason we cannot use that server.

**(c) The spec is ambiguous and both readings are defensible.** → File it. **This is
the most valuable outcome available to you.** An ambiguity we discover in a
simulator costs an afternoon. The same ambiguity discovered in production costs a
customer.

A patch that turns a red light green without classifying it destroys the entire
value of the exercise. We are not trying to get a green light. We are trying to find
out what is true. A report that says "17 fields match, 3 disagree, here is why" is
worth vastly more than one that says "everything works".

---

## 6. Known traps

These are real. Each one has cost somebody a day.

1. **Longitude before latitude.** Header order is `lon, lat`. Everything else in
   your life is `lat, lon`.
2. **Test a negative coordinate.** Coordinates are signed int32, degrees × 10⁷.
   A sign-handling bug is *completely invisible in Dubai*, where both lat and lon
   are positive. Send something in the western hemisphere — Buenos Aires, −58.38 —
   before you declare coordinates correct.
3. **Timestamps are milliseconds**, 8 bytes. The classic bug is a factor of 1000.
   A 1970 date on the map means you divided when you shouldn't have.
4. **AVL 102 is in MINUTES.** Our canonical unit is seconds. `seconds = minutes × 60`.
   Get this wrong and you have a 60× billing error that no test will catch, because
   the number is structurally valid — only its meaning is wrong.
5. **AVL 200 is `Sleep Mode`, not engine hours.** An older version of this harness
   used it as a stand-in. If you find that anywhere, it is stale.
6. **102 vs 103.** Both are "engine worktime". `102` is the machine's own lifetime
   meter and is billable. `103` is counted by the tracker itself, starts at zero when
   the adapter is fitted, and resets if the adapter is swapped — it is *not* billable
   and must not be relabelled. They look identical in a data dump. They are not.
7. **`Number of Data 1` must equal `Number of Data 2`.** Servers differ on whether
   they actually enforce it. Find out.
8. **Speed `0` with satellites `0`** means "no fix", not "stationary".
9. **Traccar ACKs after queueing, not after committing.** Watch for this in Stage 3.
   It is not a bug in Traccar — it is a deliberate throughput choice — but it is
   precisely the trade-off Rule 1 refuses, and it is why we wrote our own ingestion
   rather than deploying Traccar. Seeing this yourself is a highlight of the
   programme.

---

## 7. Scope — what not to do

- **Do not modify `src/protocol/`.** It is the thing under test. Changing it
  invalidates your own results.
- **Do not add dependencies.** The package is `pg`-only and near-zero-dep on
  purpose. If you think you need a library, you probably need twenty lines.
- **Do not build a backend.** Ingestion, storage, billing and rules are out of
  scope and already exist. You are testing a device, not writing a platform.
- **Do not test against a production server** — anyone's. Local Docker and free
  tiers only.
- **Ask early.** A question on day one costs five minutes. The same question on day
  eight costs a week of work built on a wrong assumption.

---

## 8. Reading list

**Before Stage 1 — required**
- `docs/PROTOCOL.md` (in your package) — our exact framing. Read it twice.
- [Teltonika Codec wiki](https://wiki.teltonika-gps.com/view/Codec) — the primary
  source. When you cite a spec in a finding, cite this.
- [Teltonika AVL ID list](https://wiki.teltonika-gps.com/view/FMC130_Teltonika_Data_Sending_Parameters_ID)

**Before Stage 2**
- [Traccar protocol documentation](https://www.traccar.org/protocols/)
- Traccar's `TeltonikaProtocolDecoder.java` on GitHub — read the decoder you are
  testing against. It is about 300 lines and it will teach you more than any doc.

**Useful throughout**
- `xxd`, `hexdump -C`, and Wireshark with a TCP filter on your port.

---

## 9. How to report a finding

Every disagreement gets one of these. No exceptions, no "I'll write it up later" —
you will not remember the byte offset tomorrow.

Template is in `FINDING_TEMPLATE.md`. Fill in every field. A finding without raw
hex is an opinion, and we cannot act on opinions.
