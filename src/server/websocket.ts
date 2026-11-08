// The server's side of a WebSocket (RFC 6455), small enough to read: the
// handshake, text messages in and out, ping, and close. A client sends JSON
// messages, so binary frames are refused. No dependency, so the server keeps
// running as written.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** The largest message a client may send, in bytes. */
const MAX = 1 << 20;

export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage?: (text: string) => void;
  onClose?: () => void;
}

/** Completes the handshake for an upgrade request, or refuses it; gives the open socket. */
export function accept(request: IncomingMessage, raw: Duplex): Socket | undefined {
  const key = request.headers["sec-websocket-key"];
  if (request.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
    raw.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return undefined;
  }
  const answer = createHash("sha1").update(key + GUID).digest("base64");
  raw.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`);

  let buffered = Buffer.alloc(0);
  let parts: Buffer[] = [];
  /** The bytes of the message so far, across its fragments. */
  let size = 0;
  let closed = false;
  const frame = (opcode: number, payload: Buffer) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(n)]);
    if (!raw.destroyed) raw.write(Buffer.concat([head, payload]));
  };
  const socket: Socket = {
    send: (text) => !closed && frame(1, Buffer.from(text)),
    close(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code);
      body.write(reason, 2);
      frame(8, body);
      raw.end();
      socket.onClose?.();
    },
  };

  raw.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    // Each pass reads one whole frame, if one has arrived.
    for (;;) {
      if (buffered.length < 2) return;
      const fin = buffered[0] & 0x80;
      const opcode = buffered[0] & 0x0f;
      const masked = buffered[1] & 0x80;
      let length = buffered[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const big = buffered.readBigUInt64BE(2);
        length = big > BigInt(MAX) ? MAX + 1 : Number(big);
        at = 10;
      }
      // A client must mask what it sends, and nothing may be larger than MAX.
      if (!masked || length > MAX) return socket.close(length > MAX ? 1009 : 1002, length > MAX ? "Too big" : "Unmasked");
      if (buffered.length < at + 4 + length) return;
      const mask = buffered.subarray(at, at + 4);
      const payload = Buffer.from(buffered.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffered = buffered.subarray(at + 4 + length);

      if (opcode === 8) return socket.close();
      if (opcode === 9) frame(10, payload);
      else if (opcode === 10) continue;
      else if (opcode === 2) return socket.close(1003, "Text only");
      else if (opcode === 1 || opcode === 0) {
        // The running size, not a rescan of every fragment, and an empty fragment adds nothing to keep.
        size += payload.length;
        if (size > MAX) return socket.close(1009, "Too big");
        if (payload.length > 0) parts.push(payload);
        if (fin) {
          const text = Buffer.concat(parts).toString("utf8");
          parts = [];
          size = 0;
          socket.onMessage?.(text);
        }
      }
    }
  });
  const gone = () => {
    if (closed) return;
    closed = true;
    socket.onClose?.();
  };
  raw.on("close", gone);
  raw.on("error", gone);
  return socket;
}

function bigLength(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}
