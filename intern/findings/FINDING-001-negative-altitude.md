# FINDING-001 — `complete-teltonika-parser` reads altitude as unsigned

## Classification

- [ ] (a) SIMULATOR BUG
- [x] **(b) SERVER / LIBRARY QUIRK** — the third-party decoder is wrong
- [ ] (c) SPEC AMBIGUITY

**Severity:** `minor` (for us) / `major` (for anyone relying on that library)
**Would this affect a billed number?** No — altitude is not billing evidence.

---

## Environment

| | |
|---|---|
| Simulator | `src/protocol/codec.js`, staged 2026-09-04 |
| Scenario | synthetic edge case, not in the scenario library |
| Codec | reproduced on both `8` and `8E` |
| Third party | `complete-teltonika-parser@0.3.6` (npm) |
| Cross-refs | Traccar `TeltonikaProtocolDecoder.java` @ master; `teltonika-parser@0.0.15` |
| Reproducible | every time |

---

## Reproduction

```bash
node intern/harness/v3-edges.mjs      # section "negative & extreme altitude"
```

Encode one record with `altitude: -430` (Dead Sea shore, the lowest land on
Earth), then decode it with each implementation.

---

## The bytes

```
00000000 00000023 08 01 000001977420dc00 01 00000000 00000000 fe52 0000 08 0000 ...
                                                              ^^^^
                                                              altitude, 2 bytes
```

**Byte offset in dispute:** `0x19` (offset 25 in the packet; offset 17 within the record)
**Field:** Altitude
**Raw value:** `0xFE52`

`0xFE52` = 65106 unsigned = **−430 signed**. Both readings are arithmetically
valid for those two bytes; the question is which one the format specifies.

---

## The disagreement

| Implementation | Reads | |
|---|---|---|
| **Simulator intended** | −430 m | |
| **Our decoder** (`codec.js`) | **−430** | signed `Int16BE` |
| **Traccar** (`TeltonikaProtocolDecoder.java:460`) | **−430** | `buf.readShort()` — signed |
| **teltonika-parser@0.0.15** | **−430** | signed |
| **complete-teltonika-parser@0.3.6** | 65106 | unsigned — **outlier** |

Three independent implementations agree. One does not.

---

## Evidence

Traccar's Codec 8 / 8E path, the decoder in widest production use:

```java
position.setLongitude(buf.readInt() / 10000000.0);
position.setLatitude(buf.readInt() / 10000000.0);
position.setAltitude(buf.readShort());          // ← signed
position.setCourse(buf.readUnsignedShort());
```
— `src/main/java/org/traccar/protocol/TeltonikaProtocolDecoder.java`, lines 458–461

Note the deliberate contrast on the very next line: Traccar uses `readShort()`
for altitude and `readUnsignedShort()` for course. That is not an oversight —
the author distinguished the two.

The physical argument settles it independently of any implementation: land
surface exists below sea level (Dead Sea −430 m, Death Valley −86 m, Baku
−28 m), and vehicles are driven there. An unsigned altitude cannot represent
those positions at all, and would report a vehicle at the Dead Sea as being
65 km up.

---

## Judgement

**Our encoder is correct and requires no change.** Altitude is a signed 16-bit
big-endian integer in metres, and `docs/PROTOCOL.md` already documents it as
`Int16BE`.

`complete-teltonika-parser` has a real defect. Confidence: high — three
implementations plus a physical-plausibility argument all point the same way.

The practical consequence for us is a **scope note, not a fix**: that library is
not a trustworthy oracle for altitude, so any cross-validation result involving
altitude must come from Traccar or `teltonika-parser`.

---

## Suggested fix

None on our side.

Worth reporting upstream to `complete-teltonika-parser` — the change is one
method call, and the library is otherwise accurate (it agreed with us on all
12,590 other field checks). Low priority for us; we do not depend on it.
