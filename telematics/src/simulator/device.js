// ─────────────────────────────────────────────────────────────────────────────
// src/simulator/device.js — a simulated Teltonika unit (TCP client). It sends
// the exact bytes a real FMC130/FMC920 sends: IMEI handshake, then length-framed
// Codec 8/8E packets, and it WAITS for the server's 4-byte ACK before it would
// clear a record from its buffer — the device side of invariant 1.
//
// Because this is the genuine wire protocol, swapping this class for a physical
// device requires zero server changes.
// ─────────────────────────────────────────────────────────────────────────────

import net from 'node:net';
import {
  encodeImei,
  encodeAvlPacket,
  CODEC_8,
  CODEC_8E,
} from '../protocol/codec.js';

// Small helper: await exactly N bytes from a socket (handshake reply = 1, ACK = 4).
// A waiter must also settle when the bytes will NEVER arrive: the server can drop
// the socket after (or instead of) the durable write, and a bare promise would
// then sit pending forever — the run wedges with no error, no timeout, no exit.
// Both close and error reject every outstanding waiter, so connect() and send()
// surface "server went away" to their caller instead of hanging.
class ByteReader {
  constructor(socket) {
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.ended = null; // Error once the socket can no longer deliver bytes
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.#flush();
    });
    const fail = (err) => {
      this.ended = err;
      for (const { reject } of this.waiters.splice(0)) reject(err);
    };
    socket.on('close', () => fail(new Error('connection closed before the expected reply')));
    socket.on('error', (e) => fail(e));
  }
  #flush() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const { n, resolve } = this.waiters.shift();
      resolve(this.buf.subarray(0, n));
      this.buf = this.buf.subarray(n);
    }
  }
  read(n) {
    return new Promise((resolve, reject) => {
      if (this.ended && this.buf.length < n) return reject(this.ended);
      this.waiters.push({ n, resolve, reject });
      this.#flush();
    });
  }
}

export class SimDevice {
  // `onPacket`, if given, fires once per send() with the EXACT bytes just
  // written to the socket plus the server's ACK — { packet, records, ack }.
  // Optional and purely observational (a dev-tooling hook for the browser
  // control panel to show what's really on the wire); nothing here changes
  // if it's omitted, and no existing caller passes it.
  constructor({ host, port, imei, codec = '8E', onPacket }) {
    this.host = host;
    this.port = port;
    this.imei = imei;
    this.codecId = String(codec) === '8' ? CODEC_8 : CODEC_8E;
    this.onPacket = onPacket;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port });
      this.socket.setNoDelay(true);
      let settled = false;
      // One persistent error handler: reject the connect promise if we fail
      // before handshake, otherwise swallow it. A real unit shrugs off a dropped
      // server link and reconnects; the durability test relies on this too.
      this.socket.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
      this.socket.on('connect', async () => {
        try {
          this.reader = new ByteReader(this.socket);
          this.socket.write(encodeImei(this.imei)); // handshake
          const reply = await this.reader.read(1);
          settled = true;
          if (reply[0] === 0x01) resolve(this);
          else reject(new Error(`server rejected IMEI ${this.imei}`));
        } catch (e) {
          if (!settled) {
            settled = true;
            reject(e);
          }
        }
      });
    });
  }

  // Send one packet of records; resolves with the ACK count the server returned.
  async send(records) {
    const packet = encodeAvlPacket({ codecId: this.codecId, records });
    this.socket.write(packet);
    const ack = await this.reader.read(4);
    const ackCount = ack.readUInt32BE(0);
    this.onPacket?.({ packet, records, ack: ackCount });
    return ackCount;
  }

  // Send WITHOUT waiting for the ACK, then return the raw bytes — used by the
  // durability test to model "device sent, server crashed before ACK".
  sendNoWait(records) {
    const packet = encodeAvlPacket({ codecId: this.codecId, records });
    this.socket.write(packet);
    return packet;
  }

  close() {
    this.socket?.end();
  }
}
