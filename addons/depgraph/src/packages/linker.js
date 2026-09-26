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

module.exports = {
  linkInstalledPackages,
};
