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
  add <name>[@range]       Install an add-on (e.g. sof run addon add docs)
  add --path <folder>      Install an add-on from a local folder (for developing one)
  remove <name>            Uninstall an add-on
  update [name]            Update one add-on, or all of them
  publish <folder>         Publish an add-on folder to the sof registry (needs "sof run package login")

Installed add-ons run like built-in commands: sof run <command> ...
They live in ~/.sof/addons (override with SOF_HOME).
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

async function addFromIndex(spec) {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : "*";

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

  const directory = path.join(addonsRoot(), name, version);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });

  const archive = path.join(os.tmpdir(), `sof-addon-${name}-${version}-${process.pid}.tar.gz`);
  fs.writeFileSync(archive, download.buffer);
  try {
    await tar.x({ file: archive, cwd: directory });
  } finally {
    fs.rmSync(archive, { force: true });
  }

  const descriptor = readAddonDescriptor(directory);
  installNodeDependencies(directory);
  record(descriptor, directory, "sof");
  removeOtherVersions(name, directory);

  console.log(`✓ ${descriptor.name}@${descriptor.version}: sof run ${descriptor.command}`);
}

function addFromPath(folder) {
  const directory = path.resolve(folder);
  const descriptor = readAddonDescriptor(directory);
  installNodeDependencies(directory);
  record(descriptor, directory, "path");
  console.log(`✓ ${descriptor.name}@${descriptor.version} (local ${directory}): sof run ${descriptor.command}`);
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

function remove(name) {
  const manifest = readManifest();
  const addon = manifest.addons[name];
  if (!addon) {
    throw new Error(`Add-on "${name}" isn't installed.`);
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
      addFromPath(addon.directory);
    } else {
      await addFromIndex(addonName);
    }
  }
}

async function publish(folder) {
  const directory = path.resolve(folder);
  const descriptor = readAddonDescriptor(directory);
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
      addFromPath(rest[pathIndex + 1]);
    } else if (rest.length === 0) {
      throw new Error("add needs an add-on name, e.g. sof run addon add docs");
    } else {
      for (const spec of rest) {
        await addFromIndex(spec);
      }
    }
  } else if (command === "remove") {
    if (!rest[0]) {
      throw new Error("remove needs an add-on name.");
    }
    remove(rest[0]);
  } else if (command === "update") {
    await update(rest[0]);
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

module.exports = { runAddon };
