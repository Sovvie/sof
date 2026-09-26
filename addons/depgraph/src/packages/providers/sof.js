"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  SOF_INDEX_BRANCH,
  SOF_INDEX_REPO,
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

function dependenciesArrayToObject(dependencies) {
  const output = {};
  for (const dependency of dependencies || []) {
    output[dependency.alias] = dependency.specifier;
  }
  return output;
}

function runGitCommand(args, options = {}) {
  try {
    const stdout = childProcess.execFileSync("git", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return (stdout || "").trim();
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout).trim() : "";
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    const details = stderr || stdout || err.message;
    throw new Error(`git ${args.join(" ")} failed: ${details}`);
  }
}

class SofProvider {
  constructor(options = {}) {
    this.source = "sof";
    this.repository = options.repository || SOF_INDEX_REPO;
    this.branch = options.branch || SOF_INDEX_BRANCH;
  }

  getRawBaseUrl() {
    return `https://raw.githubusercontent.com/${this.repository}/${this.branch}`;
  }

  getRepositoryGitUrl() {
    return `https://github.com/${this.repository}.git`;
  }

  async queryPackage(packageName) {
    const { scope, name } = splitPackageName(packageName);
    const indexPath = path.posix.join("index", scope, `${name}.json`);
    const url = `${this.getRawBaseUrl()}/${indexPath}`;
    const response = await fetch(url);
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

    if (!parsed || typeof parsed !== "object" || typeof parsed.versions !== "object") {
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
      throw new Error(`Package ${packageName} was not found in Sof index "${this.repository}".`);
    }

    const selectedVersion = packageMetadata.versions.find(
      (candidate) => candidate.version === version
    );
    if (!selectedVersion) {
      throw new Error(`Package ${packageName}@${version} was not found in Sof index.`);
    }

    const { scope, name } = splitPackageName(packageName);
    const artifactPath =
      selectedVersion.metadata && typeof selectedVersion.metadata.artifact === "string"
        ? selectedVersion.metadata.artifact
        : path.posix.join("packages", scope, name, `${version}.tar.gz`);

    const artifactUrl = `${this.getRawBaseUrl()}/${artifactPath}`;
    const response = await fetch(artifactUrl);
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

  ensureRepositoryConfigured() {
    if (this.repository.includes("YOUR_USER/")) {
      throw new Error(
        `Set SOF_INDEX_REPO in src/packages/constants.js before publishing. Current value: ${this.repository}.`
      );
    }
  }

  resolveGitIdentity() {
    const name = runGitCommand(["config", "--get", "user.name"]);
    const email = runGitCommand(["config", "--get", "user.email"]);
    if (!name || !email) {
      throw new Error(
        `Git user identity is not configured. Set "user.name" and "user.email" in local/global git config.`
      );
    }

    return { name, email };
  }

  async publishPackage(packageEntry, archivePath, checksum) {
    this.ensureRepositoryConfigured();
    const gitIdentity = this.resolveGitIdentity();

    const { scope, name } = splitPackageName(packageEntry.name);
    const indexPath = path.posix.join("index", scope, `${name}.json`);
    const artifactPath = path.posix.join("packages", scope, name, `${packageEntry.version}.tar.gz`);

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sof-index-publish-"));
    const repositoryClonePath = path.join(temporaryDirectory, "index-repo");

    try {
      runGitCommand(["clone", this.getRepositoryGitUrl(), repositoryClonePath]);

      try {
        runGitCommand(["checkout", this.branch], { cwd: repositoryClonePath });
      } catch (_err) {
        runGitCommand(["checkout", "-b", this.branch], { cwd: repositoryClonePath });
      }

      runGitCommand(["config", "user.name", gitIdentity.name], { cwd: repositoryClonePath });
      runGitCommand(["config", "user.email", gitIdentity.email], { cwd: repositoryClonePath });

      const absoluteIndexPath = path.join(repositoryClonePath, indexPath);
      let indexData = {
        scope,
        name,
        versions: {},
      };

      if (fs.existsSync(absoluteIndexPath)) {
        try {
          indexData = JSON.parse(fs.readFileSync(absoluteIndexPath, "utf8"));
        } catch (err) {
          throw new Error(`Invalid JSON in existing index file "${indexPath}": ${err.message}`);
        }
      }

      if (!indexData.versions || typeof indexData.versions !== "object") {
        indexData.versions = {};
      }

      if (indexData.versions[packageEntry.version]) {
        throw new Error(
          `Package ${packageEntry.name}@${packageEntry.version} already exists in the Sof index.`
        );
      }

      indexData.versions[packageEntry.version] = {
        realm: packageEntry.realm,
        description: packageEntry.description,
        license: packageEntry.license,
        authors: packageEntry.authors,
        dependencies: dependenciesArrayToObject(packageEntry.dependencies),
        checksum,
        artifact: artifactPath,
        published: new Date().toISOString(),
      };

      fs.mkdirSync(path.dirname(absoluteIndexPath), { recursive: true });
      fs.writeFileSync(absoluteIndexPath, `${JSON.stringify(indexData, null, 2)}\n`, "utf8");

      const absoluteArtifactPath = path.join(repositoryClonePath, artifactPath);
      fs.mkdirSync(path.dirname(absoluteArtifactPath), { recursive: true });
      fs.copyFileSync(archivePath, absoluteArtifactPath);

      runGitCommand(["add", indexPath, artifactPath], { cwd: repositoryClonePath });
      runGitCommand(["commit", "-m", `Publish ${packageEntry.name}@${packageEntry.version}`], {
        cwd: repositoryClonePath,
      });
      runGitCommand(["push", "origin", this.branch], { cwd: repositoryClonePath });

      return {
        packageName: packageEntry.name,
        version: packageEntry.version,
        indexPath,
        artifactPath,
      };
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

module.exports = {
  SofProvider,
};
