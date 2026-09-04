// ─────────────────────────────────────────────────────────────────────────────
// test/imei.test.js — Module: simulator device identity (src/simulator/imei.js).
// Proves the fleet mints DISTINCT, well-formed, Luhn-valid FMC130 IMEIs, and
// pins the Luhn implementation against the committed seed:
//   • D1 (356307042441013) is Luhn-valid — Teltonika's own documented example;
//   • D2 (356307042441099) is hand-typed and Luhn-INVALID (its real check is 6).
// Also proves a generated IMEI clears the wire handshake's format gate
// (isValidImei) so the identities this module mints are actually dial-in-able.
//   run: npm run test:imei
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  luhnCheckDigit,
  luhnValid,
  makeImei,
  generateFleet,
  FMC130_TAC,
  DEFAULT_SERIAL_BASE,
} from '../src/simulator/imei.js';
import { isValidImei } from '../src/protocol/codec.js';
import { DEVICES } from '../src/store/seed-data.js';

const D1 = '356307042441013'; // seed FMC130 — Luhn-valid
const D2 = '356307042441099'; // seed FMC920 — hand-typed, Luhn-invalid

test('imei: luhnCheckDigit reproduces the seed D1 check digit (3)', () => {
  // D1 is Teltonika's documented example IMEI; its body must yield check digit 3.
  assert.equal(luhnCheckDigit('35630704244101'), 3);
  assert.equal(D1, '35630704244101' + '3');
});

test('imei: luhnCheckDigit shows the seed D2 IMEI is hand-typed (real check is 6, seed carries 9)', () => {
  assert.equal(luhnCheckDigit('35630704244109'), 6);
  assert.notEqual(D2.charAt(14), '6'); // seed carries 9 — deliberately invalid
});

test('imei: luhnCheckDigit refuses anything that is not exactly 14 digits', () => {
  assert.throws(() => luhnCheckDigit('123'), /14 digits/);
  assert.throws(() => luhnCheckDigit('3563070424410x'), /14 digits/);
  assert.throws(() => luhnCheckDigit('356307042441011'), /14 digits/); // 15, too long
});

test('imei: luhnValid accepts seed D1 and rejects the hand-typed seed D2', () => {
  assert.equal(luhnValid(D1), true);
  assert.equal(luhnValid(D2), false);
});

test('imei: luhnValid rejects non-15-digit / non-string input', () => {
  assert.equal(luhnValid('123'), false);
  assert.equal(luhnValid('35630704244101x'), false);
  assert.equal(luhnValid(356307042441013), false); // not a string
  assert.equal(luhnValid(''), false);
});

test('imei: makeImei builds a 15-digit, Luhn-valid IMEI and zero-pads the serial', () => {
  const imei = makeImei(1);
  assert.equal(imei, '356307040000019');
  assert.equal(imei.length, 15);
  assert.equal(imei.slice(0, 8), FMC130_TAC);
  assert.equal(imei.slice(8, 14), '000001'); // padded to 6
  assert.equal(luhnValid(imei), true);
});

test('imei: makeImei validates its TAC and serial arguments', () => {
  assert.throws(() => makeImei(1, '123'), /TAC must be 8 digits/);
  assert.throws(() => makeImei(1234567), /serial must be 1-6 digits/);
  assert.throws(() => makeImei('12x'), /serial must be 1-6 digits/);
});

test('imei: generateFleet mints unique, 15-digit, Luhn-valid, TAC-prefixed IMEIs', () => {
  const fleet = generateFleet({ count: 25 });
  assert.equal(fleet.length, 25);
  for (const imei of fleet) {
    assert.equal(imei.length, 15);
    assert.equal(imei.slice(0, 8), FMC130_TAC);
    assert.equal(luhnValid(imei), true, `${imei} should be Luhn-valid`);
  }
  assert.equal(new Set(fleet).size, 25); // all distinct
});

test('imei: generateFleet is deterministic and ordered by serial', () => {
  const a = generateFleet({ count: 5, serialBase: 10 });
  const b = generateFleet({ count: 5, serialBase: 10 });
  assert.deepEqual(a, b); // same args → same IMEIs, no PRNG
  assert.deepEqual(a, [10, 11, 12, 13, 14].map((s) => makeImei(s)));
});

test('imei: the generated fleet is disjoint from the committed seed IMEIs', () => {
  const seed = new Set(DEVICES.map((d) => d.imei));
  const fleet = generateFleet({ count: 100, serialBase: DEFAULT_SERIAL_BASE });
  for (const imei of fleet) assert.equal(seed.has(imei), false, `${imei} collides with a seed IMEI`);
});

test('imei: every generated IMEI clears the wire handshake format gate (isValidImei) and Luhn', () => {
  // isValidImei (codec.js) is format-only by design; a faithful IMEI is BOTH
  // format-valid and Luhn-valid, so a generated identity can actually dial in.
  for (const imei of generateFleet({ count: 12, serialBase: 500 })) {
    assert.equal(isValidImei(imei), true, `${imei} must pass the format gate`);
    assert.equal(luhnValid(imei), true, `${imei} must pass Luhn`);
  }
});

test('imei: generateFleet rejects a bad count and a serial-space overflow', () => {
  assert.throws(() => generateFleet({ count: 0 }), /positive integer/);
  assert.throws(() => generateFleet({ count: -3 }), /positive integer/);
  assert.throws(() => generateFleet({ count: 2, serialBase: 999_999 }), /overflow/);
});
