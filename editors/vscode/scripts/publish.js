"use strict";

// Builds the extension once and publishes that same .vsix to the registries.
//
//   npm run publish-stores -- --dry-run          build, and report which tokens are missing
//   npm run publish-stores                       publish to both
//   npm run publish-stores -- --only=vscode      only the VS Code Marketplace
//   npm run publish-stores -- --only=openvsx     only Open VSX (what Cursor installs from)
//   npm run publish-stores -- --create-namespace first time only: create the "sovvie" namespace on Open VSX
//
// Tokens come from the environment, never from arguments (arguments show up in process lists):
//   VSCE_PAT   Azure DevOps token with Marketplace > Manage, for publisher "sovvie"
//   OVSX_PAT   Open VSX access token

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const createNamespace = argv.includes("--create-namespace");
const onlyArg = argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length) : "both";

if (!["both", "vscode", "openvsx"].includes(only)) {
  console.error(`--only must be vscode or openvsx, not "${only}".`);
  process.exit(2);
}

const targets = [
  { id: "vscode", label: "VS Code Marketplace", token: "VSCE_PAT" },
  { id: "openvsx", label: "Open VSX (Cursor)", token: "OVSX_PAT" },
].filter((target) => only === "both" || only === target.id);

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });
  return result.status === 0;
}

const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);

console.log(`sof ${pkg.version} (${pkg.publisher}.${pkg.name})\n`);

const missing = targets.filter((target) => !process.env[target.token]);
for (const target of targets) {
  console.log(`  ${target.label}: ${process.env[target.token] ? `${target.token} is set` : `${target.token} is NOT set`}`);
}

// Package once; both registries get exactly this file.
console.log("\nBuilding the package...");
if (!run("npm", ["run", "package"])) {
  console.error("Packaging failed.");
  process.exit(1);
}
if (!fs.existsSync(vsix)) {
  console.error(`Expected ${vsix} after packaging.`);
  process.exit(1);
}

if (dryRun) {
  console.log(`\nDry run: built ${path.basename(vsix)}, nothing published.`);
  process.exit(missing.length > 0 ? 1 : 0);
}

if (missing.length > 0) {
  console.error(`\nNot publishing: set ${missing.map((target) => target.token).join(" and ")} first.`);
  process.exit(1);
}

let failed = false;
for (const target of targets) {
  console.log(`\nPublishing ${path.basename(vsix)} to ${target.label}...`);
  let ok;
  if (target.id === "vscode") {
    ok = run("npx", ["vsce", "publish", "--packagePath", vsix]);
  } else {
    if (createNamespace && !run("npx", ["ovsx", "create-namespace", pkg.publisher])) {
      console.error(`Could not create the namespace "${pkg.publisher}" (it may already exist).`);
    }
    ok = run("npx", ["ovsx", "publish", vsix]);
  }
  if (!ok) {
    failed = true;
    console.error(`${target.label}: publishing failed.`);
  }
}
process.exit(failed ? 1 : 0);
