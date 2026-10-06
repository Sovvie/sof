"use strict";

// Runs an add-on that opted in ("sandbox": true in sof-addon.json) in a child process under Node's
// permission model, so it cannot read the sov.gg login (~/.sof/account.json) or anything else
// outside the project folder and its own folder, cannot spawn processes, and gets no secrets from
// the environment. It uses the account through the broker (src/account/broker.js) over IPC.
//
// Add-ons without "sandbox": true still run inside sof's own process and are trusted like sof itself.

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { readAddonDescriptor, sofHome } = require("./store");
const { createBroker } = require("../account/broker");
const { ensureGranted, requestedHosts } = require("../account/grants");

const RUNNER = path.join(__dirname, "sandbox-runner.js");

// Environment a sandboxed add-on gets: terminal/locale basics, plus what its manifest lists in "env".
const BASE_ENV = ["SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TERM", "COLORTERM", "FORCE_COLOR", "NO_COLOR", "CI"];

// --permission exists from Node 22.13 / 23.5.
function supportsPermissionFlag(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
}

function real(target) {
  try {
    return fs.realpathSync(target);
  } catch (_err) {
    return path.resolve(target);
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Folders the add-on may read and write: the project (cwd), plus the folder of any path the user
// typed as an argument (for example another project's sof.toml). Never anything that is, contains
// or sits inside sof's own home, where the login lives.
function workFolders(argv, cwd) {
  const home = real(sofHome());
  const folders = new Set([real(cwd)]);
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.startsWith("-") || !fs.existsSync(arg)) {
      continue;
    }
    const resolved = real(arg);
    folders.add(fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved));
  }
  for (const folder of folders) {
    if (isInside(folder, home) || isInside(home, folder)) {
      if (folder === real(cwd)) {
        throw new Error(
          `Run sandboxed add-ons from a project folder: ${folder} contains or is inside sof's own folder (${home}), which holds your sign-in.`
        );
      }
      folders.delete(folder);
    }
  }
  return [...folders];
}

function sandboxEnv(descriptor) {
  const env = { SOF_ADDON_SANDBOX: "1" };
  for (const key of [...BASE_ENV, ...(Array.isArray(descriptor.env) ? descriptor.env : [])]) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

// fetchImpl lets tests stand in for the network behind the account broker.
async function runSandboxed(addon, argv, { cwd = process.cwd(), fetchImpl } = {}) {
  if (!supportsPermissionFlag()) {
    throw new Error(
      `Add-on "${addon.name}" runs in a sandbox, which needs Node 22.13 or newer (this is Node ${process.versions.node}).`
    );
  }

  const descriptor = readAddonDescriptor(addon.directory);
  if (descriptor.sandbox !== true) {
    throw new Error(`Add-on "${addon.name}" is not marked as sandboxed.`);
  }
  const entry = path.join(real(addon.directory), descriptor.entry);
  if (descriptor.account) {
    requestedHosts(descriptor); // refuses a manifest that asks for hosts core never allows, before anything runs
  }

  // The grant is checked (and asked for, on a terminal) the first time the add-on really uses the
  // account, so commands that never touch it keep working without one.
  let brokerPromise = null;
  const getBroker = () => {
    if (!descriptor.account) {
      throw Object.assign(new Error("This add-on did not ask to use the sov.gg account."), { code: "no_account" });
    }
    if (!brokerPromise) {
      brokerPromise = ensureGranted(descriptor).then((hosts) =>
        createBroker({ addon: descriptor.name, hosts, ...(fetchImpl ? { fetchImpl } : {}) })
      );
      brokerPromise.catch(() => {
        brokerPromise = null; // a refusal is not remembered: a later grant takes effect
      });
    }
    return brokerPromise;
  };

  const folders = workFolders(argv, cwd);
  const execArgv = [
    "--permission",
    `--allow-fs-read=${RUNNER}`,
    `--allow-fs-read=${real(addon.directory)}`,
    ...folders.flatMap((folder) => [`--allow-fs-read=${folder}`, `--allow-fs-write=${folder}`]),
  ];

  const child = childProcess.fork(RUNNER, [], {
    cwd,
    execArgv,
    env: sandboxEnv(descriptor),
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    serialization: "json",
  });

  const handlers = {
    "account.request": async (args) => (await getBroker()).request(args),
    "account.whoami": async () => (await getBroker()).whoami(),
  };

  child.on("message", async (message) => {
    if (!message) {
      return;
    }
    if (message.type === "ready") {
      child.send({ type: "run", entry, exportName: descriptor.export || "run", argv });
      return;
    }
    if (message.type !== "call" || !child.connected) {
      return;
    }
    const handler = handlers[message.op];
    try {
      if (!handler) {
        throw new Error(`Unknown account call "${message.op}".`);
      }
      const result = await handler(message.args);
      if (child.connected) {
        child.send({ type: "reply", id: message.id, ok: true, result });
      }
    } catch (err) {
      if (child.connected) {
        child.send({ type: "reply", id: message.id, ok: false, error: { message: err.message, code: err.code || "error" } });
      }
    }
  });

  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve(signal ? 1 : exitCode));
  });
  if (code) {
    process.exitCode = code;
  }
}

module.exports = { runSandboxed, supportsPermissionFlag, workFolders };
