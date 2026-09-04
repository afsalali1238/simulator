// ─────────────────────────────────────────────────────────────────────────────
// src/simulator/imei.js — device identity for the simulated fleet.
//
// A real Teltonika unit ships with an IMEI burned in at manufacture, and the
// ingestion server's handshake only accepts an IMEI that is in the device
// registry (src/ingestion/server.js → store.deviceByImei). SimDevice
// (src/simulator/device.js) already performs the REAL Teltonika handshake with
// whatever IMEI it is given, and the wire/Codec 8/8E side is complete + tested.
// What has been missing to simulate a FLEET is many DISTINCT, WELL-FORMED IMEIs —
// this file mints them.
//
// IMEI structure (3GPP TS 23.003 §6.2): 15 decimal digits =
//     TAC (8)  ·  serial (6)  ·  Luhn check digit (1)
// The TAC (Type Allocation Code) identifies the model. We use 35630704, the TAC
// behind the seed's D1 (356307042441013) — which is Teltonika's own documented
// IMEI-handshake example — because the FMC130 is Dozr's device (user decision:
// "fmc130 is our product"). So a generated IMEI is unmistakably the same product
// line as the fixtures, just with a fresh serial.
//
// isValidImei() (codec.js) only checks "15 ASCII digits" — it does NOT check the
// Luhn digit, on purpose: a real unit that reports a mistyped IMEI must still be
// rejectable through the normal path, not crash the framer. But a FAITHFUL IMEI
// carries a correct Luhn digit, so we compute it here. The test suite pins this
// against the seed: D1 is Luhn-valid; D2 (356307042441099, hand-typed) is not.
//
// Deterministic by construction — no Math.random, no Date.now. The same arguments
// always yield the same IMEIs, so tests, demos, and dispute packs can pin them,
// in keeping with the rest of the simulator (see scenarios.js).
// ─────────────────────────────────────────────────────────────────────────────

// The FMC130 Type Allocation Code — see the header. Dozr's device; the same TAC
// as the seed's D1 and Teltonika's documented example IMEI.
export const FMC130_TAC = '35630704';

// Where generated serials start. The seed IMEIs use serials 244101 / 244109, so
// a low base keeps the generated fleet visibly distinct from the committed
// fixtures. With a 6-digit serial there is room for ~1,000,000 units on this TAC
// before it would need to change — far more than any simulation needs.
export const DEFAULT_SERIAL_BASE = 1;

/**
 * Compute the Luhn check digit for a 14-digit body (TAC + serial), per the
 * standard mod-10 algorithm. When forming the final 15-digit number the check
 * digit sits in the rightmost (units) position, so the body's own rightmost
 * digit lands in an even position and IS doubled; then every second digit moving
 * left is doubled, a doubled result > 9 has 9 subtracted, and the check digit is
 * whatever makes the grand total a multiple of 10.
 *
 * @param {string} body14 exactly 14 decimal digits
 * @returns {number} the check digit 0-9
 */
export function luhnCheckDigit(body14) {
  if (!/^[0-9]{14}$/.test(body14)) {
    throw new Error(`luhnCheckDigit expects 14 digits, got ${JSON.stringify(body14)}`);
  }
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const digit = body14.charCodeAt(13 - i) - 48; // walk right-to-left
    if (i % 2 === 0) {
      const doubled = digit * 2; // the body's rightmost digit is doubled
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * True iff a full 15-digit IMEI carries a correct Luhn check digit. This is a
 * STRONGER check than codec.js's isValidImei (which is format-only, by design):
 * every IMEI this module generates satisfies both.
 *
 * @param {string} imei15
 * @returns {boolean}
 */
export function luhnValid(imei15) {
  if (typeof imei15 !== 'string' || !/^[0-9]{15}$/.test(imei15)) return false;
  return luhnCheckDigit(imei15.slice(0, 14)) === imei15.charCodeAt(14) - 48;
}

/**
 * Build one full IMEI from a serial and a TAC. The serial is zero-padded to 6
 * digits and the Luhn check digit is appended. Throws if the pieces don't make a
 * clean 15-digit number — a mistake worth catching here, not on the wire.
 *
 * @param {number|string} serial 1-6 digit unit serial
 * @param {string} [tac] 8-digit Type Allocation Code (default FMC130)
 * @returns {string} a 15-digit, Luhn-valid IMEI
 */
export function makeImei(serial, tac = FMC130_TAC) {
  if (!/^[0-9]{8}$/.test(tac)) {
    throw new Error(`TAC must be 8 digits, got ${JSON.stringify(tac)}`);
  }
  const serialStr = String(serial);
  if (!/^[0-9]{1,6}$/.test(serialStr)) {
    throw new Error(`serial must be 1-6 digits, got ${JSON.stringify(serial)}`);
  }
  const body = tac + serialStr.padStart(6, '0');
  return body + String(luhnCheckDigit(body));
}

/**
 * A deterministic fleet of IMEIs: `count` units with sequential serials starting
 * at `serialBase`, all on `tac`. Deterministic by construction — the same
 * arguments always yield the same list — and every entry is 15 digits, TAC-
 * prefixed, and Luhn-valid.
 *
 * @param {object} opts
 * @param {number} opts.count how many IMEIs to mint (>= 1)
 * @param {number} [opts.serialBase] first serial (default DEFAULT_SERIAL_BASE)
 * @param {string} [opts.tac] 8-digit TAC (default FMC130)
 * @returns {string[]} unique IMEIs, in serial order
 */
export function generateFleet({ count, serialBase = DEFAULT_SERIAL_BASE, tac = FMC130_TAC } = {}) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`count must be a positive integer, got ${count}`);
  }
  if (!Number.isInteger(serialBase) || serialBase < 0) {
    throw new Error(`serialBase must be a non-negative integer, got ${serialBase}`);
  }
  if (serialBase + count - 1 > 999_999) {
    throw new Error(
      `serialBase ${serialBase} + count ${count} overflows the 6-digit serial space on TAC ${tac}`,
    );
  }
  const imeis = [];
  for (let i = 0; i < count; i++) imeis.push(makeImei(serialBase + i, tac));
  return imeis;
}
