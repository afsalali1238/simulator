// Teltonika's own documented canonical Codec 8 packet, assembled from labelled
// parts so a transcription slip can't be mistaken for a decoder bug.
import { readAvlFrame, crc16 } from '../../telematics/src/protocol/codec.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ProtocolParser } = require('complete-teltonika-parser');

const parts = [
  ['codec id',            '08'],
  ['number of data 1',    '01'],
  ['timestamp',           '0000016B40D8EA30'],
  ['priority',            '01'],
  ['longitude',           '00000000'],
  ['latitude',            '00000000'],
  ['altitude',            '0000'],
  ['angle',               '0000'],
  ['satellites',          '00'],
  ['speed',               '0000'],
  ['event io id',         '01'],
  ['n total io',          '05'],
  ['n 1-byte',            '02'],
  ['io 21 = 3',           '1503'],
  ['io 1 = 1',            '0101'],
  ['n 2-byte',            '01'],
  ['io 66 = 24079',       '425E0F'],
  ['n 4-byte',            '01'],
  ['io 241 = 24602',      'F10000601A'],
  ['n 8-byte',            '01'],
  ['io 78 = 0',           '4E0000000000000000'],
  ['number of data 2',    '01'],
];

const dataHex = parts.map(p => p[1]).join('');
const data = Buffer.from(dataHex, 'hex');
const crc = crc16(data);

const pkt = Buffer.concat([
  Buffer.from('00000000', 'hex'),
  (() => { const b = Buffer.alloc(4); b.writeUInt32BE(data.length); return b; })(),
  data,
  (() => { const b = Buffer.alloc(4); b.writeUInt32BE(crc); return b; })(),
]);

console.log('data field length : ' + data.length + '  (0x' + data.length.toString(16) + ')  — spec says 54 / 0x36');
console.log('CRC we compute    : 0x' + crc.toString(16).toUpperCase().padStart(4, '0'));
console.log('CRC Teltonika docs: 0xC7CF');
console.log('CRC MATCH         : ' + (crc === 0xC7CF ? 'PASS' : 'FAIL'));
console.log('full packet       : ' + pkt.toString('hex').toUpperCase());

const j = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

const ours = readAvlFrame(pkt);
console.log('\n=== DECODER A — src/protocol/codec.js ===');
console.log(j(ours.packet.records[0]));

const theirs = new ProtocolParser(pkt.toString('hex'));
console.log('\n=== DECODER B — complete-teltonika-parser (third party) ===');
console.log(j(theirs.Content).slice(0, 2200));
