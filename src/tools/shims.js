"use strict";

// The shims in ~/.sof/bin: one small program per tool alias (rojo, selene, ...). Running one
// starts `sof run tools exec <alias>`, which finds the sof.toml above the current folder and runs
// the version it pins. ~/.sof/bin is already on PATH (it is where the `sof` command lives), so
// there is nothing else to add to PATH.
//
//   Windows  <alias>.exe   a copy of src/tools/windows-shim.cs, compiled once with the C# compiler
//                          that comes with Windows; a real .exe because programs that start tools
//                          without a shell (editors, Rojo's plugins) can't find .cmd files
//   macOS/Linux  <alias>   a /bin/sh script
//   Windows without csc   <alias>.cmd  as a fallback
//
// sof-shim.cfg (node, sof entry point) is what the Windows exe and the sh scripts read, so a sof
// update only has to rewrite that one file.

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { sofHome } = require("../addons/store");
const { normalizeAlias } = require("./spec");
const { binDirectory } = require("./store");

const SHIM_SOURCE = path.join(__dirname, "windows-shim.cs");
const CMD_MARKER = "rem sof tool shim";
const SH_MARKER = "# sof tool shim";

function entryPoint() {
  return path.resolve(__dirname, "..", "..", "bin", "sof.js");
}

function configPath() {
  return path.join(binDirectory(), "sof-shim.cfg");
}

function writeIfChanged(filePath, content, mode) {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
    return false;
  }

  fs.writeFileSync(filePath, content, { mode });
  return true;
}

// Lines 3 and on list every alias that has a shim, so a sof update can point all of them at the
// new build; the shims themselves only read the first two lines.
function readKnownAliases() {
  let lines;
  try {
    lines = fs.readFileSync(configPath(), "utf8").split(/\r?\n/).slice(2);
  } catch (_err) {
    return [];
  }

  return lines
    .map((line) => line.trim())
    .filter((line) => {
      try {
        return Boolean(line) && normalizeAlias(line, "sof-shim.cfg") === line;
      } catch (_err) {
        return false;
      }
    });
}

function writeShimConfig(aliases) {
  return writeIfChanged(configPath(), `${[process.execPath, entryPoint(), ...aliases].join("\n")}\n`, 0o644);
}

function findCsc() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return ["Framework64", "Framework"]
    .map((folder) => path.join(root, "Microsoft.NET", folder, "v4.0.30319", "csc.exe"))
    .find((candidate) => fs.existsSync(candidate)) || null;
}

// The compiled shim, built the first time it is needed (and again if its source changes).
// Returns { path } or { error }.
function windowsShimTemplate() {
  const source = fs.readFileSync(SHIM_SOURCE);
  const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 12);
  const directory = path.join(sofHome(), "shim");
  const template = path.join(directory, `sof-shim-${hash}.exe`);

  if (fs.existsSync(template)) {
    return { path: template };
  }

  const csc = findCsc();
  if (!csc) {
    return { error: "the C# compiler that ships with Windows (csc.exe) wasn't found" };
  }

  fs.mkdirSync(directory, { recursive: true });
  const building = `${template}.${process.pid}.tmp`;
  const result = childProcess.spawnSync(csc, ["/nologo", "/target:exe", "/optimize+", `/out:${building}`, SHIM_SOURCE], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });

  if (result.status !== 0 || !fs.existsSync(building)) {
    fs.rmSync(building, { force: true });
    const detail = String(result.stdout || result.stderr || result.error || "").trim().split(/\r?\n/)[0];
    return { error: `compiling the shim failed${detail ? ` (${detail})` : ""}` };
  }

  fs.renameSync(building, template);
  for (const name of fs.readdirSync(directory)) {
    if (/^sof-shim-[0-9a-f]+\.exe$/.test(name) && name !== path.basename(template)) {
      fs.rmSync(path.join(directory, name), { force: true });
    }
  }
  return { path: template };
}

