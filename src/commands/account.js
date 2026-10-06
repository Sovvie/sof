"use strict";

// sof run account: your sov.gg (Authentik) sign-in. Separate from `sof run package login`, which is
// the GitHub sign-in used to publish packages. Add-ons never see this login; they use it through
// src/account/broker.js (see src/addons/run-sandboxed.js).

const { SOF_REGISTRY_URL } = require("../packages/constants");
const { accountFile, clearAccount, getAccessToken, readAccount } = require("../account/store");
const { accountLogin } = require("../account/login");
const { grant, readGrants, requestedHosts, revoke } = require("../account/grants");
const { readErrorMessage, registryFetch } = require("../packages/providers/sof");
const { readAddonDescriptor, readManifest, sofHome } = require("../addons/store");
const aiGuard = require("../account/ai-guard");

const HELP_TEXT = `
sof run account - Your sov.gg sign-in

USAGE:
  sof run account login
  sof run account logout
  sof run account whoami [--json]
  sof run account grants [--json]
  sof run account grant <addon>
  sof run account revoke <addon>
  sof run account guard [--status] [--off] [--on] [--quiet]

COMMANDS:
  login    Sign in with the company SSO (Authentik) in your browser: SSO and MFA included, nothing
           to copy or paste. Needed for private add-ons and for add-ons that use your account.
           Set SOF_NO_BROWSER=1 to print the address instead of opening a browser.
  logout   Forget the sign-in (removes ${accountFile()}).
  whoami   Show who you are signed in as.
  grants   List which add-ons may use your account, and for which hosts.
  grant    Let an add-on use your account for the hosts its sof-addon.json asks for.
  revoke   Take that permission away again.
  guard    Stop AI coding tools (Claude Code, Cursor CLI) from reading or editing ${sofHome()}, where
           your sign-ins live, by adding deny rules to their user settings. Runs by itself on install,
           update and login. --status shows it, --off removes the rules and stops sof adding them
           (also: SOF_AI_GUARD=off), --on turns it back on. It blocks the tools' file access, not shell
           commands an agent is allowed to run.

Add-ons never receive your login: they run in a sandbox and ask sof to make the request for them,
only to hosts you granted. This is separate from "sof run package login" (the GitHub sign-in).
`;

function identity(me) {
  return `${me.username}${me.email ? ` <${me.email}>` : ""}`;
}

function groupList(me) {
  return Array.isArray(me.groups) && me.groups.length > 0 ? me.groups.join(", ") : "none listed";
}

// GET /v1/staff/whoami -> { username, email, staff, groups? }; null when not signed in.
// Any 200 is a valid sign-in: staff is true for staff, false for someone in a group that a private
// package was opened to.
async function fetchWhoami(registryUrl = SOF_REGISTRY_URL) {
  if (!(await getAccessToken(registryUrl))) {
    return null;
  }
  // registryFetch attaches the sign-in to this read by itself.
  const response = await registryFetch(registryUrl, "/v1/staff/whoami", { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`whoami failed (${response.status}): ${await readErrorMessage(response)}`);
  }
  return response.json();
}

function describeAccount(me) {
  return me.staff
    ? `Signed in as staff: ${identity(me)} (private add-ons available)`
    : `Signed in as ${identity(me)}, not staff; private add-ons open to your groups (${groupList(me)}) are available`;
}

async function runLogin(argv) {
  if (argv.length > 0) {
    throw new Error("account login takes no arguments.");
  }
  await accountLogin(SOF_REGISTRY_URL, { log: (line) => console.log(line) });
  const me = await fetchWhoami();
  console.log(`${describeAccount(me)}.`);
  if (me.staff) {
    console.log('Private add-ons are available now: see "sof run addon list".');
  }
  runGuard(["--quiet"]);
}

