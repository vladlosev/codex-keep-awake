import { randomBytes } from "node:crypto";
import { ensurePortalDesktopEntry, getPortalAppId } from "./portal-app-registration.js";

const PORTAL_NAME = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const INHIBIT_INTERFACE = "org.freedesktop.portal.Inhibit";
const REQUEST_INTERFACE = "org.freedesktop.portal.Request";
const DBUS_INTERFACE = "org.freedesktop.DBus";
const DBUS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const REGISTRY_INTERFACE = "org.freedesktop.host.portal.Registry";
const READY_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 750;
const CONNECTION_CLOSED = "The session bus connection was lost";
const PORTAL_OWNER_CHANGED = "The XDG Desktop Portal service owner changed";
const PORTAL_REJECTED = "The XDG Desktop Portal rejected suspend inhibition";
const PORTAL_TIMEOUT = "The XDG Desktop Portal did not respond in time";
const PORTAL_CANCELLED = "XDG Desktop Portal acquisition was cancelled";
const PORTAL_UNAVAILABLE = "The XDG Desktop Portal suspend inhibitor is unavailable";
const PORTAL_DESKTOP_ENTRY_FAILED = "The Codex Keep Awake desktop identity entry could not be prepared";
const PORTAL_APP_REGISTRATION_FAILED = "The XDG Desktop Portal rejected the Codex Keep Awake app identity";

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function remainingMs(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw failure("PORTAL_TIMEOUT", PORTAL_TIMEOUT);
  return remaining;
}

function requestPathIsValid(dbus, value) {
  if (typeof value !== "string") return false;
  if (typeof dbus.isValidObjectPath === "function") return dbus.isValidObjectPath(value);
  return value === "/" || (value.startsWith("/") && !value.endsWith("/")
    && value.split("/").slice(1).every((part) => /^[A-Za-z0-9_]+$/.test(part)));
}

