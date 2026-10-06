"use strict";

// sof run self update: installs the latest GitHub release of sof into ~/.sof/cli and
// repoints the ~/.sof/bin shim, the same layout the install.ps1 / install.sh scripts create.

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const semver = require("semver");
const AdmZip = require("adm-zip");

const { sofHome } = require("../addons/store");
const { SOF_CLI_REPO } = require("../packages/constants");

const HELP_TEXT = `
sof run self - Manage the sof install

USAGE:
  sof run self update      Install the latest release (from github.com/${SOF_CLI_REPO})
  sof run self where       Show where sof is installed
`;

async function latestRelease() {
  const response = await fetch(`https://api.github.com/repos/${SOF_CLI_REPO}/releases/latest`, {
    headers: { "User-Agent": "sof-cli", Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`Couldn't read the latest sof release (${response.status}).`);
  }

  const release = await response.json();
  const asset = (release.assets || []).find((candidate) => /^sof-.*\.zip$/.test(candidate.name));
  if (!asset) {
    throw new Error(`Release ${release.tag_name} has no sof-<version>.zip asset.`);
  }

  return { version: String(release.tag_name).replace(/^v/, ""), url: asset.browser_download_url };
}

function writeShims(cliDirectory) {
  const binDirectory = path.join(sofHome(), "bin");
  fs.mkdirSync(binDirectory, { recursive: true });

  const entry = path.join(cliDirectory, "bin", "sof.js");
  fs.writeFileSync(path.join(binDirectory, "sof.cmd"), `@echo off\r\nnode "${entry}" %*\r\n`);
  // PowerShell prefers sof.ps1 over sof.cmd, so leaving it pointing at the old version made
  // every update look like it hadn't happened.
  fs.writeFileSync(path.join(binDirectory, "sof.ps1"), `node "${entry}" @args\r\n`);
  fs.writeFileSync(path.join(binDirectory, "sof"), `#!/bin/sh\nexec node "${entry}" "$@"\n`, { mode: 0o755 });
}

// The new version adds the deny rules that keep AI coding tools out of ~/.sof (see
// src/account/ai-guard.js). It runs as a separate process so the new code does it, not the old.
// A problem here never fails the update.
function protectFromAiTools(cliDirectory) {
  try {
    childProcess.spawnSync(process.execPath, [path.join(cliDirectory, "bin", "sof.js"), "run", "account", "guard", "--quiet"], {
      stdio: "inherit",
      timeout: 30000,
    });
  } catch (_err) {
    // Run it later with: sof run account guard
  }
}

async function update() {
  const current = require("../../package.json").version;
  const release = await latestRelease();

  if (semver.valid(release.version) && !semver.gt(release.version, current)) {
    console.log(`sof ${current} is up to date.`);
    return;
  }

  console.log(`Updating sof ${current} -> ${release.version}...`);
  const response = await fetch(release.url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}).`);
  }

  const cliDirectory = path.join(sofHome(), "cli", release.version);
  fs.rmSync(cliDirectory, { recursive: true, force: true });
  fs.mkdirSync(cliDirectory, { recursive: true });
  new AdmZip(Buffer.from(await response.arrayBuffer())).extractAllTo(cliDirectory, true);

  const result = childProcess.spawnSync("npm ci --omit=dev --no-audit --no-fund --loglevel=error", {
    cwd: cliDirectory,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error("npm ci failed; the previous version is still installed.");
  }

  writeShims(cliDirectory);
  protectFromAiTools(cliDirectory);
  console.log(`✓ sof ${release.version} installed. Open a new terminal if the old version still runs.`);
}

async function runSelf(argv) {
  const [command] = argv;

  if (command === "update") {
    await update();
  } else if (command === "where") {
    console.log(`sof ${require("../../package.json").version} at ${path.resolve(__dirname, "..", "..")}`);
    console.log(`home: ${sofHome()} (${os.platform()})`);
  } else {
    console.log(HELP_TEXT);
  }
}

module.exports = { runSelf };
