import { request } from "node:http";

const MAX_PAYLOAD = 1024 * 1024;

// Node's built-in WebSocket accepts the Undici dispatcher interface. Route only
// its HTTP upgrade through a Unix socket; Node still owns the WebSocket protocol.
// https://github.com/nodejs/undici/blob/main/docs/docs/api/WebSocket.md
class UnixSocketDispatcher {
  constructor(socketPath, { handshakeTimeout, maxPayload }) {
    this.socketPath = socketPath;
    this.handshakeTimeout = handshakeTimeout;
    this.webSocketOptions = { maxPayloadSize: maxPayload, maxFragments: 16384 };
    this.request = null;
    this.socket = null;
    this.timer = null;
    this.destroyed = false;
  }

  dispatch(options, handler) {
    if (this.destroyed) {
      queueMicrotask(() => handler.onError(new Error("Codex app-server connection closed")));
      return true;
    }

    // Undici accepts header records, flat arrays, and arrays of pairs.
    const entries = Array.isArray(options.headers) && !Array.isArray(options.headers[0])
      ? Array.from({ length: options.headers.length / 2 }, (_, index) => options.headers.slice(index * 2, index * 2 + 2))
      : options.headers;
    const headers = Array.isArray(entries) ? Object.fromEntries(entries) : { ...entries };
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
    delete headers["sec-websocket-extensions"];

    const outgoing = request({
      socketPath: this.socketPath,
      method: "GET",
      path: options.path,
      headers,
      agent: false,
    });
    this.request = outgoing;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      this.destroy();
      handler.onError(error);
    };
    handler.onConnect(() => this.destroy());
    this.timer = setTimeout(() => {
      fail(new Error("Codex app-server WebSocket handshake timed out"));
    }, this.handshakeTimeout);
    outgoing.on("error", fail);
    outgoing.on("response", (response) => {
      response.destroy();
      fail(new Error(`Codex app-server rejected the WebSocket upgrade (HTTP ${response.statusCode})`));
    });
    outgoing.on("upgrade", (response, socket, head) => {
      if (this.destroyed) {
        socket.destroy();
        return;
      }
      clearTimeout(this.timer);
      this.socket = socket;
      // The native client internally offers compression even though the wire
      // request above does not. Reject unsolicited extensions before its parser
      // can accept them and start decompressing frames.
      if (response.headers["sec-websocket-extensions"] !== undefined) {
        fail(new Error("Codex app-server negotiated unsupported WebSocket extensions"));
        return;
      }
      socket.pause();
      if (head.length) socket.unshift(head);
      handler.onUpgrade(response.statusCode, response.rawHeaders.map((value) => Buffer.from(value, "latin1")), socket);
      settled = true;
      // The native client installs its frame parser after processing the upgrade.
      // Preserve any frames delivered in the same read as the HTTP headers.
      setImmediate(() => {
        if (!this.destroyed) socket.resume();
      });
    });
    outgoing.end();
    return true;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.request?.destroy();
    this.socket?.destroy();
  }
}

export function createUnixWebSocket(socketPath, { handshakeTimeout = 1000, maxPayload = MAX_PAYLOAD } = {}) {
  const dispatcher = new UnixSocketDispatcher(socketPath, { handshakeTimeout, maxPayload });
  const socket = new globalThis.WebSocket("ws://localhost/", { dispatcher });
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event) => {
    // Supplement the native parser's limit: control frames interleaved with
    // fragments can bypass its final continuation-length check in Node 24.
    const size = typeof event.data === "string" ? Buffer.byteLength(event.data) : event.data.byteLength;
    if (dispatcher.destroyed || size > maxPayload) {
      event.stopImmediatePropagation();
      dispatcher.destroy();
    }
  });
  return { socket, terminate: () => dispatcher.destroy() };
}
