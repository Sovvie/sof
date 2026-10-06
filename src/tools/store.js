"use strict";

// Where tools live on this machine, and installing one:
//   ~/.sof/tools/<owner>/<repo>/<version>/<repo>[.exe]     the tool itself, one folder per version
//   ~/.sof/bin/<alias>[.exe]                                a shim that runs the version a project pins
//   ~/.sof/tools.toml                                       tools every folder gets ("--global")

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sofHome } = require("../addons/store");
const { pickAsset } = require("./assets");
const { extractExecutable } = require("./extract");
const { downloadAsset, findRelease } = require("./github");
const { parseToolSpecifier } = require("./spec");

const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";

function toolsRoot() {
  return path.join(sofHome(), "tools");
}

function binDirectory() {
  return path.join(sofHome(), "bin");
}

function globalManifestPath() {
  return path.join(sofHome(), "tools.toml");
}

// Tools the same user already downloaded with Rokit are copied instead of downloaded again.
function rokitStorageRoot() {
  return path.join(process.env.ROKIT_ROOT ? path.resolve(process.env.ROKIT_ROOT) : path.join(os.homedir(), ".rokit"), "tool-storage");
}

function versionDirectory(spec) {
  return path.join(toolsRoot(), spec.owner.toLowerCase(), spec.repo.toLowerCase(), spec.version);
}

function toolExecutablePath(spec) {
  return path.join(versionDirectory(spec), `${spec.repo.toLowerCase()}${EXE_SUFFIX}`);
}

function isToolInstalled(spec) {
  return fs.existsSync(toolExecutablePath(spec));
}

function findRokitCopy(spec) {
  const directory = path.join(rokitStorageRoot(), spec.owner.toLowerCase(), spec.repo.toLowerCase(), spec.version);
  const candidate = path.join(directory, `${spec.repo.toLowerCase()}${EXE_SUFFIX}`);
  return fs.existsSync(candidate) ? candidate : null;
}

// Where an install notes which release asset it came from: { asset, sha256 }. Tools sof copied
// from Rokit have none.
function installRecordPath(spec) {
  return path.join(versionDirectory(spec), ".sof-install.json");
}

function readInstallRecord(spec) {
  try {
    const record = JSON.parse(fs.readFileSync(installRecordPath(spec), "utf8"));
    return typeof record.asset === "string" && typeof record.sha256 === "string" ? record : null;
  } catch (_err) {
    return null;
  }
}

// A running tool's .exe can't be deleted or overwritten, but it can be renamed. When one is
// replaced, the old file waits here under this name until nothing is running it.
const PARKED_PATTERN = /\.old-\d+-\d+$/;

function clearParkedFiles(directory) {
  try {
    for (const name of fs.readdirSync(directory)) {
      if (PARKED_PATTERN.test(name)) {
        try {
          fs.rmSync(path.join(directory, name), { force: true });
        } catch (_busy) {
          // Still running; a later install tries again.
        }
      }
    }
  } catch (_err) {
    // No folder yet.
  }
}