// Adds (or removes, or reports) the deny rules in AI tools' settings. --quiet prints only changes.
function runGuard(argv) {
  const known = new Set(["--status", "--off", "--on", "--quiet"]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    throw new Error(`account guard: unknown option ${unknown[0]}.`);
  }
  const quiet = argv.includes("--quiet");
  const show = (results) => {
    const lines = aiGuard.describe(quiet ? results.filter((r) => r.status !== "already" && r.status !== "absent") : results);
    for (const line of lines) {
      console.log(line);
    }
    return lines.length;
  };

  if (argv.includes("--off")) {
    aiGuard.setEnabled(false);
    show(aiGuard.removeGuard());
    console.log("AI tool protection is off; sof will not add the rules again. Turn it on with: sof run account guard --on");
    return;
  }
  if (argv.includes("--on")) {
    aiGuard.setEnabled(true);
  }
  if (argv.includes("--status")) {
    console.log(aiGuard.enabled() ? "AI tool protection is on." : "AI tool protection is off.");
    show(aiGuard.statusGuard());
    return;
  }

  const results = aiGuard.applyGuard();
  if (results === null) {
    if (!quiet) {
      console.log("AI tool protection is off (sof run account guard --on turns it on).");
    }
    return;
  }
  if (show(results) === 0 && !quiet) {
    console.log("No supported AI tool found to protect (Claude Code and Cursor CLI are covered).");
  }
}

function runLogout(argv) {
  if (argv.length > 0) {
    throw new Error("account logout takes no arguments.");
  }
  const had = Boolean(readAccount());
  clearAccount();
  console.log(had ? "Signed out of sov.gg." : "Not signed in.");
}

// --json is for scripts and AI agents: one JSON object, and exit code 1 when not signed in.
async function runWhoami(argv) {
  const json = argv.includes("--json");
  if (argv.filter((arg) => arg !== "--json").length > 0) {
    throw new Error("account whoami takes only --json.");
  }
  const me = await fetchWhoami();
  if (!me) {
    if (json) {
      console.log(JSON.stringify({ signedIn: false }));
      process.exitCode = 1;
      return;
    }
    throw new Error('Not signed in to sov.gg. Run "sof run account login".');
  }
  if (json) {
    console.log(
      JSON.stringify({
        signedIn: true,
        username: String(me.username || ""),
        email: me.email ? String(me.email) : "",
        staff: me.staff === true,
        groups: Array.isArray(me.groups) ? me.groups.map(String) : [],
      })
    );
    return;
  }
  console.log(describeAccount(me));
}

function runGrants(argv) {
  const json = argv.includes("--json");
  if (argv.filter((arg) => arg !== "--json").length > 0) {
    throw new Error("account grants takes only --json.");
  }
  const grants = readGrants();
  const names = Object.keys(grants).sort();
  if (json) {
    console.log(JSON.stringify(Object.fromEntries(names.map((name) => [name, grants[name].hosts || []]))));
    return;
  }
  if (names.length === 0) {
    console.log("No add-on may use your sov.gg account.");
    return;
  }
  for (const name of names) {
    console.log(`  ${name}: ${(grants[name].hosts || []).join(", ")}`);
  }
}

function runGrant(argv) {
  const name = argv[0];
  if (!name || argv.length > 1) {
    throw new Error("account grant needs one add-on name.");
  }
  // Letting an add-on use your account is a decision for you, not for a script or an AI agent.
  if (!(process.stdin.isTTY && process.stderr.isTTY)) {
    throw new Error(
      `Giving "${name}" access to your sov.gg account has to be done by you, in your own terminal: sof run account grant ${name}`
    );
  }
  const installed = readManifest().addons[name];
  if (!installed) {
    throw new Error(`Add-on "${name}" isn't installed.`);
  }
  const descriptor = readAddonDescriptor(installed.directory);
  const hosts = requestedHosts(descriptor);
  if (hosts.length === 0) {
    throw new Error(`Add-on "${name}" does not ask to use your sov.gg account.`);
  }
  grant(name, hosts);
  console.log(`${name} may now use your sov.gg account for ${hosts.join(", ")}.`);
}

function runRevoke(argv) {
  const name = argv[0];
  if (!name || argv.length > 1) {
    throw new Error("account revoke needs one add-on name.");
  }
  console.log(revoke(name) ? `${name} can no longer use your sov.gg account.` : `${name} had no access.`);
}

async function runAccount(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || rest.includes("--help")) {
    console.log(HELP_TEXT);
    return;
  }
  switch (command) {
    case "login":
      return runLogin(rest);
    case "logout":
      return runLogout(rest);
    case "whoami":
      return runWhoami(rest);
    case "grants":
      return runGrants(rest);
    case "grant":
      return runGrant(rest);
    case "revoke":
      return runRevoke(rest);
    case "guard":
      return runGuard(rest);
    default:
      throw new Error(`Unknown account command: ${command}. Run "sof run account --help".`);
  }
}

module.exports = { describeAccount, fetchWhoami, runAccount };
