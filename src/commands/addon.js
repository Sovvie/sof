"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const semver = require("semver");
const tar = require("tar");

const { requireToken } = require("../packages/auth");
const { readAccount } = require("../account/store");
const { createRegistry } = require("../packages/registry");
const { heldForReviewLines } = require("../packages/providers/sof");
const { isYanked } = require("../packages/resolver");
const { failWithProblems, validateArchive, validatePackageMetadata } = require("../packages/validate");
const { inspectAddon, checkEntryLoads } = require("../addons/descriptor");
const { readRequires } = require("../addons/requires");
const { scaffoldAddon } = require("../addons/scaffold");
const { requestedHosts } = require("../account/grants");
const {
  ADDON_SCOPE,
  addonsRoot,
  readManifest,
  writeManifest,
  readAddonDescriptor,
} = require("../addons/store");

const HELP_TEXT = `
sof run addon - Optional sof features, installed on demand

USAGE:
  sof run addon <command> [arguments]

COMMANDS:
  list                     Installed add-ons, and the ones available to install
  search <query>           Search the registry's add-ons
  info <name>              What an add-on does and what it is allowed to do (before or after installing it)
  outdated                 Installed add-ons that have a newer version
  add <name>[@range]       Install an add-on (e.g. sof run addon add docs); add-ons it requires come with it
  add --path <folder>      Install an add-on from a local folder (for developing one)
  remove <name> [--force]  Uninstall an add-on (refused while another installed add-on requires it)
  update [name]            Update one add-on, or all of them
  new <name> [--dir <d>]   Scaffold a new add-on (a sandboxed one; --no-sandbox for one that starts programs)
  test [folder]            Check an add-on folder (sof-addon.json, entry, requires) and run its tests
  publish <folder>         Publish an add-on folder to the sof registry (needs "sof run package login")

Installed add-ons run like built-in commands: sof run <command> ...
They live in ~/.sof/addons (override with SOF_HOME).

Add-ons that declare "sandbox": true run without access to your sign-in, to files outside the
project, or to other programs. Set SOF_REQUIRE_SANDBOX=1 to refuse to run any other add-on.
`;

