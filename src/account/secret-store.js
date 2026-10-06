"use strict";

// Protects the sov.gg refresh token (the long-lived part of the login) with the operating system's
// own per-user secret store, so ~/.sof/account.json is not a readable bearer secret by itself:
//
//   Windows  DPAPI, bound to your Windows user; the encrypted blob lives in account.json
//   macOS    Keychain (generic password "sof-account"); account.json only names it
//   Linux    libsecret through `secret-tool`; account.json only names it
//
// What this stops: the file being read by a stray `cat`/grep or an AI agent, copied to another
// machine or user, or swept up by a backup or sync. What it cannot stop: a program running as you
// that deliberately asks the OS to decrypt. Add-on isolation is the sandbox's job (src/addons).
//
// The secret is only ever passed to the OS tool on stdin, never as a command-line argument (those
// show up in process listings). SOF_ACCOUNT_PROTECTION=off turns this off (containers, CI).

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const SERVICE = "sof-account";
const ENTROPY = "sof-account-v1";
const TIMEOUT_MS = 20 * 1000;
// What a refresh token may contain for the Keychain path, which has to build a command line for
// `security -i`. Anything else is not sent to a shell-like tool at all.
const SAFE_SECRET = /^[A-Za-z0-9._~+/=-]+$/;

function enabled() {
  return (process.env.SOF_ACCOUNT_PROTECTION || "").trim().toLowerCase() !== "off";
}

// run(command, args, input) -> { status, stdout, error }. Tests replace it.
function defaultRun(command, args, input) {
  const result = childProcess.spawnSync(command, args, {
    input,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout || "", error: result.error || null };
}

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir;
  if (root) {
    const full = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (fs.existsSync(full)) {
      return full;
    }
  }
  return "powershell.exe";
}

function powershell(script, input, run) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], input);
}

const DPAPI_PROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$secret = [Console]::In.ReadToEnd()
$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$blob = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($secret), $entropy, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($blob))
`;

const DPAPI_UNPROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$blob = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`;

function ok(result) {
  return result && !result.error && result.status === 0;
}

const backends = {
  win32: {
    name: "dpapi",
    protect(secret, _account, run) {
      const result = powershell(DPAPI_PROTECT, secret, run);
      const data = ok(result) ? result.stdout.trim() : "";
      return data ? { backend: "dpapi", data } : null;
    },
    unprotect(protection, run) {
      const result = powershell(DPAPI_UNPROTECT, protection.data, run);
      return ok(result) && result.stdout ? result.stdout : null;
    },
    forget() {},
  },

  darwin: {
    name: "keychain",
    protect(secret, account, run) {
      if (!SAFE_SECRET.test(secret) || !SAFE_SECRET.test(account.replace(/[:@]/g, "-"))) {
        return null;
      }
      // `security -i` reads its commands from stdin, which keeps the secret off the command line.
      const command = `add-generic-password -U -s ${SERVICE} -a "${account}" -w "${secret}"\n`;
      return ok(run("security", ["-i"], command)) ? { backend: "keychain", account } : null;
    },
    unprotect(protection, run) {
      const result = run("security", ["find-generic-password", "-s", SERVICE, "-a", protection.account, "-w"], "");
      return ok(result) && result.stdout.trim() ? result.stdout.replace(/\r?\n$/, "") : null;
    },
    forget(protection, run) {
      run("security", ["delete-generic-password", "-s", SERVICE, "-a", protection.account], "");
    },
  },

  linux: {
    name: "libsecret",
    protect(secret, account, run) {
      const stored = run("secret-tool", ["store", "--label=sof sov.gg sign-in", "service", SERVICE, "account", account], secret);
      return ok(stored) ? { backend: "libsecret", account } : null;
    },
    unprotect(protection, run) {
      const result = run("secret-tool", ["lookup", "service", SERVICE, "account", protection.account], "");
      return ok(result) && result.stdout ? result.stdout : null;
    },
    forget(protection, run) {
      run("secret-tool", ["clear", "service", SERVICE, "account", protection.account], "");
    },
  },
};

function currentBackend(platform = process.platform) {
  return backends[platform] || null;
}

// -> { backend, data? | account? } to keep in account.json, or null when there is no usable store
// (the caller then keeps the token in the owner-only file as before).
function protect(secret, { account, platform, run = defaultRun } = {}) {
  const backend = enabled() ? currentBackend(platform) : null;
  if (!backend || !secret) {
    return null;
  }
  try {
    return backend.protect(secret, String(account || "default"), run);
  } catch (_err) {
    return null;
  }
}

// -> the secret, or null when it cannot be recovered (other user, other machine, store missing).
function unprotect(protection, { platform, run = defaultRun } = {}) {
  const backend = protection && currentBackend(platform);
  if (!backend || backend.name !== protection.backend) {
    return null;
  }
  try {
    return backend.unprotect(protection, run);
  } catch (_err) {
    return null;
  }
}

// Removes the stored secret where one lives outside account.json (Keychain, libsecret).
function forget(protection, { platform, run = defaultRun } = {}) {
  const backend = protection && currentBackend(platform);
  if (backend && backend.name === protection.backend) {
    try {
      backend.forget(protection, run);
    } catch (_err) {
      // Nothing more to do; the file that named it is being removed anyway.
    }
  }
}

module.exports = { enabled, forget, protect, unprotect };
