# GPS/Telematics Simulator — Team Onboarding

Read this before touching a real Teltonika unit. It explains what the device
actually does, how the simulator in this repo stands in for it, and how to
run the whole pipeline yourself and watch real Teltonika binary flow into a
real GPS platform (Traccar) — no hardware, no SIM card required.

---

## 1. The mental model (what happens with a real device)

1. **Power + SIM in a Teltonika unit (e.g. FMC130)** → it gets a GPS fix and
   opens a **TCP connection out** to a server address *you configured on the
   device beforehand* (via Teltonika Configurator over USB, or remotely via
   Teltonika RMS). The device always dials out — nothing ever dials into it.
2. **First thing it sends on that connection: its IMEI**, as a handshake.
   The server checks the IMEI against a list of devices it knows about.
   Unknown IMEI → the server just ignores the connection. This is the exact
   rejection this repo's own `start:ingest` server does — you can watch it
   happen (see §4).
3. **Once accepted**, the device streams **AVL data records** — GPS position,
   speed, ignition state, and whatever I/O elements it's been told to report
   (fuel, temperature, CAN engine hours, etc.) — encoded in **Codec 8 or
   Codec 8 Extended (8E)** binary, framed with a length prefix and a
   CRC-16/IBM checksum.
4. **The server ACKs** with a 4-byte "how many records I got" reply, but only
   *after* it has durably written the data — never before. A real device
   holds a record until it's ACKed and resends if it isn't (that resend must
   never double-count on the server side — that's the idempotency invariant).

So: **device configuration decides where and what it sends. A receiving
server (Traccar, or this repo's own `start:ingest`) decodes it. Nothing
about steps 2–4 requires real hardware to learn** — that's what the
simulator is for.

---

## 2. What the simulator in this repo actually is

`telematics/src/simulator/` is not a mock — it speaks the **real wire
protocol**: the same TCP framing, the same IMEI handshake, the same Codec
8/8E record layout, the same CRC, the same 4-byte ACK a genuine FMC130/FMC920
speaks. The only thing it can't do is come from an actual satellite fix or a
real CAN bus — everything downstream of "bytes on the wire" is
indistinguishable from hardware. When a real unit shows up, you point it at
the same port and change nothing on the server side.

It ships two ways to run it:

- **`npm run sim:actros`** — one fixed, memorable simulated unit (a
  Mercedes-Benz Actros haulage tractor, IMEI `356307045000006`, Codec 8E).
  Spins up its own throwaway receiving server and streams a believable
  shift. Zero setup — this is the one to hand to someone who's never seen
  any of this before.
- **`npm run sim` / `npm run sim:fleet`** — scenario-driven: named stories
  (`handover`, `yard-idle`, `tamper`, `after-hours`, `geofence-cross`,
  `day-cycle`) or a batch of distinct simulated devices. `npm run sim:list`
  prints every scenario and what it's meant to prove.

---

## 3. Try it in 10 minutes — against this repo's own server

Requires only **Node.js ≥ 20**. No Docker, no install, no SIM card.

```bash
git clone https://github.com/afsalali1238/simulator.git
cd simulator/telematics        # or wherever the clone puts telematics/

# terminal 1 — the "cell tower" that accepts device connections
npm run start:ingest

# terminal 2 — the read API (what a dashboard would call)
npm run start:api

# terminal 3 — the simulated device
npm run sim:actros
```

Watch terminal 1's logs: you'll see the IMEI handshake accepted, records
arriving, and ACKs going back. Then hit the API (terminal 2's port, default
8080) to see the decoded positions come back out as JSON.

**Now try the rejection case** — stop the simulator, and run
`npm run sim:actros` again but change the IMEI it uses (or just try
`npm run sim` against `start:ingest` without provisioning the device first).
You'll see the server refuse the connection — this is the exact same thing
that happens with a real Teltonika unit whose IMEI was never registered.
Seeing that rejection is worth it precisely because it removes a bug you'd
otherwise blame on "the device isn't sending" when actually the server never
accepted it.

For the full test suite and scenario replay: `npm test`, `npm run demo`,
`npm run sim:list` — see `telematics/README.md`.

---

## 4. Try it against Traccar (a real, independent GPS platform)

This is the part worth doing as a team exercise: prove the simulator's
output is genuinely standard Teltonika protocol by feeding it to something
we didn't write.

**Set up Traccar (Docker, fastest way):**

```bash
docker run -d --name traccar \
  -p 8082:8082 \
  -p 5027:5027 \
  traccar/traccar:latest
```

- `8082` — Traccar's web UI (`http://localhost:8082`, default login
  admin/admin).
- `5027` — Traccar's Teltonika protocol listener (this is the conventional
  Teltonika port — this repo's own `start:ingest` also defaults to it, which
  is why you can't run both at once on the same machine without changing a
  port).

