"use strict";

// sof run package login | logout | whoami | owner | yank | unyank

const { SOF_REGISTRY_URL } = require("../packages/constants");
const {
  authFilePath,
  clearAuth,
  deviceLogin,
  requireToken,
  saveAuth,
} = require("../packages/auth");
const { readErrorMessage, registryFetch } = require("../packages/providers/sof");

const ACCOUNT_HELP_TEXT = `  login
    sof run package login
    Sign in with GitHub (device code); needed to publish. Token is saved in ~/.sof/auth.json.

  logout
    sof run package logout
    Forget the saved sign-in.

  whoami
    sof run package whoami
    Show the signed-in GitHub user, the scopes they own and what a first publish would claim.

  owner
    sof run package owner add|remove <scope> <github-user>
    Add or remove an owner of a scope you own.

  yank / unyank
    sof run package yank <scope/name> <version>
    sof run package unyank <scope/name> <version>
    A yanked version stays downloadable (existing sof.lock files keep working) but new
    installs never pick it.

  CI: set SOF_REGISTRY_TOKEN instead of logging in. It wins over the saved sign-in.`;

const COMMAND_HELP = {
  login: `
sof run package login - Sign in to the package registry with GitHub

USAGE:
  sof run package login

DESCRIPTION:
  Shows a code to enter at github.com/login/device and waits for you to approve it. No password
  ever touches sof. The token is saved in ~/.sof/auth.json (override the folder with SOF_HOME).
  Publishing scope is your lowercased GitHub username; your first publish claims it.
`,
  logout: `
sof run package logout - Forget the saved registry sign-in

USAGE:
  sof run package logout
`,
  whoami: `
sof run package whoami - Show who the registry thinks you are

USAGE:
  sof run package whoami

DESCRIPTION:
  Uses SOF_REGISTRY_TOKEN when set, otherwise the sign-in saved by "sof run package login".
`,
  owner: `
sof run package owner - Manage who may publish to a scope

USAGE:
  sof run package owner add <scope> <github-user>
  sof run package owner remove <scope> <github-user>
`,
  yank: `
sof run package yank - Stop new installs from picking a version

USAGE:
  sof run package yank <scope/name> <version>
  sof run package unyank <scope/name> <version>

DESCRIPTION:
  A yanked version stays downloadable, so projects whose sof.lock pins it keep working, but
  fresh resolution never chooses it. Versions can't be re-published or deleted.
`,
};
COMMAND_HELP.unyank = COMMAND_HELP.yank;

const ACCOUNT_COMMANDS = ["login", "logout", "whoami", "owner", "yank", "unyank"];

function isHelp(argv) {
  return argv.includes("-h") || argv.includes("--help");
}

