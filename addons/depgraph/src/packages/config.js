"use strict";

const fs = require("fs");
const path = require("path");
const semver = require("semver");
const toml = require("smol-toml");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringList(value, fieldName, indexLabel) {
  if (typeof value === "string" && value.trim() !== "") {
    return [value.trim()];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${indexLabel}: "${fieldName}" must be a string or a non-empty array of strings.`);
  }

  const output = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${indexLabel}: "${fieldName}" entries must be non-empty strings.`);
    }
    output.push(item.trim());
  }

  return output;
}

function assertAlias(alias, contextLabel) {
  if (typeof alias !== "string" || alias.trim() === "") {
    throw new Error(`${contextLabel}: dependency alias must be a non-empty string.`);
  }

  if (alias === "path") {
    throw new Error(`${contextLabel}: "path" is reserved and cannot be used as a dependency alias.`);
  }

  if (/[\\/]/.test(alias)) {
    throw new Error(`${contextLabel}: dependency alias "${alias}" cannot contain path separators.`);
  }
}

function assertPackageName(packageName, contextLabel) {
  if (typeof packageName !== "string" || packageName.trim() === "") {
    throw new Error(`${contextLabel}: package name must be a non-empty string.`);
  }

  const normalized = packageName.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error(
      `${contextLabel}: package name "${packageName}" must match "scope/name".`
    );
  }

  return normalized;
}

function parseDependencySpecifier(alias, specifier, contextLabel) {
  assertAlias(alias, contextLabel);

  if (typeof specifier !== "string" || specifier.trim() === "") {
    throw new Error(
      `${contextLabel}: dependency "${alias}" must be a non-empty string in the form "scope/name@range".`
    );
  }

  const trimmedSpecifier = specifier.trim();
  const atIndex = trimmedSpecifier.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmedSpecifier.length - 1) {
    throw new Error(
      `${contextLabel}: dependency "${alias}" must use the form "scope/name@range".`
    );
  }

  const packageName = assertPackageName(trimmedSpecifier.slice(0, atIndex), contextLabel);
  const range = trimmedSpecifier.slice(atIndex + 1).trim();
  if (!semver.validRange(range, { includePrerelease: true })) {
    throw new Error(
      `${contextLabel}: dependency "${alias}" has invalid semver range "${range}".`
    );
  }

  return {
    alias: alias.trim(),
    name: packageName,
    range,
    specifier: `${packageName}@${range}`,
  };
}

function normalizeDependencyGroup(rawGroup, groupIndex) {
  const indexLabel = `[[dependencies]] entry #${groupIndex}`;
  if (!isPlainObject(rawGroup)) {
    throw new Error(`${indexLabel}: entry must be a TOML table.`);
  }

  if (typeof rawGroup.path !== "string" || rawGroup.path.trim() === "") {
    throw new Error(`${indexLabel}: "path" is required and must be a non-empty string.`);
  }

  const dependencies = [];
  for (const [key, value] of Object.entries(rawGroup)) {
    if (key === "path") {
      continue;
    }

    dependencies.push(parseDependencySpecifier(key, value, indexLabel));
  }

  if (dependencies.length === 0) {
    throw new Error(`${indexLabel}: at least one dependency declaration is required.`);
  }

  return {
    path: rawGroup.path.trim(),
    dependencies,
  };
}

function parsePackageDependencies(rawDependencies, indexLabel) {
  if (rawDependencies === undefined) {
    return [];
  }

  if (!isPlainObject(rawDependencies)) {
    throw new Error(`${indexLabel}: "dependencies" must be a TOML table when provided.`);
  }

  const dependencies = [];
  for (const [key, value] of Object.entries(rawDependencies)) {
    dependencies.push(parseDependencySpecifier(key, value, `${indexLabel} [package.dependencies]`));
  }

  return dependencies;
}

function normalizePackageEntry(rawPackage, packageIndex) {
  const indexLabel = `[[package]] entry #${packageIndex}`;
  if (!isPlainObject(rawPackage)) {
    throw new Error(`${indexLabel}: entry must be a TOML table.`);
  }

  const name = assertPackageName(rawPackage.name, indexLabel);

  if (typeof rawPackage.version !== "string" || rawPackage.version.trim() === "") {
    throw new Error(`${indexLabel}: "version" is required and must be a non-empty string.`);
  }

  const version = rawPackage.version.trim();
  if (!semver.valid(version)) {
    throw new Error(`${indexLabel}: "version" must be a valid semver version.`);
  }

  const include = toStringList(rawPackage.include, "include", indexLabel);
  const dependencies = parsePackageDependencies(rawPackage.dependencies, indexLabel);

  const description = rawPackage.description === undefined ? "" : rawPackage.description;
  if (typeof description !== "string") {
    throw new Error(`${indexLabel}: "description" must be a string when provided.`);
  }

  const license = rawPackage.license === undefined ? "" : rawPackage.license;
  if (typeof license !== "string") {
    throw new Error(`${indexLabel}: "license" must be a string when provided.`);
  }

  const realm = rawPackage.realm === undefined ? "shared" : rawPackage.realm;
  if (typeof realm !== "string" || realm.trim() === "") {
    throw new Error(`${indexLabel}: "realm" must be a non-empty string when provided.`);
  }

  let authors = [];
  if (rawPackage.authors !== undefined) {
    if (!Array.isArray(rawPackage.authors)) {
      throw new Error(`${indexLabel}: "authors" must be an array of strings when provided.`);
    }

    authors = rawPackage.authors.map((author) => {
      if (typeof author !== "string" || author.trim() === "") {
        throw new Error(`${indexLabel}: "authors" entries must be non-empty strings.`);
      }
      return author.trim();
    });
  }

  return {
    name,
    version,
    description: description.trim(),
    license: license.trim(),
    realm: realm.trim(),
    authors,
    include,
    dependencies,
  };
}

function readRawConfig(configPathArg) {
  const configPath = path.resolve(configPathArg || "sof.toml");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file does not exist: ${configPath}`);
  }

  const configText = fs.readFileSync(configPath, "utf8");
  let parsed;
  try {
    parsed = toml.parse(configText);
  } catch (err) {
    throw new Error(`Failed to parse TOML config at ${configPath}: ${err.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Config at ${configPath} must be a TOML object.`);
  }

  return {
    configPath,
    configDirectory: path.dirname(configPath),
    parsed,
  };
}

function readPackageInstallConfig(configPathArg) {
  const raw = readRawConfig(configPathArg);
  const dependencies = raw.parsed.dependencies;

  if (!Array.isArray(dependencies) || dependencies.length === 0) {
    throw new Error(
      `Config at ${raw.configPath} must define at least one [[dependencies]] entry.`
    );
  }

  const groups = dependencies.map((entry, index) => normalizeDependencyGroup(entry, index + 1));

  return {
    configPath: raw.configPath,
    configDirectory: raw.configDirectory,
    groups,
  };
}

function readPackagePublishConfig(configPathArg) {
  const raw = readRawConfig(configPathArg);
  const packageEntries = raw.parsed.package;

  if (!Array.isArray(packageEntries) || packageEntries.length === 0) {
    throw new Error(
      `Config at ${raw.configPath} must define at least one [[package]] entry to publish.`
    );
  }

  const packages = packageEntries.map((entry, index) => normalizePackageEntry(entry, index + 1));

  return {
    configPath: raw.configPath,
    configDirectory: raw.configDirectory,
    packages,
  };
}

module.exports = {
  parseDependencySpecifier,
  readPackageInstallConfig,
  readPackagePublishConfig,
};
