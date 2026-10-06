"use strict";

// Entry point of a sandboxed add-on's child process (started by run-sandboxed.js with Node's
// permission model on: no access to ~/.sof, no child processes, no workers, files only under the
// project folder and the add-on's own folder). It has no login and cannot read one; the account
// API below forwards each call to sof core, which holds the login and applies the host allowlist.

let nextId = 1;
const pending = new Map();

function call(op, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    process.send({ type: "call", id, op, args });
  });
}

process.on("message", (message) => {
  if (!message || message.type !== "reply") {
    return;
  }
  const waiting = pending.get(message.id);
  if (!waiting) {
    return;
  }
  pending.delete(message.id);
  if (message.ok) {
    waiting.resolve(message.result);
  } else {
    const error = new Error(message.error.message);
    error.code = message.error.code;
    waiting.reject(error);
  }
});

const host = {
  sandboxed: true,
  account: {
    request: (options) => call("account.request", options),
    whoami: () => call("account.whoami"),
  },
};

async function start({ entry, exportName, argv }) {
  try {
    const mod = require(entry);
    const run = mod[exportName];
    if (typeof run !== "function") {
      throw new Error(`The add-on doesn't export a "${exportName}" function.`);
    }
    await run(argv, host);
  } catch (err) {
    console.error(`Error: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
}

process.once("message", (message) => {
  if (message && message.type === "run") {
    start(message);
  }
});
process.send({ type: "ready" });
