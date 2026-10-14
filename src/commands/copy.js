"use strict";

// sof run copy: copy a project to another folder without what can be recreated there:
// .gitignored files, packages installed by sof, and what installed add-ons say they generate.

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const fg = require("fast-glob");
const toml = require("smol-toml");

const { readManifest, readAddonDescriptor } = require("../addons/store");

const HELP_TEXT = `
sof run copy - Copy a project, leaving out what sof or git can recreate

USAGE:
  sof run copy <destination>             Copy the project in the current folder
  sof run copy <source> <destination>    Copy another project

OPTIONS:
  --dry-run          Show what would be copied and skipped, and copy nothing
  --force            Copy into a destination folder that is not empty
  --with-git         Also copy the .git folder (left out by default)
  --exclude <glob>   Also skip paths matching <glob>, relative to the project (repeatable)

SKIPPED:
  - Files ignored by git (.gitignore at any level, .git/info/exclude, your global ignore file).
    This needs the project to be a git repository; otherwise it is reported and not applied.
  - Packages sof installed: each <path>/<alias> from [[dependencies]] and sof.lock.
  - What installed add-ons declare as generated (see "generated" in an add-on's sof-addon.json),
    for example the files an [[affine.sync]] entry writes.
`;

function posix(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function keyOf(value) {
  const normalized = posix(value);
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

// Follows a dotted key through a parsed TOML value, going through arrays, and returns every
// string found at the end.
function valuesAt(node, keys) {
  if (Array.isArray(node)) {
    return node.flatMap((item) => valuesAt(item, keys));
  }
  if (keys.length === 0) {
    return typeof node === "string" ? [node] : [];
  }
  if (!node || typeof node !== "object") {
    return [];
  }
  return valuesAt(node[keys[0]], keys.slice(1));
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// A project-relative path from a file we do not trust, or null when it points outside.
function relativeInside(root, value) {
  if (typeof value !== "string" || value.trim() === "" || path.isAbsolute(value)) {
    return null;
  }
  const resolved = path.resolve(root, value.trim());
  return isInside(root, resolved) ? posix(path.relative(root, resolved)) : null;
}

function readToml(file) {
  try {
    return toml.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function installedAddonDescriptors() {
  const found = [];
  let manifest;
  try {
    manifest = readManifest();
  } catch {
    return found;
  }
  for (const addon of Object.values(manifest.addons)) {
    try {
      found.push(readAddonDescriptor(addon.directory));
    } catch {
      // A broken add-on only means it contributes nothing.
    }
  }
  return found;
}

// Everything under the project that something else produces: { paths: Map, globs: [] }.
// sof.toml and sof.lock may come from a clone, so they only ever add exclusions, and only for
// paths inside the project.
function generatedByProject(projectDir, { addons } = {}) {
  const paths = new Map(); // key -> { path, reason }
  const globs = [];
  const add = (value, reason) => {
    const rel = relativeInside(projectDir, value);
    if (rel) {
      paths.set(keyOf(rel), { path: rel, reason });
    }
  };

  const config = readToml(path.join(projectDir, "sof.toml"));

  // Installed packages: <path>/<alias>, <alias>.luau|.lua, and the Rojo meta file next to it.
  const packageSlots = [];
  if (config && Array.isArray(config.dependencies)) {
    for (const group of config.dependencies) {
      if (!group || typeof group.path !== "string") continue;
      for (const [alias, value] of Object.entries(group)) {
        if (alias !== "path" && alias !== "keep_unknown_instances" && typeof value === "string") {
          packageSlots.push([group.path, alias]);
        }
      }
    }
  }
  const lock = readToml(path.join(projectDir, "sof.lock"));
  if (lock && Array.isArray(lock.package)) {
    for (const entry of lock.package) {
      if (entry && typeof entry.path === "string" && typeof entry.alias === "string") {
        packageSlots.push([entry.path, entry.alias]);
      }
    }
  }
  for (const [folder, alias] of packageSlots) {
    if (/[\\/]/.test(alias) || alias === ".." || alias === ".") continue;
    for (const name of [alias, `${alias}.luau`, `${alias}.lua`, `${alias}.meta.json`]) {
      add(path.join(folder, name), "installed package");
    }
  }

  // Add-ons: "generated" lists sof.toml keys whose values are paths ("affine.sync.output");
  // "generatedPaths" lists globs relative to the project.
  for (const addon of addons || installedAddonDescriptors()) {
    const label = `add-on ${addon.name}`;
    for (const spec of Array.isArray(addon.generated) ? addon.generated : []) {
      if (typeof spec !== "string" || !config) continue;
      for (const value of valuesAt(config, spec.split(".").filter(Boolean))) {
        add(value, label);
      }
    }
    for (const glob of Array.isArray(addon.generatedPaths) ? addon.generatedPaths : []) {
      if (typeof glob === "string" && glob.trim() !== "" && relativeInside(projectDir, glob.trim())) {
        globs.push({ glob: posix(glob.trim()), reason: label });
      }
    }
  }

  return { paths, globs };
}

// Files git would keep: tracked ones plus untracked ones that are not ignored. null if no git.
function gitFileList(projectDir) {
  const result = childProcess.spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return Array.from(new Set(result.stdout.split("\0").filter(Boolean).map(posix)));
}

function walk(projectDir, relative, output) {
  for (const entry of fs.readdirSync(path.join(projectDir, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(projectDir, child, output);
    } else {
      output.push(child);
    }
  }
}

const isGitInternal = (file) => file === ".git" || file.startsWith(".git/");

// Decides what to copy: { files, skipped: { git, generated, excluded }, notGit }.
function planCopy(projectDir, options = {}) {
  const root = path.resolve(projectDir);
  const { paths, globs } = generatedByProject(root, options);

  const everything = [];
  walk(root, "", everything);
  const listed = options.useGit === false ? null : gitFileList(root);
  const candidates = listed || everything;

  const globMatches = new Map();
  const patterns = [...globs, ...(options.exclude || []).map((glob) => ({ glob: posix(glob), reason: "--exclude" }))];
  for (const { glob, reason } of patterns) {
    const matches = fg.sync([glob, `${glob}/**`], { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false });
    for (const match of matches) {
      globMatches.set(keyOf(match), reason);
    }
  }

  const reasonFor = (file) => {
    const key = keyOf(file);
    if (globMatches.has(key)) return globMatches.get(key);
    const segments = key.split("/");
    for (let i = 1; i <= segments.length; i += 1) {
      const hit = paths.get(segments.slice(0, i).join("/"));
      if (hit) return hit.reason;
    }
    return null;
  };

  const files = [];
  const skipped = { git: [], generated: [], excluded: [] };
  for (const file of candidates) {
    if (!options.withGit && isGitInternal(file)) continue;
    const reason = reasonFor(file);
    if (reason === "--exclude") skipped.excluded.push(file);
    else if (reason) skipped.generated.push({ file, reason });
    else files.push(file);
  }

  // A file on disk that git did not list is ignored by git.
  if (listed) {
    const listedKeys = new Set(listed.map(keyOf));
    for (const file of everything) {
      if (!options.withGit && isGitInternal(file)) continue;
      if (!listedKeys.has(keyOf(file))) skipped.git.push(file);
    }
  }

  return { files: files.sort(), skipped, notGit: !listed };
}

function copyFiles(projectDir, destination, files) {
  let copied = 0;
  let symlinks = 0;
  for (const file of files) {
    const from = path.join(projectDir, file);
    const to = path.join(destination, file);
    let stat;
    try {
      stat = fs.lstatSync(from);
    } catch {
      continue; // tracked by git but deleted in the working tree
    }
    if (stat.isSymbolicLink()) {
      symlinks += 1;
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isDirectory()) {
      // A submodule or nested repository: copied whole, minus its own .git.
      fs.cpSync(from, to, { recursive: true, filter: (source) => path.basename(source) !== ".git" });
    } else {
      fs.copyFileSync(from, to);
    }
    copied += 1;
  }
  return { copied, symlinks };
}

function parseArgs(argv) {
  const options = { dryRun: false, force: false, withGit: false, exclude: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--with-git") options.withGit = true;
    else if (arg === "--exclude") {
      i += 1;
      if (!argv[i]) throw new Error("--exclude needs a glob.");
      options.exclude.push(argv[i]);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option "${arg}". See: sof run copy --help`);
    else positional.push(arg);
  }
  return { options, positional };
}

async function runCopy(argv) {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    console.log(HELP_TEXT);
    return;
  }

  const { options, positional } = parseArgs(argv);
  if (positional.length < 1 || positional.length > 2) {
    throw new Error("Give a destination, or a source and a destination. See: sof run copy --help");
  }
  const source = path.resolve(positional.length === 2 ? positional[0] : ".");
  const destination = path.resolve(positional[positional.length - 1]);

  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Source is not a folder: ${source}`);
  }
  if (destination === source || isInside(source, destination)) {
    throw new Error(`The destination ${destination} is the source project or inside it.`);
  }
  if (isInside(destination, source)) {
    throw new Error(`The source project is inside the destination ${destination}.`);
  }
  if (!options.dryRun && !options.force && fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
    throw new Error(`${destination} is not empty. Use --force to copy into it anyway.`);
  }

  const plan = planCopy(source, { exclude: options.exclude, withGit: options.withGit });
  if (plan.notGit) {
    console.log("Not a git repository (or git is missing): .gitignore was not applied.");
  }

  const { git, generated, excluded } = plan.skipped;
  if (options.dryRun) {
    for (const file of plan.files) console.log(`  copy  ${file}`);
    for (const entry of generated) console.log(`  skip  ${entry.file}  (${entry.reason})`);
    for (const file of excluded) console.log(`  skip  ${file}  (--exclude)`);
  }

  let summary;
  if (options.dryRun) {
    summary = `Would copy ${plan.files.length} file(s)`;
  } else {
    fs.mkdirSync(destination, { recursive: true });
    const result = copyFiles(source, destination, plan.files);
    summary = `Copied ${result.copied} file(s) to ${destination}`;
    if (result.symlinks > 0) summary += ` (${result.symlinks} symlink(s) not copied)`;
  }
  console.log(
    `${summary}; skipped ${git.length} ignored by git, ${generated.length} generated, ${excluded.length} excluded.`
  );
}

module.exports = { runCopy, planCopy, generatedByProject };
