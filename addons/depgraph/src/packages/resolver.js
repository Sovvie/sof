"use strict";

const semver = require("semver");
const { parseDependencySpecifier } = require("./config");

function normalizePathForKey(pathValue) {
  return String(pathValue).replace(/\\/g, "/");
}

function createInstallKey(pathValue, alias) {
  return `${normalizePathForKey(pathValue)}::${alias}`;
}

function findMatchingLockEntry(lockEntries, dependency) {
  if (!Array.isArray(lockEntries) || lockEntries.length === 0) {
    return null;
  }

  const dependencyPath = normalizePathForKey(dependency.path);
  return (
    lockEntries.find(
      (entry) =>
        normalizePathForKey(entry.path) === dependencyPath &&
        entry.alias === dependency.alias &&
        entry.name === dependency.name
    ) || null
  );
}

function pickVersion(versions, requestedRange, lockedVersion) {
  const versionsByNumber = new Map();
  for (const versionEntry of versions) {
    if (versionEntry && typeof versionEntry.version === "string") {
      versionsByNumber.set(versionEntry.version, versionEntry);
    }
  }

  if (lockedVersion) {
    const lockedEntry = versionsByNumber.get(lockedVersion);
    if (!lockedEntry) {
      return null;
    }

    if (
      !semver.satisfies(lockedEntry.version, requestedRange, {
        includePrerelease: true,
      })
    ) {
      return null;
    }

    return lockedEntry;
  }

  const candidateVersion = semver.maxSatisfying(Array.from(versionsByNumber.keys()), requestedRange, {
    includePrerelease: true,
  });
  if (!candidateVersion) {
    return null;
  }

  return versionsByNumber.get(candidateVersion) || null;
}

function parseTransitiveDependencies(parentLabel, dependencyMap) {
  if (!dependencyMap || typeof dependencyMap !== "object" || Array.isArray(dependencyMap)) {
    return [];
  }

  const output = [];
  for (const [alias, specifier] of Object.entries(dependencyMap)) {
    output.push(parseDependencySpecifier(alias, specifier, parentLabel));
  }
  return output;
}

async function resolveFromRegistry(registry, dependency, options = {}) {
  const preferredSource = options.preferredSource || null;
  const lockedVersion = options.lockedVersion || null;
  const frozen = options.frozen === true;

  let packageEntry = null;
  if (preferredSource) {
    packageEntry = await registry.queryPackage(dependency.name, {
      preferredSource,
      allowFallback: !frozen,
      throwOnProviderFailure: frozen,
    });
  } else {
    packageEntry = await registry.queryPackage(dependency.name, {
      allowFallback: true,
    });
  }

  if (!packageEntry) {
    return null;
  }

  let selectedVersion = pickVersion(packageEntry.versions, dependency.range, lockedVersion);
  if (!selectedVersion && lockedVersion && !frozen) {
    const fallbackEntry = await registry.queryPackage(dependency.name, {
      allowFallback: true,
    });
    if (fallbackEntry) {
      packageEntry = fallbackEntry;
      selectedVersion = pickVersion(packageEntry.versions, dependency.range, null);
    }
  }

  if (!selectedVersion) {
    return null;
  }

  return {
    source: packageEntry.source,
    version: selectedVersion.version,
    metadata: selectedVersion.metadata || {},
    dependencies: selectedVersion.dependencies || {},
  };
}

async function resolveDependencyGraph(params) {
  const groups = params.groups || [];
  const registry = params.registry;
  const lockEntries = params.lockEntries || [];
  const frozen = params.frozen === true;

  if (!registry) {
    throw new Error("resolveDependencyGraph requires a registry instance.");
  }

  const queue = [];
  for (const group of groups) {
    for (const dependency of group.dependencies) {
      queue.push({
        ...dependency,
        path: group.path,
        isDirect: true,
      });
    }
  }

  const resolvedByInstallKey = new Map();
  while (queue.length > 0) {
    const dependency = queue.shift();
    const installKey = createInstallKey(dependency.path, dependency.alias);
    const existing = resolvedByInstallKey.get(installKey);

    if (existing) {
      if (existing.name !== dependency.name) {
        throw new Error(
          `Dependency alias collision at path "${dependency.path}": alias "${dependency.alias}" maps to both "${existing.name}" and "${dependency.name}".`
        );
      }

      if (
        !semver.satisfies(existing.version, dependency.range, {
          includePrerelease: true,
        })
      ) {
        throw new Error(
          `Locked dependency ${existing.name}@${existing.version} does not satisfy required range "${dependency.range}" for alias "${dependency.alias}".`
        );
      }

      continue;
    }

    const lockEntry = findMatchingLockEntry(lockEntries, dependency);
    if (frozen && !lockEntry) {
      throw new Error(
        `--frozen failed: no lockfile entry for ${dependency.alias} (${dependency.name}@${dependency.range}) at path "${dependency.path}".`
      );
    }

    let resolution = await resolveFromRegistry(registry, dependency, {
      preferredSource: lockEntry ? lockEntry.source : null,
      lockedVersion:
        lockEntry &&
        semver.satisfies(lockEntry.version, dependency.range, {
          includePrerelease: true,
        })
          ? lockEntry.version
          : null,
      frozen,
    });

    if (!resolution && lockEntry && frozen) {
      throw new Error(
        `--frozen failed: ${dependency.name}@${lockEntry.version} from "${lockEntry.source}" is unavailable or does not satisfy "${dependency.range}".`
      );
    }

    if (!resolution) {
      throw new Error(`No version found for ${dependency.name}@${dependency.range}.`);
    }

    const resolvedEntry = {
      alias: dependency.alias,
      name: dependency.name,
      path: dependency.path,
      source: resolution.source,
      version: resolution.version,
      dependencies: resolution.dependencies,
      expectedChecksum:
        resolution.metadata &&
        typeof resolution.metadata.checksum === "string" &&
        resolution.metadata.checksum.trim() !== ""
          ? resolution.metadata.checksum.trim()
          : null,
      lockedChecksum:
        lockEntry && typeof lockEntry.checksum === "string" && lockEntry.checksum.trim() !== ""
          ? lockEntry.checksum.trim()
          : null,
      isDirect: dependency.isDirect === true,
    };

    resolvedByInstallKey.set(installKey, resolvedEntry);

    const transitiveDependencies = parseTransitiveDependencies(
      `${dependency.name}@${resolution.version}`,
      resolution.dependencies
    );

    for (const transitiveDependency of transitiveDependencies) {
      queue.push({
        ...transitiveDependency,
        path: dependency.path,
        isDirect: false,
      });
    }
  }

  const entries = Array.from(resolvedByInstallKey.values()).sort((a, b) => {
    const pathComparison = a.path.localeCompare(b.path);
    if (pathComparison !== 0) {
      return pathComparison;
    }

    return a.alias.localeCompare(b.alias);
  });

  return {
    entries,
  };
}

module.exports = {
  resolveDependencyGraph,
};
