"use strict";

const fs = require("fs");
const path = require("path");
const { SOF_REGISTRY_URL } = require("../constants");
const { NOT_SIGNED_IN, findToken } = require("../auth");
const { getAccessToken, noteRegistryResponse } = require("../../account/store");

const SEARCH_PAGE_SIZE = 100;
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ARTIFACT_PATH_PATTERN =
  /^packages\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._+-]+\.tar\.gz$/;

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

function dependenciesArrayToObject(dependencies) {
  const output = {};
  for (const dependency of dependencies || []) {
    output[dependency.alias] = dependency.specifier;
  }
  return output;
}

// An artifact path comes out of an index file, so it is checked before it becomes a URL:
// the registry's own layout only, and no "." / ".." segments.
function isSafeArtifactPath(artifactPath) {
  return (
    typeof artifactPath === "string" &&
    ARTIFACT_PATH_PATTERN.test(artifactPath) &&
    !artifactPath.split("/").some((segment) => segment === "." || segment === "..")
  );
}

// The server's {error:"..."} message, verbatim; the raw body (trimmed) when it isn't JSON.
async function readErrorMessage(response) {
  let text = "";
  try {
    text = await response.text();
  } catch (_err) {
    // Fall through to the status text.
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "string" && parsed.error !== "") {
      return parsed.error;
    }
  } catch (_err) {
    // Not JSON.
  }

  const trimmed = text.trim();
  return (trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed) || response.statusText || "(no message)";
}

// Lines that tell the user a { state: "quarantined" } publish result is waiting for review.
function heldForReviewLines(result) {
  const lines = [`${result.packageName}@${result.version} is HELD FOR REVIEW, not published yet`];
  for (const finding of result.findings || []) {
    const location = finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
    lines.push(`  - ${finding.rule || "finding"}${location}: ${finding.why || ""}`.trimEnd());
  }
  lines.push("It goes live once a registry admin approves it.");
  return lines;
}

function describeNetworkError(registryUrl, err) {
  const cause = err && err.cause && err.cause.message ? `: ${err.cause.message}` : "";
  return new Error(`Could not reach the registry at ${registryUrl} (${err.message}${cause}).`);
}

// Reads carry the staff sign-in (private packages) when there is one. Requests that already carry
// an Authorization header (publishing, whoami) are left alone, and so are requests when nobody is
// signed in, so everyone else's behaviour is unchanged.
async function withStaffAuth(registryUrl, options) {
  const method = String((options && options.method) || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return options;
  }
  const given = (options && options.headers) || {};
  const existing = typeof given.entries === "function" ? Object.fromEntries(given.entries()) : given;
  if (Object.keys(existing).some((key) => key.toLowerCase() === "authorization")) {
    return options;
  }
  const token = await getAccessToken(registryUrl);
  return token ? { ...options, headers: { ...existing, Authorization: `Bearer ${token}` } } : options;
}

async function registryFetch(registryUrl, urlPath, options) {
  const withAuth = await withStaffAuth(registryUrl, options);
  try {
    const response = await fetch(`${registryUrl}${urlPath}`, withAuth);
    noteRegistryResponse(response);
    return response;
  } catch (err) {
    throw describeNetworkError(registryUrl, err);
  }
}

function publishFailure(packageEntry, response, message) {
  const label = `${packageEntry.name}@${packageEntry.version}`;
  let hint = "";
  if (response.status === 401) {
    hint = '\nSign in again with "sof run package login".';
  } else if (response.status === 409) {
    hint = '\nVersions are immutable: bump "version" and publish again.';
  } else if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    hint = retryAfter ? `\nRate limited. Retry in ${retryAfter} second(s) (Retry-After: ${retryAfter}).` : "\nRate limited. Try again shortly.";
  }

  const error = new Error(`Publishing ${label} failed (${response.status}): ${message}${hint}`);
  error.status = response.status;
  error.serverMessage = message;
  return error;
}

class SofProvider {
  constructor(options = {}) {
    this.source = "sof";
    this.registryUrl = (options.registryUrl || SOF_REGISTRY_URL).replace(/\/+$/, "");
    this.token = options.token || "";
  }

  getToken() {
    if (this.token) {
      return this.token;
    }

    const found = findToken();
    return found ? found.token : "";
  }

