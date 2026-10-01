"use strict";

const {
  WALLY_API_URL,
  WALLY_CLIENT_VERSION,
  WALLY_INDEX_BRANCH,
  WALLY_INDEX_REPO,
} = require("../constants");

function splitPackageName(packageName) {
  if (typeof packageName !== "string") {
    throw new Error(`Package name must be a string. Received: ${typeof packageName}`);
  }

  const parts = packageName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid package name "${packageName}". Expected "scope/name".`);
  }

  return {
    scope: parts[0],
    name: parts[1],
  };
}

function mergeDependencyMaps(primary, secondary) {
  const output = {};

  for (const source of [primary, secondary]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }

    for (const [alias, specifier] of Object.entries(source)) {
      if (typeof specifier !== "string" || specifier.trim() === "") {
        continue;
      }

      if (output[alias] && output[alias] !== specifier.trim()) {
        throw new Error(
          `Wally dependency alias "${alias}" has conflicting values "${output[alias]}" and "${specifier}".`
        );
      }

      output[alias] = specifier.trim();
    }
  }

  return output;
}

class WallyProvider {
  constructor(options = {}) {
    this.source = "wally";
    this.indexRepository = options.indexRepository || WALLY_INDEX_REPO;
    this.indexBranch = options.indexBranch || WALLY_INDEX_BRANCH;
    this.apiBaseUrl = options.apiBaseUrl || WALLY_API_URL;
  }

  async queryPackage(packageName) {
    const { scope, name } = splitPackageName(packageName);
    const indexUrl =
      `https://raw.githubusercontent.com/${this.indexRepository}/` +
      `${this.indexBranch}/${scope}/${name}`;

    const response = await fetch(indexUrl);
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch Wally index entry (${response.status}): ${errorText}`);
    }

    const text = await response.text();
    const versions = [];

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsedLine;
      try {
        parsedLine = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`Failed to parse Wally JSONL entry for ${packageName}: ${err.message}`);
      }

      const packageMetadata = parsedLine.package;
      if (!packageMetadata || typeof packageMetadata.version !== "string") {
        continue;
      }

      versions.push({
        version: packageMetadata.version,
        metadata: packageMetadata,
        dependencies: mergeDependencyMaps(
          parsedLine.dependencies,
          parsedLine["server-dependencies"]
        ),
      });
    }

    if (versions.length === 0) {
      return null;
    }

    return {
      source: this.source,
      packageName,
      versions,
    };
  }

  async downloadPackage(packageName, version) {
    const { scope, name } = splitPackageName(packageName);
    const url = `${this.apiBaseUrl}/v1/package-contents/${scope}/${name}/${version}`;

    const response = await fetch(url, { headers: { "Wally-Version": WALLY_CLIENT_VERSION } });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to download Wally package (${response.status}): ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      archiveType: "zip",
    };
  }
}

module.exports = {
  WallyProvider,
};
