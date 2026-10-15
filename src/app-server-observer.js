import { execFileSync } from "node:child_process";
import path from "node:path";
import { createUnixWebSocket } from "./unix-websocket.js";

const REQUEST_TIMEOUT_MS = 900;
const CONNECT_TIMEOUT_MS = 1000;

export class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

export function discoverSocketPath({
  override = process.env.CODEX_KEEP_AWAKE_SOCKET,
  codexExecutable = "codex",
  timeoutMs = CONNECT_TIMEOUT_MS,
} = {}) {
  if (override) return path.resolve(override);
  const output = execFileSync(codexExecutable, ["app-server", "daemon", "version"], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const metadata = JSON.parse(output);
  if (typeof metadata.socketPath !== "string" || metadata.socketPath.length === 0) {
    throw new Error("Codex did not report an app-server socket path");
  }
  return metadata.socketPath;
}

export class AppServerObserver {
  constructor({
    discover = discoverSocketPath,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
  } = {}) {
    this.discover = discover;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null;
    this.connection = null;
    this.socketPath = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.connecting = null;
    this.connected = false;
    this.lastError = null;
  }

  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce().catch((error) => {
      this.lastError = error.message;
      this.close();
      throw error;
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async connectOnce() {
    this.socketPath = this.discover();
    const connection = createUnixWebSocket(this.socketPath, {
      handshakeTimeout: this.connectTimeoutMs,
      maxPayload: 1024 * 1024,
    });
    const { socket } = connection;
    this.socket = socket;
    this.connection = connection;
    socket.addEventListener("message", ({ data }) => this.onMessage(data, socket));
    socket.addEventListener("error", (event) => this.onSocketError(event.error, socket));
    socket.addEventListener("close", () => this.onSocketClose(socket));

    await new Promise((resolve, reject) => {
      const clear = () => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", closed);
      };
      const opened = () => { clear(); resolve(); };
      const failed = (event) => { clear(); reject(event.error ?? new Error("Codex app-server connection failed")); };
      const closed = () => { clear(); reject(new Error("Codex app-server connection closed")); };
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", closed);
    });

    const response = await this.request("initialize", {
      clientInfo: {
        name: "codex_keep_awake",
        title: "Codex Keep Awake",
        version: "0.1.0",
      },
    });
    if (!response || typeof response !== "object") {
      throw new Error("Codex app-server returned an invalid initialize response");
    }
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server connection closed during initialization");
    }
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    this.connected = true;
    this.lastError = null;
  }

  onMessage(data, socket) {
    if (socket !== this.socket) return;
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    } catch {
      this.onSocketError(new Error("Codex app-server returned malformed JSON"), socket);
      return;
    }
    if (message?.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new RpcError(
        typeof message.error.message === "string" ? message.error.message : "Codex app-server request failed",
        message.error.code,
      ));
    } else if (Object.hasOwn(message, "result")) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error("Codex app-server response omitted both result and error"));
    }
  }

  onSocketError(error, socket = this.socket) {
    if (socket !== this.socket) return;
    this.lastError = error?.message || "Codex app-server connection failed";
    this.connected = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(this.lastError));
    }
    this.pending.clear();
    this.connection?.terminate();
  }

  onSocketClose(socket = this.socket) {
    if (socket !== this.socket) return;
    this.connected = false;
    this.socket = null;
    this.connection = null;
    const closeError = this.lastError || "Codex app-server connection closed";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(closeError));
    }
    this.pending.clear();
  }

  request(method, params) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server is not connected"));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} request timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.socket.send(JSON.stringify({ method, id, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async readThreads(threadIds) {
    if (!this.connected) throw new Error("Codex app-server is not connected");
    const observations = await Promise.all(threadIds.map(async (threadId) => {
      try {
        const result = await this.request("thread/read", { threadId, includeTurns: false });
        if (!result?.thread || result.thread.id !== threadId || !result.thread.status
          || typeof result.thread.status.type !== "string") {
          throw new Error("Codex app-server returned a malformed thread/read response");
        }
        return { threadId, status: result.thread.status };
      } catch (error) {
        if (error instanceof RpcError) return { threadId, rpcError: error.message };
        throw error;
      }
    }));
    return observations;
  }

  close() {
    this.connected = false;
    const connection = this.connection;
    this.socket = null;
    this.connection = null;
    connection?.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server connection closed"));
    }
    this.pending.clear();
  }
}
