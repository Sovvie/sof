"use strict";

// sof.toml and sof.lock can come from a repository you just cloned, and package install writes into
// and deletes from folders they name. What they name has to stay inside the project:
//   - a package folder ([[dependencies]] path, and `path` in sof.lock) is relative and has no "..";
//   - a package alias (a key under [[dependencies]], `alias` in sof.lock, keep_unknown_instances)
//     is a single file or folder name, never "." or ".." or something Windows would turn into them;
//   - and right before anything is written or removed, the real location (symbolic links
//     followed) is checked to be inside the project folder.

const fs = require("fs");
const path = require("path");

function assertProjectFolder(value, label) {
  const text = String(value);
  const unsafe =
    text.trim() === "" ||
    text.includes("\0") ||
    path.posix.isAbsolute(text) ||
    path.win32.isAbsolute(text) ||
    /^[A-Za-z]:/.test(text) ||
    // ".." and what Windows reads as "..": "..." or ".. " lose their trailing dots and spaces.
    text.split(/[\\/]+/).some((segment) => /^\.\.[ .]*$/.test(segment));
  if (unsafe) {
    throw new Error(`${label}: path "${text}" must be a folder inside the project: relative, and without "..".`);
  }
}

function assertPackageAlias(alias, label) {
  const text = String(alias);
  const unsafe =
    text === "" ||
    text !== text.trim() ||
    /^\.+$/.test(text) ||
    /\.$/.test(text) ||
    /[\\/\0]/.test(text);
  if (unsafe) {
    throw new Error(`${label}: name "${text}" must be a single file or folder name (no path separators, not "." or "..", no trailing dot or space).`);
  }
}

// The nearest part of targetPath that exists, with symbolic links resolved.
function realExistingAncestor(targetPath) {
  let probe = path.resolve(targetPath);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      break;
    }
    probe = parent;
  }
  return fs.realpathSync(probe);
}

// Throws unless targetPath is, once links are followed, inside the project folder.
function assertInsideProject(configDirectory, targetPath) {
  const root = fs.realpathSync(path.resolve(configDirectory));
  const relative = path.relative(root, realExistingAncestor(targetPath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write or delete outside the project: ${targetPath} is not inside ${configDirectory}.`);
  }

  const lexical = path.relative(path.resolve(configDirectory), path.resolve(targetPath));
  if (lexical.startsWith("..") || path.isAbsolute(lexical)) {
    throw new Error(`Refusing to write or delete outside the project: ${targetPath} is not inside ${configDirectory}.`);
  }
}

module.exports = {
  assertInsideProject,
  assertPackageAlias,
  assertProjectFolder,
};