  async queryPackage(packageName) {
    const parts = splitPackageName(packageName);
    const scope = parts.scope.toLowerCase();
    const name = parts.name.toLowerCase();
    if (!SEGMENT_PATTERN.test(scope) || !SEGMENT_PATTERN.test(name)) {
      // Can't be a name this registry holds; let the caller fall through to the next source.
      return null;
    }

    const indexPath = `index/${scope}/${name}.json`;
    const response = await registryFetch(this.registryUrl, `/${indexPath}`);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch Sof index entry (${response.status}): ${errorText}`);
    }

    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Invalid JSON in Sof index file "${indexPath}": ${err.message}`);
    }

    if (!parsed || typeof parsed !== "object" || !parsed.versions || typeof parsed.versions !== "object") {
      throw new Error(`Sof index file "${indexPath}" must contain a "versions" object.`);
    }

    const versions = Object.entries(parsed.versions).map(([version, metadata]) => ({
      version,
      metadata: metadata || {},
      dependencies:
        metadata && typeof metadata.dependencies === "object" && !Array.isArray(metadata.dependencies)
          ? metadata.dependencies
          : {},
    }));

    return {
      source: this.source,
      packageName,
      versions,
    };
  }

  async downloadPackage(packageName, version) {
    const packageMetadata = await this.queryPackage(packageName);
    if (!packageMetadata) {
      throw new Error(`Package ${packageName} was not found in the Sof registry (${this.registryUrl}).`);
    }

    const selectedVersion = packageMetadata.versions.find(
      (candidate) => candidate.version === version
    );
    if (!selectedVersion) {
      throw new Error(`Package ${packageName}@${version} was not found in the Sof registry.`);
    }

    const { scope, name } = splitPackageName(packageName);
    const artifactPath =
      selectedVersion.metadata && typeof selectedVersion.metadata.artifact === "string"
        ? selectedVersion.metadata.artifact
        : `packages/${scope.toLowerCase()}/${name.toLowerCase()}/${version}.tar.gz`;

    if (!isSafeArtifactPath(artifactPath)) {
      throw new Error(
        `Refusing to download ${packageName}@${version}: unexpected artifact path "${artifactPath}".`
      );
    }

    const response = await registryFetch(this.registryUrl, `/${artifactPath}`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to download Sof package artifact (${response.status}) from ${artifactPath}: ${errorText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      buffer,
      archiveType: "tar.gz",
    };
  }

  // Every package the registry lists for `query` (and `scope`), across all result pages.
  async searchPackages(options = {}) {
    const packages = [];
    let offset = 0;

    while (true) {
      const parameters = [];
      if (options.query) {
        parameters.push(`q=${encodeURIComponent(options.query)}`);
      }
      parameters.push(`limit=${SEARCH_PAGE_SIZE}`, `offset=${offset}`);
      if (options.scope) {
        parameters.push(`scope=${encodeURIComponent(options.scope)}`);
      }

      const response = await registryFetch(this.registryUrl, `/v1/packages?${parameters.join("&")}`);
      if (!response.ok) {
        throw new Error(
          `Failed to search the Sof registry (${response.status}): ${await readErrorMessage(response)}`
        );
      }

      const page = await response.json();
      if (!page || !Array.isArray(page.packages)) {
        throw new Error("Unexpected response from the Sof registry search.");
      }

      packages.push(...page.packages);
      const total = Number(page.total) || 0;
      if (page.packages.length === 0 || offset + SEARCH_PAGE_SIZE >= total) {
        return packages;
      }
      offset += SEARCH_PAGE_SIZE;
    }
  }

  // Resolves to { state: "published", ... } or { state: "quarantined", findings }; the latter
  // means the registry accepted the upload but is holding it for admin review.
  async publishPackage(packageEntry, archivePath, checksum) {
    const token = this.getToken();
    if (!token) {
      throw new Error(NOT_SIGNED_IN);
    }

    const { scope, name } = splitPackageName(packageEntry.name);
    const metadata = Buffer.from(
      JSON.stringify({
        name: packageEntry.name,
        version: packageEntry.version,
        realm: packageEntry.realm,
        description: packageEntry.description,
        license: packageEntry.license,
        authors: packageEntry.authors,
        dependencies: dependenciesArrayToObject(packageEntry.dependencies),
        checksum,
      }),
      "utf8"
    );

    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32BE(metadata.length, 0);
    const body = Buffer.concat([lengthPrefix, metadata, fs.readFileSync(archivePath)]);

    const response = await registryFetch(this.registryUrl, "/v1/publish", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-sof-publish",
      },
      body,
    });

    if (!response.ok) {
      throw publishFailure(packageEntry, response, await readErrorMessage(response));
    }

    let reply = {};
    try {
      reply = (await response.json()) || {};
    } catch (_err) {
      // A success without a readable body still counts as success.
    }

    const result = {
      packageName: packageEntry.name,
      version: packageEntry.version,
      indexPath: path.posix.join("index", scope.toLowerCase(), `${name.toLowerCase()}.json`),
      artifactPath: path.posix.join(
        "packages",
        scope.toLowerCase(),
        name.toLowerCase(),
        `${packageEntry.version}.tar.gz`
      ),
    };

    if (response.status === 202 || reply.state === "quarantined") {
      return {
        ...result,
        state: "quarantined",
        findings: Array.isArray(reply.findings) ? reply.findings : [],
      };
    }

    return { ...result, state: "published" };
  }
}

module.exports = {
  SofProvider,
  heldForReviewLines,
  isSafeArtifactPath,
  readErrorMessage,
  registryFetch,
};