**Register the device in Traccar FIRST** (devices always connect *out* to a
server — the server has to already know who it's willing to accept):

1. Open `http://localhost:8082`, log in.
2. Settings → Devices → Add device.
3. Identifier = `356307045000006` (the Actros IMEI above). Traccar
   auto-detects the Teltonika protocol from the handshake — no need to name
   it manually.
4. Save.

**Point the simulator at Traccar instead of our own server:**

```bash
SIM_SERVER_HOST=127.0.0.1 SIM_SERVER_PORT=5027 npm run sim:actros
```

Go back to Traccar's web UI → the device should show as online, with a
moving position on the map, speed, and ignition state — all decoded by
Traccar from the exact same bytes our own `start:ingest` decodes. That side-
by-side is the proof this isn't a toy protocol we invented; it's what a
$30–50 real Teltonika unit would actually say.

Try registering an IMEI that *isn't* the Actros one and watch Traccar
silently ignore the connection too — same rejection behavior as §3, now
proven against third-party software.

---

## 5. Configuring a REAL Teltonika device (for when hardware arrives)

None of the above requires this — it's here so the team knows what changes
when a physical unit shows up.

1. **Teltonika Configurator** (Windows/Linux desktop app, free, USB
   connection to the device) — the tool that sets:
   - Server IP + port (point it at Traccar's `5027`, or wherever
     `start:ingest` is deployed).
   - Codec version (8 vs 8E — 8E needed once you have more I/O elements
     than fit Codec 8's 1-byte IDs).
   - Reporting rules: time-based, distance-based, or angle-based record
     generation; ignition-on vs ignition-off intervals.
   - Which AVL I/O elements to enable (GNSS status, movement, ignition are
     standard; CAN-derived ones like engine hours depend on the CAN adapter
     *program* loaded for that specific machine make/model/year — this is
     the open decision tracked as **D1** elsewhere in this repo).
2. **Teltonika RMS (Remote Management System)** — once a device is in the
   field, you don't need physical USB access again: RMS lets you push config
   changes and firmware updates over the air, and gives visibility into
   device health/connectivity.
3. **SIM**: data-only M2M/IoT SIM with a stable APN. In the UAE, Etisalat/du
   both offer IoT SIM plans — this is a commercial decision, not a technical
   one, and doesn't block anything in §3–4.

The team should be able to do §3 and §4 with zero hardware in hand. Hardware
only changes step 1 above — everything else (server, decoding, storage,
API) stays exactly the same, which is the whole point of building the
simulator to speak the real protocol.

---

## 6. What to actually look at / learn while trying this

- Watch the **raw TCP bytes** if you want to see the protocol itself, not
  just the decoded output — `telematics/docs/PROTOCOL.md` documents the
  exact framing field by field.
- Notice that **a signal with no reading is never sent as 0** — it's just
  absent from the packet. This is invariant #3 in `CLAUDE.md` (`NULL ≠
  zero`) and matters a lot for billing: a machine with no CAN program simply
  never reports engine hours, rather than reporting a false zero.
- Run the `handover` scenario (`npm run sim -- --scenario handover`) to see
  one physical device change tenants mid-stream and watch the system
  attribute each record to the correct tenant by its own timestamp, not "as
  of now."
- `npm run test:gate` is the merge gate — if you touch anything here, this
  is what has to stay green.

---

## Where to read more

- `telematics/README.md` — full quick start, all run modes, all test commands.
- `telematics/docs/PROTOCOL.md` — the exact Teltonika framing, field by field.
- `telematics/docs/RUNBOOKS.md` — operating procedures, logs, health checks.
- `CLAUDE.md` (repo root) — the nine correctness invariants everything here
  is built around.
- `context/teltonika/` — real Teltonika datasheets and the technical pack.
