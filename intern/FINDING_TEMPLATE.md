# FINDING-000 — <one-line summary>

> Copy this file to `findings/FINDING-0NN-short-slug.md` and fill in **every** field.
> A finding without raw hex is an opinion. We cannot act on opinions.

---

## Classification

Pick exactly one. If you cannot decide, that itself is the finding — pick (c) and
say why you couldn't decide.

- [ ] **(a) SIMULATOR BUG** — our encoder is wrong. Spec proves it.
- [ ] **(b) SERVER QUIRK** — the third-party decoder is wrong, or deliberately
      non-standard. Spec proves it.
- [ ] **(c) SPEC AMBIGUITY** — both readings are defensible from the documentation.

**Severity:** `blocker` / `major` / `minor` / `cosmetic`
**Would this affect a billed number?** yes / no  ← answer honestly, it drives priority

---

## Environment

| | |
|---|---|
| Simulator commit | `git rev-parse --short HEAD` |
| Scenario | e.g. `tamper` |
| Codec | `8` or `8E` |
| Server + version | e.g. `traccar/traccar:6.4` |
| Date | YYYY-MM-DD |
| Reproducible? | every time / intermittent (N of M) |

---

## Reproduction

```bash
# the exact command line, copy-pasteable
```

---

## The bytes

Raw packet as captured, annotated. Mark the disputed bytes.

```
00000000  00 00 00 00 00 00 00 3a  08 01 00 00 01 8f 2c 3d
          └─ preamble ─┘ └─ len ─┘  │  │  └──── timestamp ...
                                    │  └─ record count
                                    └─ codec id

          <<< disputed bytes at offset 0x__ >>>
```

**Byte offset in dispute:** `0x__`
**Field:** e.g. `IO 102 value`

---

## The disagreement

| | Value | Interpretation |
|---|---|---|
| **Simulator intended** | | |
| **Our decoder read** | | |
| **Server showed** | | |

---

## Evidence

Which document, which section, quoted verbatim. A link alone is not evidence —
quote the sentence you are relying on.

> "..."
> — [Teltonika Codec wiki, section X](url)

---

## Your judgement

Two or three sentences. What do you think is actually correct, and how confident are
you? "I think ours is right but I am not certain because the spec doesn't say what
happens when N is zero" is a **good** answer. Do not pretend to more confidence than
you have.

---

## Suggested fix

What *would* fix it — described, **not applied.** You do not patch `src/protocol/`.
If the fix belongs on the server side, say what you'd change and whether it is worth
reporting upstream to that project.
