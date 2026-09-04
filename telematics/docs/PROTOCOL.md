# Protocol

This is the exact Teltonika framing implemented in `src/protocol/codec.js`. It is
the real on-the-wire contract for **Codec 8** (`0x08`) and **Codec 8 Extended**
(`0x8E`) over TCP, so a physical FMC130/FMC920 can replace the simulator with no
server change. Everything is **big-endian**.

The implementation is pure functions over `Buffer`s and is verified two ways:
`test/crc.test.js` checks it against Teltonika's own documented canonical packet
(CRC `0xC7CF`), and `test/codec.test.js` round-trips records through encode→decode
and asserts the bytes are identical.

---

## 1. IMEI handshake

The device opens the TCP connection and identifies itself first.

```
device → server:  [2 bytes: IMEI length = 15][15 bytes: IMEI as ASCII]
server → device:  [1 byte]  0x01 = accept, 0x00 = reject
```

`encodeImei(imei)` builds the frame; `readImeiFrame(buf)` parses it (returns `null`
if the buffer doesn't yet hold the whole frame — TCP is a stream). Our ingestion
server accepts only IMEIs it finds in the device registry, and rejects+closes
otherwise.

## 2. AVL data packet

After a successful handshake, the device streams AVL packets:

```
[4 bytes]  preamble = 0x00000000
[4 bytes]  data-field length N        (counts Codec ID … Number of Data 2)
--- data field (N bytes, this is what the CRC covers) ---
[1 byte]   Codec ID                   0x08 = Codec 8, 0x8E = Codec 8E
[1 byte]   Number of Data 1           record count (1 byte in BOTH codecs)
[ ... records ... ]
[1 byte]   Number of Data 2           must equal Number of Data 1
--- end data field ---
[4 bytes]  CRC-16                      low 2 bytes = CRC over the data field
```

`encodeAvlPacket({ codecId, records })` produces this; `readAvlFrame(buf)` consumes
it. `readAvlFrame` returns `null` if the whole packet hasn't arrived yet, and
**throws** on a bad preamble, a CRC mismatch, or a `Number of Data 1 ≠ 2`. The
ingestion server treats a throw as "drop the connection, do not ACK".

Because `Number of Data` is one byte, **255 records is the hard ceiling per
packet** — a real unit splits a longer buffered burst across packets, and
`encodeAvlPacket` throws above it rather than let the count truncate mod 256 into
a CRC-valid frame declaring a different number.

## 3. Server ACK

```
server → device:  [4 bytes]  = number of records accepted
```

`encodeAck(count)`. The device clears the acknowledged records from its buffer.
Our server sends this **only after the records are durably written**, so a missed
ACK leads the device to resend — which is safe because ingest is idempotent.
(`SimDevice.send()` rejects on a missed ACK rather than retrying by itself; the
server-side half — the idempotent re-ingest that makes a resend safe — is what is
implemented and tested. See the README note.)

---

## Record layout

Every record starts with an identical 24-byte header, in both codecs:

| Offset | Size | Field | Encoding | Notes |
|-------:|-----:|-------|----------|-------|
| 0 | 8 | Timestamp | `UInt64BE` | Unix milliseconds |
| 8 | 1 | Priority | `UInt8` | 0=low, 1=high, 2=panic |
| 9 | 4 | Longitude | `Int32BE` | degrees × 1e7 |
| 13 | 4 | Latitude | `Int32BE` | degrees × 1e7 |
| 17 | 2 | Altitude | `Int16BE` | metres |
| 19 | 2 | Angle | `UInt16BE` | degrees 0–360 |
| 21 | 1 | Satellites | `UInt8` | |
| 22 | 2 | Speed | `UInt16BE` | km/h |

Note the order is **Longitude then Latitude** — that is Teltonika's order, not the
more common lat/lon.

### IO section

After the header comes the IO section. This is the only place the two codecs differ:

- **Codec 8** — the Event IO ID, the total IO count, each group's count, and each
  IO ID are all **1 byte**.
- **Codec 8E** — all of those widen to **2 bytes**, and an extra variable-length
  ("NX") group is appended for values that aren't 1/2/4/8 bytes wide.

```
[W]   Event IO ID                 (W = 1 byte for Codec 8, 2 bytes for 8E)
[W]   Total IO count
  for each fixed group in order 1-byte, 2-byte, 4-byte, 8-byte values:
    [W]   count in this group
    repeated:  [W] IO ID   [size] value
  (Codec 8E only) NX group:
    [2]   count
    repeated:  [2] IO ID   [2] value length   [value bytes]
```

Values 1/2/4 bytes are unsigned big-endian integers; 8-byte values are `UInt64BE`.
The decoder recomputes the total from the groups, so a wrong total count is
tolerated on read but always written correctly.

---

## IO IDs used in this harness

All IDs below are the **real** documented FMC130 parameters, verified against
Teltonika's own table (see `../../D1_CAN_ENGINE_HOURS.md` for the verbatim rows).

| IO ID | Meaning | Width | Unit | Decoded? |
|------:|---------|-------|------|----------|
| 239 | Ignition (0/1) | 1 byte | — | ✅ |
| 240 | Movement (0/1) | 1 byte | — | ✅ |
| 69 | GNSS status | 1 byte | — | ✅ (simulator emits) |
| **102** | **Engine Worktime** — the machine's own hour-meter | 4 bytes | **minutes** | ✅ **the billing parameter** |
| **103** | Engine Worktime (counted) — counted by the *tracker* | 4 bytes | minutes | ⛔ **refused** as billing evidence |
| 100 | CAN program number | 4 bytes | — | emitted by the simulator; not yet decoded |
| 66 | External (vehicle) supply | 2 bytes | mV | `tamper` scenario only; not decoded |
| 113 | Internal battery level | 1 byte | % | `tamper` scenario only; not decoded |
| 252 | Unplug detected (0/1) | 1 byte | — | `tamper` scenario only; not decoded |
| 449 | Ignition On Counter | 4 bytes | seconds | ⛔ **forbidden** as billing evidence (invariant 5) |

⚠ **AVL 200 is `Sleep Mode`, not engine hours.** Earlier versions of this harness
used 200 as an "engine-on seconds" stand-in while D1 was open. That stand-in is
gone and the decoder now refuses it — a record carrying IO 200 produces no engine
data, and a test asserts it.

**102 vs 103 decides whether a number can be billed.** 102 is the machine's
lifetime meter, reconcilable against the physical dashboard hour-meter. 103 is a
tracker-side accumulator that starts at zero when the adapter is installed, cannot
be reconciled, and resets on an adapter swap. Only 102 may back an invoice; 103 is
dropped rather than relabelled `source: 'ecu'` (invariants 4 and 5).

The power/tamper IDs (66/113/252) exist so the P3 rules engine has realistic data
to be developed against. Nothing decodes them yet, so no canonical row depends on
them.

### Absence vs zero on the wire (invariant 3)

The simulator **omits** an IO element it has no reading for, rather than sending
`0`. This is not a shortcut — it is how a real unit behaves when a sensor or the
CAN adapter isn't fitted, and it is what makes invariant 3 testable: the decoder
must map *absent* to `null` while still treating a *present* `0` as a real reading
of false. The `tamper` scenario is the sharp case: once the harness is pulled the
unit can no longer read the bus, so ignition is **absent** (→ `null`, state
`unknown`), not `0` (→ `false`, state `off`). Those two mean very different things
to a billing dispute.

### Engine hours (D1) — resolved at the parameter level

Total engine hours arrive over the vehicle **CAN bus** through an adapter
(LV-CAN200 / ALL-CAN300 / CAN-CONTROL) running a **program number** specific to that
make/model/year. What the adapter then exposes is standard: **AVL 102 "Engine
Worktime", 4 bytes unsigned, in MINUTES.** That is the parameter this harness
decodes and the only one that may back an invoice.

**The unit is the trap.** The decoder's canonical unit is seconds, so the conversion
is `seconds = minutes × 60`, performed once in `src/decode/engine-hours.js`. Getting
it wrong is a **60× billing error that no invariant test would catch**, because the
pipeline is unit-agnostic — only the meaning is wrong. Each engine row therefore
carries `sourceAvlId` and `nativeUnit` so a billed figure is traceable to its
parameter.

Per-machine program numbers, the 4-vs-5-digit change for adapters made after
2018-01-01, and what still needs hardware verification are all in
`../../D1_CAN_ENGINE_HOURS.md`. The decoder's contract is unchanged: engine hours
only for CAN-supported assets, always `source: 'ecu'`.

---

## Canonical test vector

`test/crc.test.js` pins the implementation to this documented Teltonika packet (one
Codec 8 record), which every published Teltonika CRC reference agrees on:

```
000000000000003608010000016B40D8EA30
010000000000000000000000000000000105
021503010101425E0F01F10000601A014E00
0000000000000001
0000C7CF
```

Read as: preamble `00000000`, data-field length `00000036` (54 bytes), then the
54-byte data field beginning `08` (Codec 8) `01` (one record) …, and finally the
CRC field `0000C7CF`. The CRC-16/IBM over the data field is `0xC7CF`. If a change
ever breaks the framing or the CRC, this test fails immediately.