// Puts the executable (and its record) in the version's folder. Written to a scratch folder
// first, so a tool is either fully there or not there at all (an interrupted download leaves
// nothing behind).
function placeExecutable(spec, data, { record }) {
  const finalDirectory = versionDirectory(spec);
  const executablePath = toolExecutablePath(spec);
  const recordPath = installRecordPath(spec);
  const scratch = `${finalDirectory}.partial-${process.pid}-${Date.now()}`;
  fs.mkdirSync(scratch, { recursive: true });

  try {
    const staged = path.join(scratch, path.basename(executablePath));
    fs.writeFileSync(staged, data, { mode: 0o755 });
    if (process.platform !== "win32") {
      fs.chmodSync(staged, 0o755);
    }
    const stagedRecord = path.join(scratch, path.basename(recordPath));
    if (record) {
      fs.writeFileSync(stagedRecord, `${JSON.stringify(record)}\n`);
    }

    // The usual case: the whole folder appears at once.
    if (!fs.existsSync(finalDirectory)) {
      try {
        fs.renameSync(scratch, finalDirectory);
        return;
      } catch (err) {
        if (!fs.existsSync(finalDirectory)) {
          throw err;
        }
      }
    }

    // The folder is already there: a reinstall (--force, or a copy that has to be checked against a
    // lock), a folder whose executable was deleted, or another sof process that got there first.
    // The files are swapped one by one, and the old executable is renamed out of the way rather
    // than deleted, because it may be running right now.
    clearParkedFiles(finalDirectory);
    let parked = null;
    if (fs.existsSync(executablePath)) {
      parked = `${executablePath}.old-${process.pid}-${Date.now()}`;
      fs.renameSync(executablePath, parked);
    }

    try {
      fs.renameSync(staged, executablePath);
    } catch (err) {
      if (parked) {
        try {
          fs.renameSync(parked, executablePath);
        } catch (_restore) {
          // Nothing more to be done: the original error is the one to report.
        }
      }
      throw err;
    }

    if (record) {
      fs.renameSync(stagedRecord, recordPath);
    } else {
      fs.rmSync(recordPath, { force: true });
    }

    if (parked) {
      try {
        fs.rmSync(parked, { force: true });
      } catch (_busy) {
        // Still running: cleared by the next install of this version.
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Installs one tool and resolves to { spec, skipped, record }; skipped means that exact version
// was already there. expected is this tool's line from sof.tools.lock ({ asset, sha256 }): an
// install without a matching record is redone, and what is downloaded must match it.
async function installTool(specifier, { alias, force = false, expected = null, log = () => {} } = {}) {
  const spec = typeof specifier === "string" ? parseToolSpecifier(specifier) : specifier;
  const label = `${spec.owner}/${spec.repo}@${spec.version}`;

  const existing = isToolInstalled(spec) ? readInstallRecord(spec) || { unrecorded: true } : null;
  const verified = !expected || (existing && existing.sha256 === expected.sha256);
  if (!force && existing && verified) {
    return { spec, skipped: true, record: existing.unrecorded ? null : existing };
  }

  // Nothing to check a copy from Rokit against, so a locked tool is downloaded instead.
  const rokitCopy = force || expected ? null : findRokitCopy(spec);
  if (rokitCopy) {
    placeExecutable(spec, fs.readFileSync(rokitCopy), { record: null });
    log(`  ✓ ${alias || spec.repo} ${spec.version} (already downloaded by Rokit)`);
    return { spec, skipped: false, record: null };
  }

  const release = await findRelease(spec.owner, spec.repo, spec.version);
  const { asset } = pickAsset(release.assets, { repo: spec.repo, label });

  log(`  Downloading ${label} (${asset.name})...`);
  const buffer = await downloadAsset(asset);
  const record = { asset: asset.name, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
  if (expected && (expected.asset !== record.asset || expected.sha256 !== record.sha256)) {
    throw new Error(
      `${label}: ${asset.name} doesn't match sof.tools.lock (locked ${expected.asset} ${expected.sha256.slice(0, 12)}..., ` +
        `got ${record.sha256.slice(0, 12)}...). The release changed since it was locked; nothing was installed.`
    );
  }

  const wantedNames = [spec.repo.toLowerCase(), alias && alias.toLowerCase()].filter(Boolean);
  const data = await extractExecutable(buffer, asset.name, wantedNames);

  placeExecutable(spec, data, { record });
  log(`  ✓ ${alias || spec.repo} ${spec.version}`);
  return { spec, skipped: false, record };
}

module.exports = {
  EXE_SUFFIX,
  binDirectory,
  globalManifestPath,
  installTool,
  isToolInstalled,
  readInstallRecord,
  toolExecutablePath,
  toolsRoot,
  versionDirectory,
};
