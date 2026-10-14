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
sof run copy - Copy a project, folder or file, leaving out what sof or git can recreate

USAGE:
  sof run copy <destination>             Copy the folder you are in
  sof run copy <source> <destination>    Copy another folder, or a single file

Works on any folder: a git repository, or a plain folder (its .gitignore files are applied
directly). Symlinks are recreated.

OPTIONS:
  --dry-run          Show what would be copied and skipped, and copy nothing
  --force            Copy into a destination folder that is not empty
  --with-git         Also copy the .git folder (left out by default)
  --exclude <glob>   Also skip paths matching <glob>, relative to the project (repeatable)
  --all              Copy everything: ignored and generated files, and .git

SKIPPED:
  - Files ignored by git (.gitignore at any level, .git/info/exclude, your global ignore file).
    Outside a git repository the .gitignore files in the folder are read directly.
  - Packages sof installed: each <path>/<alias> from [[dependencies]] and sof.lock.
  - What installed add-ons declare as generated (see "generated" in an add-on's sof-addon.json),
    for example the modules a data-sync add-on writes.
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

  // Add-ons: "generated" lists sof.toml keys whose values are paths ("table-sync.targets.output");
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

// A small .gitignore reader for folders that are not inside a git repository.
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function globToRegex(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      const slashBefore = i === 0 || pattern[i - 1] === "/";
      if (pattern[i + 1] === "*" && slashBefore && pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else if (pattern[i + 1] === "*" && slashBefore && i + 2 === pattern.length) {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
        if (pattern[i + 1] === "*") i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[" && pattern.indexOf("]", i + 2) !== -1) {
      const end = pattern.indexOf("]", i + 2);
      out += `[${pattern.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      i = end;
    } else if (c === "\\" && i + 1 < pattern.length) {
      i += 1;
      out += escapeRegex(pattern[i]);
    } else {
      out += escapeRegex(c);
    }
  }
  return out;
}

function parseIgnoreFile(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (line === "") continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const body = globToRegex(line);
    rules.push({ negate, dirOnly, regex: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`) });
  }
  return rules;
}

// Every file under root that its .gitignore files do not exclude (and not .git).
function ignoreAwareWalk(root) {
  const output = [];
  const visit = (relative, inherited) => {
    let rules = inherited;
    const ignoreFile = path.join(root, relative, ".gitignore");
    if (fs.existsSync(ignoreFile)) {
      try {
        const own = parseIgnoreFile(fs.readFileSync(ignoreFile, "utf8"));
        rules = inherited.concat(own.map((rule) => ({ ...rule, base: relative })));
      } catch {
        // unreadable: treated as no rules
      }
    }
    const isIgnored = (child, isDir) => {
      let ignored = false;
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue;
        const within = rule.base ? child.slice(rule.base.length + 1) : child;
        if (rule.regex.test(within)) ignored = !rule.negate;
      }
      return ignored;
    };
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git") continue;
      const isDir = entry.isDirectory();
      if (isIgnored(child, isDir)) continue;
      if (isDir) visit(child, rules);
      else output.push(child);
    }
  };
  visit("", []);
  return output;
}

const isGitInternal =(file) => file === ".git" || file.startsWith(".git/");

// Decides what to copy: { files, skipped: { git, generated, excluded }, notGit }.
function planCopy(projectDir, options = {}) {
  const root = path.resolve(projectDir);
  const { paths, globs } = options.all ? { paths: new Map(), globs: [] } : generatedByProject(root, options);

  const everything = [];
  walk(root, "", everything);
  let listed = null;
  if (!options.all) {
    listed = options.useGit === false ? null : gitFileList(root);
    if (!listed) {
      listed = ignoreAwareWalk(root);
    }
  }
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
    if (!options.withGit && !options.all && isGitInternal(file)) continue;
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

  return { files: files.sort(), skipped };
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
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) {
      try {
        const target = fs.readlinkSync(from);
        const pointsAtFolder = fs.statSync(from, { throwIfNoEntry: false })?.isDirectory();
        fs.rmSync(to, { force: true });
        fs.symlinkSync(target, to, pointsAtFolder ? "junction" : "file");
        copied += 1;
      } catch {
        symlinks += 1; // not allowed here (Windows without developer mode): reported, not fatal
      }
      continue;
    }
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
  const options = { dryRun: false, force: false, withGit: false, all: false, exclude: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--with-git") options.withGit = true;
    else if (arg === "--all") options.all = true;
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

  if (!fs.existsSync(source)) {
    throw new Error(`Source does not exist: ${source}`);
  }
  if (fs.statSync(source).isFile()) {
    const intoFolder = fs.existsSync(destination) && fs.statSync(destination).isDirectory();
    const target = intoFolder ? path.join(destination, path.basename(source)) : destination;
    if (target === source) throw new Error("The destination is the source file.");
    if (!options.dryRun) {
      if (fs.existsSync(target) && !options.force) throw new Error(`${target} exists. Use --force to overwrite it.`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    console.log(`${options.dryRun ? "Would copy" : "Copied"} ${source} to ${target}`);
    return;
  }
  if (!fs.statSync(source).isDirectory()) {
    throw new Error(`Source is not a file or folder: ${source}`);
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

  const plan = planCopy(source, { exclude: options.exclude, withGit: options.withGit, all: options.all });

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