function shScript(alias) {
  return [
    "#!/bin/sh",
    `${SH_MARKER} (rewritten by: sof run tools setup)`,
    // Shell built-ins only: running dirname/cat/... here would start whatever a PATH lookup finds.
    'case "$0" in */*) dir=${0%/*} ;; *) dir=. ;; esac',
    '{ read -r node; read -r entry; } 2>/dev/null < "$dir/sof-shim.cfg"',
    '[ -x "$node" ] || node=node',
    `[ -f "$entry" ] || { echo "sof: can't find sof. Run: sof run tools setup" >&2; exit 127; }`,
    `exec "$node" "$entry" run tools exec ${alias} "$@"`,
    "",
  ].join("\n");
}

function cmdScript(alias) {
  return `@echo off\r\n${CMD_MARKER}\r\n"${process.execPath}" "${entryPoint()}" run tools exec ${alias} %*\r\n`;
}

function sameFile(a, b) {
  try {
    return fs.statSync(a).size === fs.statSync(b).size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch (_err) {
    return false;
  }
}

// A running tool's .exe can't be overwritten, but it can be renamed out of the way. The renamed
// copy can't be deleted while it runs either, so it is left for the next setup to clear.
function replaceFile(source, target) {
  try {
    fs.copyFileSync(source, target);
  } catch (_err) {
    const aside = `${target}.old-${process.pid}-${Date.now()}`;
    fs.renameSync(target, aside);
    fs.copyFileSync(source, target);
    try {
      fs.rmSync(aside, { force: true });
    } catch (_busy) {
      // Still running: removed by clearReplacedShims() next time.
    }
  }
}

function clearReplacedShims(binDir) {
  for (const name of fs.readdirSync(binDir)) {
    if (/\.exe\.old-\d+-\d+$/.test(name)) {
      try {
        fs.rmSync(path.join(binDir, name), { force: true });
      } catch (_busy) {
        // Still running.
      }
    }
  }
}

function removeOwnedCmd(binDir, alias) {
  const file = path.join(binDir, `${alias}.cmd`);
  try {
    if (fs.readFileSync(file, "utf8").includes(CMD_MARKER)) {
      fs.rmSync(file, { force: true });
    }
  } catch (_err) {
    // Not there, or not ours.
  }
}

// Makes sure every alias (and every alias that already had a shim) has one, and that all of them
// point at this sof. Returns { changed: [alias...], kind: "exe" | "sh" | "cmd", warning? }.
function ensureShims(aliases) {
  const binDir = binDirectory();
  fs.mkdirSync(binDir, { recursive: true });

  const unique = [...new Set([...readKnownAliases(), ...aliases])].sort();
  writeShimConfig(unique);

  const changed = [];

  if (process.platform !== "win32") {
    for (const alias of unique) {
      if (writeIfChanged(path.join(binDir, alias), shScript(alias), 0o755)) {
        changed.push(alias);
      }
      fs.chmodSync(path.join(binDir, alias), 0o755);
    }
    return { changed, kind: "sh" };
  }

  clearReplacedShims(binDir);
  const template = windowsShimTemplate();
  if (template.error) {
    for (const alias of unique) {
      if (writeIfChanged(path.join(binDir, `${alias}.cmd`), cmdScript(alias))) {
        changed.push(alias);
      }
    }
    return {
      changed,
      kind: "cmd",
      warning: `Couldn't build native tool shims (${template.error}), so tools use .cmd files: editors that start tools without a shell won't find them.`,
    };
  }

  for (const alias of unique) {
    const target = path.join(binDir, `${alias}.exe`);
    if (!sameFile(template.path, target)) {
      replaceFile(template.path, target);
      changed.push(alias);
    }
    removeOwnedCmd(binDir, alias);
  }
  return { changed, kind: "exe" };
}

module.exports = {
  clearReplacedShims,
  ensureShims,
  entryPoint,
  findCsc,
  replaceFile,
  shScript,
};
