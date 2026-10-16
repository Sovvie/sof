"use strict";

const fs = require("fs");
const path = require("path");

// Left out no matter what: version control, installed dependencies, and the folder's own dist/.
const DEFAULT_EXCLUDES = [".git", "node_modules", "/dist"];

function toPosix(rel) {
  return path.sep === "/" ? rel : rel.split(path.sep).join("/");
}

function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel));
}

function readGitignore(dir) {
  const file = path.join(dir, ".gitignore");
  try {
    if (fs.lstatSync(file).isFile()) {
      return fs.readFileSync(file, "utf8");
    }
  } catch (_err) {
    // no .gitignore here
  }
  return null;
}

// Walks `root` and returns the files to bundle, sorted, plus what was skipped.
// Options: include/exclude (gitignore-style patterns), gitignore (bool), skipPaths (absolute paths never bundled).
function selectFiles(root, options = {}) {
  const createIgnore = require("ignore");
  const include = options.include || [];
  const exclude = [...DEFAULT_EXCLUDES, ...(options.exclude || [])];
  const useGitignore = options.gitignore !== false;
  const skipPaths = new Set((options.skipPaths || []).map((p) => path.resolve(p)));

  const excluder = createIgnore().add(exclude);
  const includer = include.length ? createIgnore().add(include) : null;

  const files = [];
  const symlinks = [];
  const special = [];

  // Frames of .gitignore rules, outermost first; a deeper file's rules can re-include (!x) what an outer one hid.
  function gitIgnored(frames, rel, isDir) {
    let ignored = false;
    for (const frame of frames) {
      const local = rel.slice(frame.base.length);
      const result = frame.ig.test(isDir ? `${local}/` : local);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }

  function walk(dirAbs, dirRel, frames) {
    let active = frames;
    if (useGitignore) {
      const text = readGitignore(dirAbs);
      if (text !== null) {
        active = [...frames, { base: dirRel ? `${dirRel}/` : "", ig: createIgnore().add(text) }];
      }
    }
    const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (skipPaths.has(abs)) continue;
      if (entry.isSymbolicLink()) {
        // checked before the ignore rules would hide it: the user should hear about every link we won't follow
        if (!excluder.ignores(rel) && !(useGitignore && gitIgnored(active, rel, false))) {
          symlinks.push(rel);
        }
        continue;
      }
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) {
        special.push(rel);
        continue;
      }
      if (excluder.ignores(isDir ? `${rel}/` : rel)) continue;
      if (useGitignore && gitIgnored(active, rel, isDir)) continue;
      if (isDir) {
        walk(abs, rel, active);
        continue;
      }
      if (includer && !includer.ignores(rel)) continue;
      const stat = fs.lstatSync(abs);
      if (!stat.isFile()) continue;
      files.push({ rel, abs, size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs });
    }
  }

  walk(path.resolve(root), "", []);
  files.sort(compareBytes);
  symlinks.sort();
  special.sort();
  return { files, symlinks, special };
}

module.exports = { selectFiles, DEFAULT_EXCLUDES, toPosix };