function waitForConnect(connection, signal, lost) {
  if (connection.state === "connected") return Promise.resolve();
  return Promise.race([
    new Promise((resolve, reject) => {
      const clean = () => {
        connection.removeListener("connect", connected);
        connection.removeListener("error", errored);
        connection.removeListener("close", closed);
        signal.removeEventListener("abort", aborted);
      };
      const connected = () => { clean(); resolve(); };
      const errored = () => { clean(); reject(failure("PORTAL_UNAVAILABLE", PORTAL_UNAVAILABLE)); };
      const closed = () => { clean(); reject(failure("PORTAL_UNAVAILABLE", PORTAL_UNAVAILABLE)); };
      const aborted = () => { clean(); reject(signal.reason); };
      connection.once("connect", connected);
      connection.once("error", errored);
      connection.once("close", closed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    }),
    lost,
  ]);
}

function sanitizeAcquisitionError(error, signal, timedOut) {
  if (timedOut || error?.code === "PORTAL_TIMEOUT") return failure("PORTAL_TIMEOUT", PORTAL_TIMEOUT);
  if (signal?.aborted) return failure("PORTAL_CANCELLED", PORTAL_CANCELLED);
  if (error?.code === "PORTAL_OWNER_CHANGED") return failure("PORTAL_OWNER_CHANGED", PORTAL_OWNER_CHANGED);
  if (error?.code === "PORTAL_CONNECTION_CLOSED") return failure("PORTAL_CONNECTION_CLOSED", CONNECTION_CLOSED);
  if (error?.code === "PORTAL_REJECTED") return error;
  if (error?.code === "PORTAL_DESKTOP_ENTRY_FAILED") return failure("PORTAL_DESKTOP_ENTRY_FAILED", PORTAL_DESKTOP_ENTRY_FAILED);
  if (error?.code === "PORTAL_APP_REGISTRATION_FAILED") return failure("PORTAL_APP_REGISTRATION_FAILED", PORTAL_APP_REGISTRATION_FAILED);
  return failure("PORTAL_UNAVAILABLE", PORTAL_UNAVAILABLE);
}

export async function acquirePortalInhibitor({
  dbus,
  reason,
  signal: callerSignal,
  timeoutMs = READY_TIMEOUT_MS,
  makeToken = () => `codex_keep_awake_${randomBytes(16).toString("hex")}`,
  platform = process.platform,
  environment = process.env,
} = {}) {
  if (!dbus || typeof dbus.sessionBus !== "function" || typeof reason !== "string" || !reason) {
    throw failure("PORTAL_UNAVAILABLE", PORTAL_UNAVAILABLE);
  }
  if (callerSignal?.aborted) throw failure("PORTAL_CANCELLED", PORTAL_CANCELLED);

  const deadline = Date.now() + timeoutMs;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const timedOut = () => timeoutController.signal.aborted;
  let bus;
  let connection;
  let portalOwner = null;
  let requestPath = null;
  let released = false;
  let releasePromise = null;
  let connectionFailed = false;
  let ownerChanged = false;
  let rejectLost;
  let responseResolve;
  let responseReject;
  const earlyResponses = new Map();
  const lost = new Promise((_, reject) => { rejectLost = reject; });
  // A bus may disappear before the next operation races this promise.
  lost.catch(() => {});
  const response = new Promise((resolve, reject) => {
    responseResolve = resolve;
    responseReject = reject;
  });
  response.catch(() => {});

  const loseConnection = () => {
    if (connectionFailed || released) return;
    connectionFailed = true;
    rejectLost(failure("PORTAL_CONNECTION_CLOSED", CONNECTION_CLOSED));
  };
  const onMessage = (message) => {
    if (message?.type !== (dbus.messageType?.signal ?? 4)) return;
    if (message.sender === "org.freedesktop.DBus"
      && message.interface === DBUS_INTERFACE
      && message.member === "NameOwnerChanged"
      && Array.isArray(message.body)
      && message.body[0] === PORTAL_NAME
      && portalOwner
      && message.body[1] === portalOwner
      && message.body[2] !== portalOwner) {
      ownerChanged = true;
      rejectLost(failure("PORTAL_OWNER_CHANGED", PORTAL_OWNER_CHANGED));
      responseReject(failure("PORTAL_OWNER_CHANGED", PORTAL_OWNER_CHANGED));
      return;
    }
    if (message.interface !== REQUEST_INTERFACE
      || message.member !== "Response"
      || message.signature !== "ua{sv}"
      || message.sender !== portalOwner
      || !Array.isArray(message.body)
      || !Number.isInteger(message.body[0])) return;

    const code = message.body[0];
    if (requestPath && message.path === requestPath) {
      responseResolve(code);
      return;
    }
    earlyResponses.set(message.path, code);
    while (earlyResponses.size > 32) earlyResponses.delete(earlyResponses.keys().next().value);
  };

  try {
    bus = dbus.sessionBus({ direct: true, timeout: Math.max(1, remainingMs(deadline)) });
    connection = bus.connection;
    if (!connection || typeof connection.on !== "function") throw new Error("No session bus connection");
    connection.on("error", loseConnection);
    connection.once("close", loseConnection);
    connection.once("end", loseConnection);
    connection.on("message", onMessage);

    await Promise.race([waitForConnect(connection, signal, lost), aborted]);
    const uniqueName = await Promise.race([
      bus.invokeDbus({ member: "Hello" }, { signal, timeout: remainingMs(deadline) }),
      lost,
      aborted,
    ]);
    if (typeof uniqueName !== "string" || !uniqueName.startsWith(":")) {
      throw new Error("The session bus did not assign a unique name");
    }
    bus.name = uniqueName;

    const ownerMatch = `type='signal',sender='${DBUS_INTERFACE}',interface='${DBUS_INTERFACE}',member='NameOwnerChanged',arg0='${PORTAL_NAME}'`;
    const responseMatch = `type='signal',interface='${REQUEST_INTERFACE}',member='Response'`;
    for (const rule of [ownerMatch, responseMatch]) {
      await Promise.race([
        bus.invokeDbus({ member: "AddMatch", signature: "s", body: [rule] }, {
          signal,
          timeout: remainingMs(deadline),
        }),
        lost,
        aborted,
      ]);
    }

    const getOwner = () => bus.invokeDbus({
      member: "GetNameOwner", signature: "s", body: [PORTAL_NAME],
    }, { signal, timeout: remainingMs(deadline) });
    try {
      portalOwner = await Promise.race([getOwner(), lost, aborted]);
    } catch (error) {
      if (error?.dbusName !== "org.freedesktop.DBus.Error.NameHasNoOwner") throw error;
      await Promise.race([
        bus.invokeDbus({
          member: "StartServiceByName", signature: "su", body: [PORTAL_NAME, 0],
        }, { signal, timeout: remainingMs(deadline) }),
        lost,
        aborted,
      ]);
      portalOwner = await Promise.race([getOwner(), lost, aborted]);
    }
    if (typeof portalOwner !== "string" || !portalOwner.startsWith(":")) {
      throw new Error("The XDG Desktop Portal has no unique owner");
    }

    const appId = getPortalAppId({ platform, environment });
    if (appId) {
      let registryVersion = 0;
      try {
        const value = await Promise.race([
          bus.invoke({
            destination: PORTAL_NAME,
            path: PORTAL_PATH,
            interface: DBUS_PROPERTIES_INTERFACE,
            member: "Get",
            signature: "ss",
            body: [REGISTRY_INTERFACE, "version"],
          }, { signal, timeout: remainingMs(deadline) }),
          lost,
          aborted,
        ]);
        const unwrapped = typeof dbus.variantValue === "function" ? dbus.variantValue(value) : value?.value ?? value;
        if (Number.isInteger(unwrapped) && unwrapped > 0) registryVersion = unwrapped;
      } catch (error) {
        if (signal.aborted || timedOut()
          || ["PORTAL_OWNER_CHANGED", "PORTAL_CONNECTION_CLOSED", "PORTAL_TIMEOUT"].includes(error?.code)) {
          throw error;
        }
        // Registry is optional. A missing interface/property or another
        // Registry lookup failure preserves the existing Inhibit path.
      }

      if (registryVersion >= 1) {
        ensurePortalDesktopEntry({ appId, environment });
        try {
          await Promise.race([
            bus.invoke({
              destination: PORTAL_NAME,
              path: PORTAL_PATH,
              interface: REGISTRY_INTERFACE,
              member: "Register",
              signature: "sa{sv}",
              body: [appId, {}],
            }, { signal, timeout: remainingMs(deadline) }),
            lost,
            aborted,
          ]);
        } catch (error) {
          if (signal.aborted || timedOut()
            || ["PORTAL_OWNER_CHANGED", "PORTAL_CONNECTION_CLOSED", "PORTAL_TIMEOUT"].includes(error?.code)) {
            throw error;
          }
          throw failure("PORTAL_APP_REGISTRATION_FAILED", PORTAL_APP_REGISTRATION_FAILED);
        }
      }
    }

    const token = makeToken();
    if (typeof token !== "string" || !/^[A-Za-z0-9_]+$/.test(token)) {
      throw new Error("Invalid portal request token");
    }
    const senderElement = uniqueName.slice(1).replaceAll(".", "_");
    const expectedPath = `${PORTAL_PATH}/request/${senderElement}/${token}`;
    const variant = (signature, value) => new dbus.Variant(signature, value);
    const returnedPath = await Promise.race([
      bus.invoke({
        destination: PORTAL_NAME,
        path: PORTAL_PATH,
        interface: "org.freedesktop.portal.Inhibit",
        member: "Inhibit",
        signature: "sua{sv}",
        body: ["", 4, {
          handle_token: variant("s", token),
          reason: variant("s", reason),
        }],
      }, { signal, timeout: remainingMs(deadline) }),
      lost,
      aborted,
    ]);
    if (!requestPathIsValid(dbus, returnedPath)) throw new Error("Invalid portal request handle");
    requestPath = returnedPath;
    const responseCode = earlyResponses.has(requestPath)
      ? earlyResponses.get(requestPath)
      : await Promise.race([response, lost, aborted]);
    if (responseCode !== 0) throw failure("PORTAL_REJECTED", PORTAL_REJECTED);
    if (signal.aborted) throw signal.reason;

    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    return {
      requestPath,
      expectedPath,
      portalOwner,
      lost,
      release: () => {
        if (releasePromise) return releasePromise;
        released = true;
        clearTimeout(timeout);
        connection.removeListener("message", onMessage);
        connection.removeListener("error", loseConnection);
        connection.removeListener("close", loseConnection);
        connection.removeListener("end", loseConnection);
        signal.removeEventListener("abort", onAbort);
        releasePromise = (async () => {
          if (!connectionFailed && !ownerChanged) {
            try {
              await bus.invoke({
                destination: PORTAL_NAME,
                path: requestPath,
                interface: REQUEST_INTERFACE,
                member: "Close",
                signature: "",
                body: [],
              }, { timeout: CLOSE_TIMEOUT_MS });
            } catch {
              // Closing the owning connection below still releases the request.
            }
          }
          try {
            await closeBus(bus, connection);
          } catch {
            connection?.stream?.destroy();
          }
        })();
        return releasePromise;
      },
    };
  } catch (error) {
    clearTimeout(timeout);
    const sanitized = sanitizeAcquisitionError(error, callerSignal, timedOut());
    responseReject(sanitized);
    if (requestPath && bus && connection && !connectionFailed && !ownerChanged) {
      try {
        await bus.invoke({
          destination: PORTAL_NAME,
          path: requestPath,
          interface: REQUEST_INTERFACE,
          member: "Close",
          signature: "",
          body: [],
        }, { timeout: CLOSE_TIMEOUT_MS });
      } catch {}
    }
    await closeBus(bus, connection);
    throw sanitized;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

async function closeBus(bus, connection) {
  if (typeof bus?.close !== "function") return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => bus.close()),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          connection?.stream?.destroy();
          resolve();
        }, CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    connection?.stream?.destroy();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