function installNodeDependencies(directory) {
  const packageJsonPath = path.join(directory, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (!packageJson.dependencies || Object.keys(packageJson.dependencies).length === 0) {
    return;
  }

  console.log(`  installing ${Object.keys(packageJson.dependencies).length} npm dependencies...`);
  const result = childProcess.spawnSync("npm install --omit=dev --no-audit --no-fund --loglevel=error", {
    cwd: directory,
    stdio: "inherit",
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`npm install failed in ${directory}.`);
  }
}

function record(descriptor, directory, source) {
  const manifest = readManifest();
  manifest.addons[descriptor.name] = {
    name: descriptor.name,
    version: descriptor.version,
    command: descriptor.command,
    entry: descriptor.entry,
    export: descriptor.export || "run",
    description: descriptor.description || "",
    usage: descriptor.usage || "",
    directory,
    source,
  };
  writeManifest(manifest);
}

function removeOtherVersions(name, keepDirectory) {
  const root = path.join(addonsRoot(), name);
  if (!fs.existsSync(root)) {
    return;
  }

  for (const entry of fs.readdirSync(root)) {
    const directory = path.join(root, entry);
    if (path.resolve(directory) !== path.resolve(keepDirectory)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

function splitSpec(spec) {
  const at = spec.lastIndexOf("@");
  return { name: at > 0 ? spec.slice(0, at) : spec, range: at > 0 ? spec.slice(at + 1) : "*" };
}

// The registry's newest non-yanked version of an add-on that fits `range`, downloaded and checked.
async function fetchFromRegistry(name, range) {
  const registry = createRegistry();
  const packageName = `${ADDON_SCOPE}/${name}`;
  const entry = await registry.queryPackage(packageName, { preferredSource: "sof", allowFallback: false });
  if (!entry) {
    const hint = readAccount()
      ? ""
      : ' If it is a private company add-on, sign in first with "sof run account login".';
    throw new Error(`No add-on named "${name}". Run "sof run addon list" to see what's available.${hint}`);
  }

  // Yanked versions are never picked for a fresh install.
  const version = semver.maxSatisfying(
    entry.versions.filter((candidate) => !isYanked(candidate)).map((candidate) => candidate.version),
    range,
    { includePrerelease: true }
  );
  if (!version) {
    throw new Error(`No version of add-on "${name}" matches "${range}".`);
  }

  const metadata = entry.versions.find((candidate) => candidate.version === version).metadata || {};
  const download = await registry.downloadPackage("sof", packageName, version);

  if (metadata.checksum) {
    const actual = `sha256:${crypto.createHash("sha256").update(download.buffer).digest("hex")}`;
    if (actual !== metadata.checksum) {
      throw new Error(`Checksum mismatch for add-on ${name}@${version}.`);
    }
  }

  return { name, version, metadata, buffer: download.buffer, versions: entry.versions };
}

async function extractTo(buffer, directory, label) {
  fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(os.tmpdir(), `sof-addon-${label}-${process.pid}.tar.gz`);
  fs.writeFileSync(archive, buffer);
  try {
    await tar.x({ file: archive, cwd: directory });
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

// What an add-on is allowed to do, in plain lines.
function permissionLines(descriptor) {
  const lines = [];
  if (descriptor.sandbox === true) {
    lines.push("sandboxed: no access to your sign-in, to files outside the project, or to other programs");
    if (descriptor.account) {
      try {
        lines.push(`may ask to use your sov.gg account for: ${requestedHosts(descriptor).join(", ") || "(no hosts)"} (you are asked first)`);
      } catch (err) {
        lines.push(`asks to use your sov.gg account in a way sof refuses: ${err.message}`);
      }
    }
  } else {
    lines.push(
      descriptor.sandbox === false
        ? "NOT sandboxed: runs with all your permissions (files, programs, network)"
        : "NOT sandboxed (it doesn't say): runs with all your permissions (files, programs, network)"
    );
  }
  if (Array.isArray(descriptor.env) && descriptor.env.length > 0) {
    lines.push(`reads environment variables: ${descriptor.env.join(", ")}`);
  }
  try {
    const needs = readRequires(descriptor);
    if (needs.sof) lines.push(`needs sof ${needs.sof}`);
    for (const [name, range] of Object.entries(needs.addons)) lines.push(`needs the add-on ${name} ${range} (installed with it)`);
    if (needs.tools.length > 0) lines.push(`needs these tools in [tools]: ${needs.tools.join(", ")}`);
  } catch (err) {
    lines.push(`has an invalid "requires": ${err.message}`);
  }
  return lines;
}

// Installs, from the registry, the add-ons `descriptor` requires that are missing or too old.
// `seen` stops two add-ons that require each other from going round forever.
async function installRequired(descriptor, seen) {
  const needs = readRequires(descriptor);
  for (const [name, range] of Object.entries(needs.addons)) {
    const installed = readManifest().addons[name];
    if (installed && semver.satisfies(installed.version, range, { includePrerelease: true })) {
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    console.log(`  ${descriptor.name} needs ${name} ${range}: installing it too`);
    await addFromIndex(`${name}@${range}`, seen);
  }
  if (needs.tools.length > 0) {
    console.log(`  note: ${descriptor.name} needs these in [tools] of the project you use it in: ${needs.tools.join(", ")}`);
  }
}

async function addFromIndex(spec, seen = new Set()) {
  const { name, range } = splitSpec(spec);
  seen.add(name);

  const fetched = await fetchFromRegistry(name, range);
  const directory = path.join(addonsRoot(), name, fetched.version);
  fs.rmSync(directory, { recursive: true, force: true });
  await extractTo(fetched.buffer, directory, `${name}-${fetched.version}`);

  const descriptor = readAddonDescriptor(directory);
  installNodeDependencies(directory);
  record(descriptor, directory, "sof");
  removeOtherVersions(name, directory);

  console.log(`✓ ${descriptor.name}@${descriptor.version}: sof run ${descriptor.command}`);
  for (const line of permissionLines(descriptor)) {
    console.log(`    ${line}`);
  }
  await installRequired(descriptor, seen);
}

async function addFromPath(folder) {
  const directory = path.resolve(folder);
  const descriptor = readAddonDescriptor(directory);
  installNodeDependencies(directory);
  record(descriptor, directory, "path");
  console.log(`✓ ${descriptor.name}@${descriptor.version} (local ${directory}): sof run ${descriptor.command}`);
  for (const line of permissionLines(descriptor)) {
    console.log(`    ${line}`);
  }
  await installRequired(descriptor, new Set([descriptor.name]));
}

async function fetchAvailable() {
  try {
    const packages = await createRegistry().searchPackages({ scope: ADDON_SCOPE });
    return packages.map((entry) => String(entry.name).split("/").pop()).sort();
  } catch (_err) {
    return null;
  }
}

async function list() {
  const manifest = readManifest();
  const installed = Object.values(manifest.addons);

  console.log("Installed:");
  if (installed.length === 0) {
    console.log("  (none)");
  }
  for (const addon of installed.sort((a, b) => a.name.localeCompare(b.name))) {
    const origin = addon.source === "path" ? ` (local ${addon.directory})` : "";
    console.log(`  ${addon.name}@${addon.version}  sof run ${addon.command}${origin}`);
  }

  const available = await fetchAvailable();
  if (available === null) {
    console.log("\nCouldn't reach the sof registry to list available add-ons.");
    return;
  }

  const notInstalled = available.filter((name) => !manifest.addons[name]);
  console.log("\nAvailable:");
  console.log(notInstalled.length === 0 ? "  (all installed)" : notInstalled.map((name) => `  ${name}`).join("\n"));
}

function remove(name, { force = false } = {}) {
  const manifest = readManifest();
  const addon = manifest.addons[name];
  if (!addon) {
    throw new Error(`Add-on "${name}" isn't installed.`);
  }

  const dependents = Object.values(manifest.addons).filter((other) => {
    if (other.name === name) {
      return false;
    }
    try {
      return Object.prototype.hasOwnProperty.call(readRequires(readAddonDescriptor(other.directory)).addons, name);
    } catch (_err) {
      return false;
    }
  });
  if (dependents.length > 0 && !force) {
    throw new Error(
      `${dependents.map((other) => other.name).join(", ")} require${dependents.length === 1 ? "s" : ""} ${name}. Remove ${dependents.length === 1 ? "it" : "them"} first, or use --force.`
    );
  }

  if (addon.source !== "path") {
    fs.rmSync(path.join(addonsRoot(), name), { recursive: true, force: true });
  }

  delete manifest.addons[name];
  writeManifest(manifest);
  console.log(`✓ removed ${name}`);
}

async function update(name) {
  const manifest = readManifest();
  const names = name ? [name] : Object.keys(manifest.addons);

  for (const addonName of names) {
    const addon = manifest.addons[addonName];
    if (!addon) {
      throw new Error(`Add-on "${addonName}" isn't installed.`);
    }

    if (addon.source === "path") {
      await addFromPath(addon.directory);
    } else {
      await addFromIndex(addonName);
    }
  }
}

async function search(query) {
  const found = await createRegistry().searchPackages({ query, scope: ADDON_SCOPE });
  if (found.length === 0) {
    console.log(query ? `No add-ons match "${query}".` : "No add-ons found.");
    return;
  }
  const installed = readManifest().addons;
  const rows = found.map((entry) => ({ name: String(entry.name).split("/").pop(), latest: entry.latest || "-", description: entry.description || "" }));
  const width = Math.max(...rows.map((row) => row.name.length));
  for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    const mark = installed[row.name] ? ` [installed ${installed[row.name].version}]` : "";
    console.log(`  ${row.name.padEnd(width)}  ${String(row.latest).padEnd(8)}  ${row.description}${mark}`);
  }
}

async function info(name) {
  const manifest = readManifest();
  const installed = manifest.addons[name];
  let descriptor = null;
  let latest = null;
  let size = null;

  try {
    const fetched = await fetchFromRegistry(name, "*");
    latest = fetched.version;
    size = fetched.buffer.length;
    if (!installed || installed.version !== fetched.version) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sof-addon-info-"));
      try {
        await extractTo(fetched.buffer, temporary, `info-${name}`);
        descriptor = readAddonDescriptor(temporary);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
  } catch (err) {
    if (!installed) {
      throw err;
    }
    console.log(`(couldn't check the registry: ${err.message})`);
  }

  if (!descriptor && installed) {
    descriptor = readAddonDescriptor(installed.directory);
  }

  console.log(`${descriptor.name}  ${descriptor.description || ""}`.trimEnd());
  console.log(`  command:    sof run ${descriptor.command}${descriptor.usage ? `   (${descriptor.usage})` : ""}`);
  console.log(`  installed:  ${installed ? `${installed.version}${installed.source === "path" ? ` (local ${installed.directory})` : ""}` : "no"}`);
  if (latest) {
    console.log(`  latest:     ${latest}${size ? ` (${(size / 1024).toFixed(0)} KB download)` : ""}`);
  }
  console.log("  it can:");
  for (const line of permissionLines(descriptor)) {
    console.log(`    - ${line}`);
  }
  if (!installed) {
    console.log(`\nInstall it with: sof run addon add ${name}`);
  }
}

async function outdated() {
  const installed = Object.values(readManifest().addons).filter((addon) => addon.source !== "path");
  if (installed.length === 0) {
    console.log("No add-ons installed from the registry.");
    return;
  }

  let behind = 0;
  for (const addon of installed.sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const entry = await createRegistry().queryPackage(`${ADDON_SCOPE}/${addon.name}`, { preferredSource: "sof", allowFallback: false });
      const newest = semver.maxSatisfying(
        (entry ? entry.versions : []).filter((candidate) => !isYanked(candidate)).map((candidate) => candidate.version),
        "*",
        { includePrerelease: true }
      );
      if (newest && semver.gt(newest, addon.version)) {
        behind += 1;
        console.log(`  ${addon.name}  ${addon.version} -> ${newest}`);
      }
    } catch (err) {
      console.log(`  ${addon.name}  couldn't check: ${err.message}`);
    }
  }
  console.log(behind === 0 ? "All add-ons are up to date." : `\n${behind} add-on(s) can be updated: sof run addon update`);
}

function newAddon(rest) {
  const names = [];
  let directory = null;
  let sandbox = true;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--dir") {
      directory = rest[(index += 1)];
      if (!directory) throw new Error("--dir needs a folder.");
    } else if (rest[index] === "--no-sandbox") {
      sandbox = false;
    } else if (rest[index].startsWith("-")) {
      throw new Error(`Unknown option: ${rest[index]}`);
    } else {
      names.push(rest[index]);
    }
  }
  if (names.length !== 1) {
    throw new Error("new needs exactly one add-on name, e.g. sof run addon new hello");
  }

  const created = scaffoldAddon({ name: names[0], directory: path.resolve(directory || names[0]), sandbox });
  console.log(`✓ created ${path.relative(process.cwd(), created.directory) || "."}`);
  for (const file of created.files) {
    console.log(`    ${file}`);
  }
  console.log(`\nNext: sof run addon add --path ${path.relative(process.cwd(), created.directory) || "."}   then: sof run ${names[0]} --help`);
  console.log(`      sof run addon test ${path.relative(process.cwd(), created.directory) || "."}`);
}

async function testAddon(folder) {
  const directory = path.resolve(folder || ".");
  const result = inspectAddon(directory);
  const problems = [...result.problems];

  if (result.descriptor && problems.length === 0) {
    const loadProblem = checkEntryLoads(directory, result.descriptor);
    if (loadProblem) problems.push(loadProblem);
  }

  for (const warning of result.warnings) console.log(`  ! ${warning}`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);

  let testCode = 0;
  const packageJsonPath = path.join(directory, "package.json");
  if (problems.length === 0 && fs.existsSync(packageJsonPath)) {
    const script = (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).scripts || {}).test;
    if (script && !/no test specified/.test(script)) {
      console.log("  running the add-on's tests (npm test)...");
      testCode =
        childProcess.spawnSync("npm test", {
          cwd: directory,
          stdio: "inherit",
          shell: true,
          env: { ...process.env, SOF_ADDON_KIT: require.resolve("../addons/kit") },
        }).status || 0;
    } else {
      console.log('  · no "test" script in package.json');
    }
  }

  if (problems.length === 0 && testCode === 0) {
    console.log(`✓ ${result.descriptor.name}@${result.descriptor.version} looks good${result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : ""}`);
  } else {
    process.exitCode = 1;
    console.log(problems.length > 0 ? `✗ ${problems.length} problem(s)` : "✗ the add-on's tests failed");
  }
}

async function publish(folder) {
  const directory = path.resolve(folder);
  const descriptor = readAddonDescriptor(directory);
  const inspected = inspectAddon(directory);
  if (inspected.problems.length > 0) {
    throw new Error(`Not publishing ${descriptor.name}:\n${inspected.problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
  for (const warning of inspected.warnings) {
    console.log(`  ! ${warning}`);
  }
  requireToken();
  const packageJsonPath = path.join(directory, "package.json");
  const packageJson = fs.existsSync(packageJsonPath) ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) : {};

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sof-addon-publish-"));
  const archive = path.join(temporary, `${descriptor.name}-${descriptor.version}.tar.gz`);

  try {
    const entries = fs.readdirSync(directory).filter((entry) => entry !== "node_modules" && entry !== ".git");
    await tar.c({ file: archive, gzip: true, cwd: directory, portable: true }, entries);

    const checksum = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex")}`;
    const registry = createRegistry();

    const packageEntry = {
      name: `${ADDON_SCOPE}/${descriptor.name}`,
      version: descriptor.version,
      description: descriptor.description || packageJson.description || "",
      license: packageJson.license || "",
      realm: "addon",
      authors: Array.isArray(packageJson.authors) ? packageJson.authors : [],
      dependencies: [],
    };

    const problems = [
      ...validatePackageMetadata(packageEntry),
      ...(await validateArchive(archive, packageEntry)),
    ];
    if (problems.length > 0) {
      throw failWithProblems(`${packageEntry.name}@${packageEntry.version}`, problems);
    }

    const result = await registry.publishPackage(packageEntry, archive, checksum);
    if (result.state === "quarantined") {
      const [headline, ...details] = heldForReviewLines(result);
      console.log(`! add-on ${headline}`);
      for (const line of details) {
        console.log(`  ${line}`);
      }
      return;
    }

    console.log(`✓ published add-on ${descriptor.name}@${result.version} (${result.indexPath})`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function runAddon(argv) {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help" || rest.includes("--help")) {
    console.log(HELP_TEXT);
    return;
  }

  if (command === "list") {
    await list();
  } else if (command === "add") {
    const pathIndex = rest.indexOf("--path");
    if (pathIndex >= 0) {
      if (!rest[pathIndex + 1]) {
        throw new Error("add --path needs a folder.");
      }
      await addFromPath(rest[pathIndex + 1]);
    } else if (rest.length === 0) {
      throw new Error("add needs an add-on name, e.g. sof run addon add docs");
    } else {
      for (const spec of rest) {
        await addFromIndex(spec);
      }
    }
  } else if (command === "remove") {
    const names = rest.filter((entry) => entry !== "--force");
    if (!names[0]) {
      throw new Error("remove needs an add-on name.");
    }
    remove(names[0], { force: rest.includes("--force") });
  } else if (command === "update") {
    await update(rest[0]);
  } else if (command === "search") {
    await search(rest.join(" "));
  } else if (command === "info") {
    if (!rest[0]) {
      throw new Error("info needs an add-on name.");
    }
    await info(rest[0]);
  } else if (command === "outdated") {
    await outdated();
  } else if (command === "new") {
    newAddon(rest);
  } else if (command === "test") {
    await testAddon(rest[0]);
  } else if (command === "publish") {
    if (!rest[0]) {
      throw new Error("publish needs the add-on folder.");
    }
    await publish(rest[0]);
  } else {
    console.error(`Unknown addon command: ${command}`);
    console.log(HELP_TEXT);
    process.exit(1);
  }
}

module.exports = { addFromIndex, installNodeDependencies, runAddon };
