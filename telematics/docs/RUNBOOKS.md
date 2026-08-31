# Run-books

Literal, copy-pasteable procedures for operating this slice. Written for someone
who has never seen the code — including you, at 2am, when something is wrong.

Everything below assumes you are **inside `telematics/`** and have **Node ≥ 20**.
Memory mode needs no install, no Docker, and no `.env`.

| I want to… | Go to |
|---|---|
| Run it and see it work | [1. First run](#1-first-run-zero-setup) |
| Replay a specific story (handover, tamper, …) | [2. Replay a scenario](#2-replay-a-scenario) |
| Run the servers separately, like production | [3. Run the pieces separately](#3-run-the-pieces-separately) |
| Understand a log line | [4. Read the logs](#4-read-the-logs) |
| Check whether an instance is healthy | [5. Interpret /health](#5-interpret-health) |
| Stop or restart without losing data | [6. Graceful restart](#6-graceful-restart) |
| Prove nothing is broken before merging | [7. Run the gate](#7-run-the-merge-gate) |
| Fix something that is broken | [8. Troubleshooting](#8-troubleshooting) |

---

## 1. First run (zero setup)

```bash
cd telematics
npm run demo
```

**Expected:** a report ending in `Demo complete.` The three numbers that matter:

```
Session 1 (Mar 2025): sent 20 records in one packet, server ACK=20
Session 2 (Jul 2025): sent 5 records in one packet,  server ACK=5
Idempotency check: resent 5 records -> server ACK=5, stored 0 new (expected ACK=5, 0 new)
```

Read them as: **20** and **5** mean every record was durably written before the
server acknowledged it (invariant 1). **0 new** on the resend means a device
re-sending after a missed ACK cannot double-bill anyone (invariant 2) — and note
it still ACKs 5, because the device must be told to clear its buffer.

Below that, Tenant A sees 20 positions and an ECU engine-hours figure; Tenant B
sees 5 positions and **no** engine hours. That is the same physical device, split
by the timestamp of each record (invariant 6), with engine data suppressed
because Generator Y has no CAN program (invariant 9).

If any of those numbers differ, **stop** — do not treat it as flaky. See §8.

---

## 2. Replay a scenario

The simulator speaks the genuine Teltonika protocol, so replaying a scenario is
as close to real hardware as you can get without hardware.

```bash
npm run sim:list                        # what scenarios exist and what each proves
```

Then, in one terminal:

```bash
npm run start:ingest                    # the "cell tower" devices dial into
```

and in another:

```bash
npm run sim -- --scenario handover      # the D1 story: one device, two tenants
npm run sim -- --scenario yard-idle     # the unassigned D2 in the yard
npm run sim -- --scenario tamper        # harness pulled mid-shift
npm run sim -- --scenario day-cycle --interval 0    # as fast as the server ACKs
```

**Expected:** one `sent N, ACKed N` line per track, with the two numbers equal.
The simulator exits 0 when every track finishes; a non-zero exit means at least
one track failed and the log says which.

Useful flags: `--interval 0` (no delay, for tests), `--records 5` (truncate),
`--seed foo` (change the jitter — output stays deterministic per seed),
`--codec 8` (older framing), `--stream` (soak: ignore scenarios and send
forever). Every flag has an `.env` equivalent — see `.env.example`.

**What "good" looks like for `handover`:** 22 records, 11 either side of
`2025-06-01T00:00:00Z`, from ONE IMEI over two connections. Query the API
afterwards and Tenant A holds only pre-handover records, Tenant B only
post-handover ones.

---

## 3. Run the pieces separately

Three terminals, closest thing to the production topology:

```bash
npm run start:ingest    # TCP, port 5027 by default    (INGEST_PORT)
npm run start:api       # HTTP, port 8080 by default   (API_PORT)
npm run sim -- --scenario day-cycle
```

> ### ⚠ In memory mode these processes do NOT share data
>
> `DB=memory` means an **in-process** store: each process gets its own. So an API
> started in its own terminal will answer `{"devices":[]}` and zero positions no
> matter how many records the ingestion server just ACKed. That is correct
> behaviour, not a bug — and it is worth knowing before you spend an hour
> debugging an empty dashboard.
>
> To see ingested data over HTTP, pick one:
>
> | Want | Do this |
> |---|---|
> | A quick end-to-end look | `npm run demo` — ingestion, API and simulator in **one** process, sharing one store |
> | Real separate services | run with `DB=pg` (**phase P1**, needs Docker + `npm install`) so both processes talk to the same database |
> | Just check ingestion works | read the ingestion log: `event=packet_acked` with `records` counts |
>
> Running them separately in memory mode is still useful — it is how you exercise
> the TCP path, the handshake, ACK behaviour, graceful shutdown, and `/health`.
> Only the cross-process *queries* need a shared store.

Query the API the way a dashboard would — every data endpoint needs a tenant
(against `npm run demo`, or a `DB=pg` deployment):

```bash
curl -s localhost:8080/health

# Tenant A = Al Naboodah (the seeded contractor)
TENANT=11111111-1111-4111-8111-111111111111
curl -s -H "X-Tenant-Id: $TENANT" 'localhost:8080/positions?limit=5'
curl -s -H "X-Tenant-Id: $TENANT" localhost:8080/devices
curl -s -H "X-Tenant-Id: $TENANT" \
  localhost:8080/assets/a0000000-0000-4000-8000-000000000001/engine-hours

# No tenant header => 400, by design (invariant 7)
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/positions
```

Tenant and asset IDs come from `src/store/seed-data.js`.

---

## 4. Read the logs

Both servers emit **one structured line per event** — JSON by default,
`LOG_FORMAT=kv` for eyeballing:

```
ts=2026-08-31T10:22:41.632Z level=info module=ingestion event=listening host=0.0.0.0 port=25027 store=memory
```

Fields are always `ts`, `level`, `module`, `event`, then event-specific fields.
Grep on `event=`, not on prose.

| Event | Module | Means |
|---|---|---|
| `listening` | ingestion, api | Bound and serving. If you don't see this, nothing started. |
| `handshake_accepted` | ingestion | A known IMEI connected. Carries `imei`, `model`. |
| `handshake_rejected` | ingestion | Unknown IMEI, socket closed. The device is not in the registry. |
| `packet_acked` | ingestion | A packet was **committed and then** acknowledged. `records` / `inserted` / `deduped`. |
| `connection_dropped` | ingestion | Bad CRC/preamble or a failed write. **No ACK was sent** — the device will resend. |
| `connection_refused_draining` | ingestion | We are shutting down; the device should reconnect elsewhere. |
| `request` | api | One HTTP request: `method`, `path`, `status`, `ms`. Never the tenant or query values. |
| `shutdown_started` → `shutdown_complete` | both | A clean drain. `ms` is how long it took. |
| `shutdown_timeout_forced` | both | The drain hit `SHUTDOWN_TIMEOUT_MS`. Investigate: something was stuck. |
| `drain_forced_sockets` | ingestion | A peer never answered our FIN and was destroyed. |

`deduped > 0` in `packet_acked` is **normal and healthy** — it is idempotency
absorbing a resend, not an error.

Two things you will never find in a log, deliberately: **credentials** (secret
field names are replaced with `***` and passwords are stripped out of connection
URIs) and **tenant data** (no tenant ids, no positions, no record bodies — counts
only). `/health` probes are not logged at all, so a load balancer polling every
few seconds cannot drown out real events.

Turn the volume up or down with `LOG_LEVEL=debug|info|warn|error|silent`. Debug
adds a line per record in the simulator.

---

## 5. Interpret /health

```bash
curl -s -i localhost:8080/health
```

| Status | Body `state` | Meaning | What an LB should do |
|---|---|---|---|
| `200` | `ready` | Serving normally. | Keep in rotation. |
| `503` | `draining` | A shutdown has begun; in-flight requests are finishing. | **Remove from rotation.** Do not send new traffic. |
| `503` | `unavailable` | The store is not initialised. | Remove from rotation. |
| no response | — | Process is gone or the port is blocked. | Remove from rotation. |

The probe reads only cached process state — it never touches the database, so it
stays fast and cannot turn a health check into load on your store. Point an
ALB/ECS target-group check straight at it.

---

## 6. Graceful restart

**What must not happen:** the process dies between committing a write and sending
the ACK. The device would resend (fine — idempotency absorbs it), but the reverse
— ACKing and then losing the data — would silently lose a record. The drain
sequence exists to make that impossible.

Send **SIGTERM** (or Ctrl-C, which is SIGINT — same handler):

```bash
kill -TERM <pid>        # or just Ctrl-C in the foreground
```

What happens, in order:

1. `/health` flips to **503** so the load balancer stops sending new traffic.
2. The listener closes — no new connections. A device arriving now is refused
   and reconnects to another instance.
3. **In-flight work finishes**: every packet already being processed completes
   its durable write *and* its ACK.
4. Open sockets get a FIN (a normal disconnect a real unit reconnects from).
5. The store closes and the process exits **0**.

You should see `shutdown_started` then `shutdown_complete` with an `ms` figure.

If you see **`shutdown_timeout_forced`**, the drain exceeded
`SHUTDOWN_TIMEOUT_MS` (default 10s) and was forced. The data already committed is
safe, but find out what was stuck. Keep that timeout **below** your
orchestrator's kill grace period (ECS defaults to 30s) or the platform will
SIGKILL you mid-drain and the whole sequence is moot.

**Do not** use `kill -9` on the ingestion server. There is no handler for it.

Verify the whole sequence for real, any time:

```bash
npm run verify
```

That spawns both servers as their own processes, replays a scenario through them
over TCP, probes `/health`, sends SIGTERM, and checks the exit codes and log
events. 14 checks; on Windows the 4 signal checks are skipped and say so
(Windows emulates POSIX signals and does not run the handlers).

---

## 7. Run the merge gate

```bash
npm test          # the suite, serially, human-readable
npm run test:gate # what CI runs — see below
npm run demo      # end-to-end proof on live data
npm run verify    # real processes, real signals
```

`npm run test:gate` is the gate, and it is stricter than `npm test` on purpose.
It fails if:

- any test fails, **or**
- anything is **skipped** or marked **todo** (a skip is not a pass), **or**
- the number of passing tests drops **below the floor** in
  `src/tools/test-gate.js`.

That last rule is the point: deleting a test would otherwise silently retire an
invariant's proof. If you legitimately remove tests, change the floor in the same
commit so it is visible in review.

Adding tests? Raise the floor. `MIN_TESTS=99 npm run test:gate` is a quick way to
confirm the gate actually fails when it should.

---

## 8. Troubleshooting

**`npm run sim` says `ECONNREFUSED`.** The ingestion server is not running, or
it is on a different port. Start `npm run start:ingest`, and check
`SIM_SERVER_PORT` matches `INGEST_PORT`.

**A server "starts" but nothing is listening.** Look for the `listening` log
line. If a start script exits 0 immediately and silently, the direct-run guard
did not fire — see `isEntrypoint()` in `src/lifecycle/shutdown.js`; the usual
`import.meta.url === file://${process.argv[1]}` idiom is false on Windows and
fails exactly this way.

**`handshake_rejected`.** The IMEI is not in the device registry. The two seeded
devices are `356307042441013` (FMC130) and `356307042441099` (FMC920) — see
`src/store/seed-data.js`. A real unit needs a row in `devices` first.

**`connection_dropped` with a CRC message.** The bytes on the wire are
malformed. Nothing was ACKed, which is correct. If it is the simulator talking to
our own server, that is a real protocol bug — do not "fix" it by relaxing CRC
validation.

**The API returns 400 for everything.** You are missing the `X-Tenant-Id`
header. That is the design (invariant 7), not a bug. `/health` is the only
endpoint that doesn't need it.

**A tenant sees no data.** First: are the API and the ingestion server separate
processes in `DB=memory`? Then they do not share a store and the API has nothing
— see the warning in §3. If they do share one, attribution is resolved at each
record's own timestamp: if the scenario's timestamps fall outside that tenant's
assignment window, the records legitimately belong to someone else — check
`ASSIGNMENTS` in `src/store/seed-data.js`. Records with no covering assignment go
to the device's **owner** tenant.

**Engine hours are missing.** Expected whenever the attributed asset has no CAN
program (`hasEngineData: false`) — Generator Y and any unassigned device
(invariant 9). The device may still be sending IO 200; the system is right to
ignore it.

**Port already in use.** Something else is on 5027 or 8080. Override
`INGEST_PORT` / `API_PORT`, or find the stale process. Tests and the demo use
ephemeral ports and are never affected.

**Tests hang or fail only in CI.** They run serially
(`--test-concurrency=1`) because several bind real sockets. Do not parallelise
them. Test files are enumerated in JS rather than by glob — see
`src/tools/test-files.js` for why (Node 20 can't glob, Node 24 can't take a
directory).

---

## Not in these run-books

**PostgreSQL mode** (`DB=pg`), row-level security, and the evidence-immutability
trigger are **phase P1** and have not been executed yet — see `TESTING.md` for
exactly what that means and `BUILD_PLAN.md` for when it happens. The **ledger**
(billing) and **WhatsApp messaging** are throwing stubs by design; nothing here
can produce an invoice.
