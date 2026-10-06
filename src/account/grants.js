"use strict";

// Which add-ons may use the sov.gg login, and for which hosts. Only sof core writes this file
// (~/.sof/account-grants.json); a sandboxed add-on cannot read or write ~/.sof.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { sofHome } = require("../addons/store");
const { ceilingHosts } = require("./hosts");

function grantsFile() {
  return path.join(sofHome(), "account-grants.json");
}

function readGrants() {
  try {
    const parsed = JSON.parse(fs.readFileSync(grantsFile(), "utf8"));
    return parsed && typeof parsed.grants === "object" && parsed.grants ? parsed.grants : {};
  } catch (_err) {
    return {};
  }
}

function writeGrants(grants) {
  fs.mkdirSync(sofHome(), { recursive: true });
  const temporary = `${grantsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ grants }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, grantsFile());
}

function normalizeHosts(hosts) {
  return [...new Set((hosts || []).map((host) => String(host).trim().toLowerCase()).filter(Boolean))].sort();
}

// The hosts an add-on's manifest asks for ("account": { "hosts": [...] }); throws on a host core would never allow.
function requestedHosts(descriptor) {
  const account = descriptor.account;
  if (!account) {
    return [];
  }
  const hosts = normalizeHosts(account.hosts);
  const ceiling = ceilingHosts();
  const outside = hosts.filter((host) => !ceiling.has(host));
  if (outside.length > 0) {
    throw new Error(
      `Add-on "${descriptor.name}" asks to use your sov.gg login for ${outside.join(", ")}, which sof does not allow ` +
        `(allowed: ${[...ceiling].join(", ")}).`
    );
  }
  return hosts;
}

function grantedHosts(addonName) {
  const entry = readGrants()[addonName];
  return entry ? normalizeHosts(entry.hosts) : [];
}

function coversHosts(addonName, hosts) {
  const granted = new Set(grantedHosts(addonName));
  return hosts.every((host) => granted.has(host));
}

function grant(addonName, hosts) {
  const grants = readGrants();
  grants[addonName] = { hosts: normalizeHosts(hosts), granted_at: new Date().toISOString() };
  writeGrants(grants);
}

function revoke(addonName) {
  const grants = readGrants();
  if (!(addonName in grants)) {
    return false;
  }
  delete grants[addonName];
  writeGrants(grants);
  return true;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// Returns the hosts the add-on may use, or throws. Asks once on a terminal; elsewhere the grant must
// already exist (sof run account grant <addon>).
async function ensureGranted(descriptor, { prompt = ask, interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY) } = {}) {
  const hosts = requestedHosts(descriptor);
  if (hosts.length === 0 || coversHosts(descriptor.name, hosts)) {
    return hosts;
  }
  const question = `Add-on "${descriptor.name}" wants to use your sov.gg login for ${hosts.join(", ")}.\nIt never sees the login itself, only the results. Allow? [y/N] `;
  if (!interactive) {
    throw Object.assign(
      new Error(
        `Add-on "${descriptor.name}" needs permission to use your sov.gg login for ${hosts.join(", ")}. ` +
          `Ask the user to run this in their own terminal: sof run account grant ${descriptor.name}`
      ),
      { code: "not_granted" }
    );
  }
  if (!(await prompt(question))) {
    throw Object.assign(new Error(`Add-on "${descriptor.name}" was not given access to your sov.gg login.`), { code: "not_granted" });
  }
  grant(descriptor.name, hosts);
  return hosts;
}

module.exports = { coversHosts, ensureGranted, grant, grantedHosts, grantsFile, readGrants, requestedHosts, revoke };
