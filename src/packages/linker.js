"use strict";

const fs = require("fs");
const path = require("path");

function countFiles(directoryPath) {
  let total = 0;
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      total += countFiles(fullPath);
    } else {
      total += 1;
    }
  }
  return total;
}

function removePathIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
  });
}

function determineInstallLayout(extractedPath) {
  const stat = fs.statSync(extractedPath);
  if (stat.isFile()) {
    return {
      kind: "file",
      sourceFilePath: extractedPath,
    };
  }

  if (!stat.isDirectory()) {
    throw new Error(`Unsupported extracted package path type: ${extractedPath}`);
  }

  const entries = fs.readdirSync(extractedPath, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isFile()) {
    return {
      kind: "file",
      sourceFilePath: path.join(extractedPath, entries[0].name),
    };
  }

  return {
    kind: "directory",
    sourceDirectoryPath: extractedPath,
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Points requires of siblings (script.Parent.X, script.Parent.Parent.X, :WaitForChild("X"))
// at the alias the sibling was actually installed under.
function rewriteSource(source, aliasRewrites) {
  let output = source;
  for (const [from, to] of Object.entries(aliasRewrites)) {
    const name = escapeRegExp(from);
    output = output
      .replace(new RegExp(`(script(?:\\.Parent)+)\\.${name}\\b`, "g"), `$1.${to}`)
      .replace(
        new RegExp(`(script(?:\\.Parent)+\\s*:\\s*(?:WaitForChild|FindFirstChild)\\(\\s*["'])${name}(["'])`, "g"),
        `$1${to}$2`
      );
  }
  return output;
}

function applyAliasRewrites(targetPath, aliasRewrites) {
  if (!aliasRewrites || Object.keys(aliasRewrites).length === 0) {
    return;
  }

  const stat = fs.statSync(targetPath);
  const files = stat.isDirectory()
    ? fs
        .readdirSync(targetPath, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.luau?$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath || entry.path, entry.name))
    : [targetPath];

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const rewritten = rewriteSource(source, aliasRewrites);
    if (rewritten !== source) {
      fs.writeFileSync(filePath, rewritten);
    }
  }
}

function linkInstalledPackages(entries, configDirectory) {
  const linkedEntries = [];

  for (const entry of entries || []) {
    if (!entry.extractedPath || !fs.existsSync(entry.extractedPath)) {
      throw new Error(
        `Cannot link package ${entry.name}@${entry.version}: extracted path is missing (${entry.extractedPath}).`
      );
    }

    const destinationRoot = path.resolve(configDirectory, entry.path);
    fs.mkdirSync(destinationRoot, { recursive: true });

    const layout = determineInstallLayout(entry.extractedPath);
    const aliasDirectoryPath = path.join(destinationRoot, entry.alias);
    const aliasLuauPath = path.join(destinationRoot, `${entry.alias}.luau`);

    if (layout.kind === "file") {
      const sourceFileExtension = path.extname(layout.sourceFilePath);
      const destinationFilePath = path.join(destinationRoot, `${entry.alias}${sourceFileExtension}`);
      const cleanupTargets = new Set([aliasDirectoryPath, aliasLuauPath, destinationFilePath]);

      for (const targetPath of cleanupTargets) {
        removePathIfExists(targetPath);
      }

      fs.copyFileSync(layout.sourceFilePath, destinationFilePath);
      applyAliasRewrites(destinationFilePath, entry.aliasRewrites);

      linkedEntries.push({
        ...entry,
        destinationPath: destinationFilePath,
        installedFileCount: 1,
      });

      continue;
    }

    removePathIfExists(aliasDirectoryPath);
    removePathIfExists(aliasLuauPath);
    fs.cpSync(layout.sourceDirectoryPath, aliasDirectoryPath, { recursive: true });
    applyAliasRewrites(aliasDirectoryPath, entry.aliasRewrites);

    linkedEntries.push({
      ...entry,
      destinationPath: aliasDirectoryPath,
      installedFileCount: countFiles(aliasDirectoryPath),
    });
  }

  return {
    entries: linkedEntries,
  };
}

// Writes Rojo meta files so Rojo keeps Studio-only children (e.g. a PackageLink) of the
// listed packages: <alias>.meta.json next to a file, init.meta.json inside a folder.
function writeRojoMeta(configDirectory, group) {
  const root = path.resolve(configDirectory, group.path);
  const written = [];

  for (const alias of group.keepUnknownInstances || []) {
    const directory = path.join(root, alias);
    let metaPath = null;

    if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
      metaPath = path.join(directory, "init.meta.json");
    } else if (fs.existsSync(path.join(root, `${alias}.luau`)) || fs.existsSync(path.join(root, `${alias}.lua`))) {
      metaPath = path.join(root, `${alias}.meta.json`);
    }

    if (metaPath) {
      fs.writeFileSync(metaPath, `${JSON.stringify({ ignoreUnknownInstances: true }, null, 2)}\n`);
      written.push(metaPath);
    }
  }

  return written;
}

// Removes installed files for lockfile entries that are no longer part of the graph.
function pruneRemovedPackages(previousEntries, currentEntries, configDirectory) {
  const keyOf = (entry) => `${String(entry.path).split(path.sep).join("/")}::${entry.alias}`;
  const keep = new Set(currentEntries.map(keyOf));
  const removed = [];

  for (const entry of previousEntries || []) {
    const key = keyOf(entry);
    if (keep.has(key)) {
      continue;
    }

    const root = path.resolve(configDirectory, entry.path);
    for (const candidate of [
      path.join(root, entry.alias),
      path.join(root, `${entry.alias}.luau`),
      path.join(root, `${entry.alias}.lua`),
      path.join(root, `${entry.alias}.meta.json`),
    ]) {
      if (fs.existsSync(candidate)) {
        removePathIfExists(candidate);
        removed.push(entry);
      }
    }
  }

  return removed;
}

module.exports = {
  linkInstalledPackages,
  pruneRemovedPackages,
  writeRojoMeta,
  rewriteSource,
};
