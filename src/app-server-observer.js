import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

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

function websocketConstructor(dataDirectory) {
  const requireFromData = createRequire(path.join(dataDirectory, "package.json"));
  const WebSocket = requireFromData("ws");
  return WebSocket.default ?? WebSocket;
}

export class AppServerObserver {
  constructor(dataDirectory, {
    discover = discoverSocketPath,
    WebSocket = websocketConstructor(dataDirectory),
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
  } = {}) {
    this.discover = discover;
    this.WebSocket = WebSocket;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null;
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
    this.connecting = this.connectOnce().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async connectOnce() {
    this.socketPath = this.discover();
    const socket = new this.WebSocket(`ws+unix://${this.socketPath}:/`, {
      handshakeTimeout: this.connectTimeoutMs,
      perMessageDeflate: false,
      maxPayload: 1024 * 1024,
    });
    this.socket = socket;
    socket.on("message", (data) => this.onMessage(data, socket));
    socket.on("error", (error) => this.onSocketError(error, socket));
    socket.on("close", () => this.onSocketClose(socket));

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to the Codex app-server socket")), this.connectTimeoutMs);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
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
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    this.connected = true;
    this.lastError = null;
  }

  onMessage(data, socket) {
    let message;
    try {
      message = JSON.parse(data.toString());
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
    if (this.socket && this.socket.readyState < this.WebSocket.CLOSING) this.socket.terminate();
  }

  onSocketClose(socket = this.socket) {
    if (socket !== this.socket) return;
    this.connected = false;
    this.socket = null;
    const closeError = this.lastError || "Codex app-server connection closed";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(closeError));
    }
    this.pending.clear();
  }

  request(method, params) {
    if (!this.socket || this.socket.readyState !== this.WebSocket.OPEN) {
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
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < this.WebSocket.CLOSING) socket.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server connection closed"));
    }
    this.pending.clear();
  }
}