async function registryJson(method, urlPath, found, label, registryUrl) {
  const response = await registryFetch(registryUrl, urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${found.token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    let hint = "";
    if (response.status === 401) {
      hint =
        found.source === "SOF_REGISTRY_TOKEN"
          ? "\nThe registry rejected SOF_REGISTRY_TOKEN."
          : '\nSign in again with "sof run package login".';
    }
    throw new Error(`${label} failed (${response.status}): ${message}${hint}`);
  }

  return response.json();
}

// GET /v1/whoami -> { login, id, trusted, scopes, canClaim }
async function fetchWhoami(found, registryUrl = SOF_REGISTRY_URL) {
  return registryJson("GET", "/v1/whoami", found, "whoami", registryUrl);
}

function describeAccount(who) {
  const lines = [`Signed in as ${who.login}`];
  const scopes = Array.isArray(who.scopes) ? who.scopes : [];
  lines.push(`Scopes you own: ${scopes.length > 0 ? scopes.join(", ") : "(none yet)"}`);
  if (who.canClaim) {
    lines.push(`Your first publish claims the scope "${who.canClaim}".`);
  }
  if (typeof who.trusted === "boolean") {
    lines.push(`Trusted: ${who.trusted ? "yes" : "no"}`);
  }
  return lines;
}

async function runLogin(argv) {
  if (isHelp(argv)) {
    console.log(COMMAND_HELP.login);
    return;
  }
  if (argv.length > 0) {
    throw new Error("package login takes no arguments.");
  }

  const token = await deviceLogin({
    registryUrl: SOF_REGISTRY_URL,
    onCode: ({ url, code }) => {
      console.log(`Open ${url} and enter the code: ${code}`);
      console.log("Waiting for you to approve it on GitHub...");
    },
  });

  // Ask the registry who the token belongs to before saving, so a token it would reject is
  // never kept. (The saved-token lookup is bypassed on purpose: SOF_REGISTRY_TOKEN may be set.)
  const who = await fetchWhoami({ token, source: "login" });
  saveAuth({ token, login: who.login });

  for (const line of describeAccount(who)) {
    console.log(line);
  }
  if ((process.env.SOF_REGISTRY_TOKEN || "").trim()) {
    console.log("Note: SOF_REGISTRY_TOKEN is set and takes priority over this saved sign-in.");
  }
}

async function runLogout(argv) {
  if (isHelp(argv)) {
    console.log(COMMAND_HELP.logout);
    return;
  }
  if (argv.length > 0) {
    throw new Error("package logout takes no arguments.");
  }

  console.log(clearAuth() ? `Signed out (removed ${authFilePath()}).` : "Not signed in.");
  if ((process.env.SOF_REGISTRY_TOKEN || "").trim()) {
    console.log("SOF_REGISTRY_TOKEN is still set in this environment.");
  }
}

async function runWhoami(argv) {
  if (isHelp(argv)) {
    console.log(COMMAND_HELP.whoami);
    return;
  }
  if (argv.length > 0) {
    throw new Error("package whoami takes no arguments.");
  }

  const found = requireToken();
  const who = await fetchWhoami(found);
  for (const line of describeAccount(who)) {
    console.log(line);
  }
  console.log(`Token from: ${found.source}`);
}

async function runOwner(argv) {
  if (isHelp(argv)) {
    console.log(COMMAND_HELP.owner);
    return;
  }

  const [action, scopeArg, userArg, ...extra] = argv;
  if ((action !== "add" && action !== "remove") || !scopeArg || !userArg || extra.length > 0) {
    throw new Error("Usage: sof run package owner add|remove <scope> <github-user>");
  }

  const scope = scopeArg.trim().toLowerCase();
  const user = userArg.trim().replace(/^@/, "");
  const found = requireToken();
  const reply = await registryJson(
    action === "add" ? "PUT" : "DELETE",
    `/v1/scopes/${encodeURIComponent(scope)}/owners/${encodeURIComponent(user)}`,
    found,
    `owner ${action}`,
    SOF_REGISTRY_URL
  );

  const owners = Array.isArray(reply.owners) ? reply.owners.map((owner) => owner.login) : [];
  console.log(`Owners of ${reply.scope || scope}: ${owners.length > 0 ? owners.join(", ") : "(none)"}`);
}

async function runYank(argv, action) {
  if (isHelp(argv)) {
    console.log(COMMAND_HELP[action]);
    return;
  }

  const [packageName, version, ...extra] = argv;
  const parts = (packageName || "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !version || extra.length > 0) {
    throw new Error(`Usage: sof run package ${action} <scope/name> <version>`);
  }

  const found = requireToken();
  const reply = await registryJson(
    "POST",
    `/v1/packages/${encodeURIComponent(parts[0].toLowerCase())}/${encodeURIComponent(parts[1].toLowerCase())}/${encodeURIComponent(version)}/${action}`,
    found,
    action,
    SOF_REGISTRY_URL
  );

  console.log(`${reply.package || packageName}@${reply.version || version}: ${reply.state || action}`);
}

async function runAccountCommand(command, argv) {
  switch (command) {
    case "login":
      return runLogin(argv);
    case "logout":
      return runLogout(argv);
    case "whoami":
      return runWhoami(argv);
    case "owner":
      return runOwner(argv);
    case "yank":
    case "unyank":
      return runYank(argv, command);
    default:
      throw new Error(`Unknown package command: ${command}`);
  }
}

module.exports = {
  ACCOUNT_COMMANDS,
  ACCOUNT_HELP_TEXT,
  fetchWhoami,
  runAccountCommand,
};
