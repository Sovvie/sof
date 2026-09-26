"use strict";

const { EventEmitter } = require("events");
const { WebSocket, WebSocketServer } = require("ws");

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SEND_TIMEOUT_MS = 30_000;

function parsePort(value) {
  const port = Number.parseInt(String(value ?? DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parseTimeout(value, fallback) {
  if (value == null) {
    return fallback;
  }

  const timeout = Number.parseInt(String(value), 10);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`Invalid timeout: ${value}`);
  }
  return timeout;
}

function normalizeMessage(rawData) {
  if (typeof rawData === "string") {
    return rawData;
  }

  if (Buffer.isBuffer(rawData)) {
    return rawData.toString("utf8");
  }

  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString("utf8");
  }

  return String(rawData);
}

function createServer(options = {}) {
  const port = parsePort(options.port);
  const host = String(options.host || DEFAULT_HOST).trim() || DEFAULT_HOST;
  const defaultTimeout = parseTimeout(options.defaultTimeout, DEFAULT_SEND_TIMEOUT_MS);

  const events = new EventEmitter();
  const pendingById = new Map();
  const waitingForConnection = new Set();

  let nextId = 1;
  let activeSocket = null;
  let isClosing = false;

  function isConnected() {
    return Boolean(activeSocket && activeSocket.readyState === WebSocket.OPEN);
  }

  function rejectAllPending(error) {
    for (const pending of pendingById.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
    }
    pendingById.clear();
  }

  function rejectAllWaiters(error) {
    for (const waiter of waitingForConnection.values()) {
      clearTimeout(waiter.timeoutHandle);
      waiter.reject(error);
    }
    waitingForConnection.clear();
  }

  function notifyConnected() {
    for (const waiter of waitingForConnection.values()) {
      clearTimeout(waiter.timeoutHandle);
      waiter.resolve();
    }
    waitingForConnection.clear();
  }

  function handlePluginMessage(rawData) {
    const payloadText = normalizeMessage(rawData);

    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch (error) {
      events.emit("error", new Error(`Failed to parse plugin JSON message: ${error.message}`));
      return;
    }

    if (!payload || typeof payload !== "object") {
      events.emit("error", new Error("Plugin message must be a JSON object."));
      return;
    }

    const id = payload.id != null ? String(payload.id) : "";
    if (!id) {
      events.emit("error", new Error("Plugin message missing request id."));
      return;
    }

    const pending = pendingById.get(id);
    if (!pending) {
      return;
    }

    pendingById.delete(id);
    clearTimeout(pending.timeoutHandle);

    if (payload.ok) {
      pending.resolve(payload.result);
      return;
    }

    const message = payload.error || payload.message || "Remote script execution failed.";
    pending.reject(new Error(String(message)));
  }

  function bindSocket(socket) {
    socket.on("message", handlePluginMessage);

    socket.on("error", (error) => {
      events.emit("error", error);
    });

    socket.on("close", () => {
      if (activeSocket !== socket) {
        return;
      }

      activeSocket = null;
      rejectAllPending(new Error("Roblox plugin disconnected before responding."));
      events.emit("disconnected");
    });
  }

  const webSocketServer = new WebSocketServer({
    host,
    port,
    perMessageDeflate: false,
  });

  webSocketServer.on("connection", (socket) => {
    if (isClosing) {
      socket.close(1001, "Server is closing.");
      return;
    }

    if (activeSocket && activeSocket !== socket) {
      // Only one plugin should be active at a time.
      rejectAllPending(new Error("Roblox plugin reconnected. Pending requests were cancelled."));
      try {
        activeSocket.close(1000, "Replaced by new connection.");
      } catch (_error) {
        // Ignore close errors from a stale socket.
      }
    }

    activeSocket = socket;
    bindSocket(socket);
    notifyConnected();
    events.emit("connected");
  });

  webSocketServer.on("error", (error) => {
    events.emit("error", error);
  });

  function waitForConnection(options = {}) {
    if (isConnected()) {
      return Promise.resolve();
    }

    if (isClosing) {
      return Promise.reject(new Error("Remote exec server is closed."));
    }

    const timeoutMs = parseTimeout(options.timeout, 0) || 0;

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeoutHandle: null,
      };

      if (timeoutMs > 0) {
        waiter.timeoutHandle = setTimeout(() => {
          waitingForConnection.delete(waiter);
          reject(new Error(`Timed out waiting for Roblox plugin connection after ${timeoutMs}ms.`));
        }, timeoutMs);
      }

      waitingForConnection.add(waiter);
    });
  }

  function send(script, options = {}) {
    if (isClosing) {
      return Promise.reject(new Error("Remote exec server is closed."));
    }

    if (typeof script !== "string" || script.length === 0) {
      return Promise.reject(new Error("send(script) requires a non-empty string."));
    }

    if (!isConnected()) {
      return Promise.reject(
        new Error("No Roblox plugin is connected. Start the plugin and call waitForConnection().")
      );
    }

    return sendRequest(
      {
        script,
      },
      options
    );
  }

  function sendRequest(payload, options = {}) {
    if (isClosing) {
      return Promise.reject(new Error("Remote exec server is closed."));
    }

    if (!isConnected()) {
      return Promise.reject(
        new Error("No Roblox plugin is connected. Start the plugin and call waitForConnection().")
      );
    }

    const timeoutMs = parseTimeout(options.timeout, defaultTimeout);
    const requestId = String(nextId);
    nextId += 1;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        pendingById.delete(requestId);
        reject(new Error(`Timed out waiting for script result after ${timeoutMs}ms.`));
      }, timeoutMs);

      pendingById.set(requestId, {
        resolve,
        reject,
        timeoutHandle,
      });

      const message = JSON.stringify({
        id: requestId,
        ...payload,
      });

      try {
        activeSocket.send(message);
      } catch (error) {
        pendingById.delete(requestId);
        clearTimeout(timeoutHandle);
        reject(error);
      }
    });
  }

  function createAsset(script, options = {}) {
    if (typeof script !== "string" || script.length === 0) {
      return Promise.reject(new Error("createAsset(script, options) requires a non-empty script."));
    }

    const assetType = String(options.assetType || "").trim();
    if (!assetType) {
      return Promise.reject(new Error("createAsset requires options.assetType (Model, Plugin, Mesh, Image)."));
    }

    let requestParameters = undefined;
    if (options.requestParameters != null) {
      if (typeof options.requestParameters !== "object" || Array.isArray(options.requestParameters)) {
        return Promise.reject(new Error("options.requestParameters must be an object when provided."));
      }
      requestParameters = options.requestParameters;
    }

    return sendRequest(
      {
        action: "createAsset",
        script,
        assetType,
        requestParameters,
      },
      options
    );
  }

  function on(eventName, listener) {
    events.on(eventName, listener);
    return () => events.off(eventName, listener);
  }

  function close() {
    if (isClosing) {
      return Promise.resolve();
    }

    isClosing = true;
    rejectAllWaiters(new Error("Remote exec server is closing."));
    rejectAllPending(new Error("Remote exec server is closing."));

    if (activeSocket) {
      try {
        activeSocket.close(1001, "Server closed.");
      } catch (_error) {
        // Ignore socket close race conditions.
      }
      activeSocket = null;
    }

    return new Promise((resolve) => {
      webSocketServer.close(() => {
        events.removeAllListeners();
        resolve();
      });
    });
  }

  return new Promise((resolve, reject) => {
    const handleListening = () => {
      webSocketServer.off("error", handleBootstrapError);
      resolve({
        send,
        createAsset,
        on,
        close,
        waitForConnection,
        get connected() {
          return isConnected();
        },
        get port() {
          return port;
        },
        get host() {
          return host;
        },
      });
    };

    const handleBootstrapError = (error) => {
      webSocketServer.off("listening", handleListening);
      reject(error);
    };

    webSocketServer.once("listening", handleListening);
    webSocketServer.once("error", handleBootstrapError);
  });
}

module.exports = {
  createServer,
  DEFAULT_PORT,
  DEFAULT_SEND_TIMEOUT_MS,
};
