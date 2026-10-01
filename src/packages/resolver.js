"use strict";

const semver = require("semver");
const { parseDependencySpecifier } = require("./config");

function normalizePathForKey(pathValue) {
  return String(pathValue).replace(/\\/g, "/");
}

function createInstallKey(pathValue, alias) {
  return `${normalizePathForKey(pathValue)}::${alias}`;
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

function isYanked(entry) {
  return Boolean(entry && entry.metadata && entry.metadata.yanked === true);
}

function satisfiesAll(version, demands) {
  return demands.every((demand) =>
    semver.satisfies(version, demand.range, { includePrerelease: true })
  );
}

function describeDemands(demands) {
  return demands
    .map((demand) => `  - "${demand.range}" (as ${demand.alias}, from ${demand.requiredBy})`)
    .join("\n");
}

function findLockEntryByName(lockEntries, pathValue, name) {
  const normalized = normalizePathForKey(pathValue);
  return (
    (lockEntries || []).find(
      (entry) => normalizePathForKey(entry.path) === normalized && entry.name === name
    ) || null
  );
}

function addDemand(demandsByKey, demand) {
  const key = createInstallKey(demand.path, demand.name);
  let bucket = demandsByKey.get(key);
  if (!bucket) {
    bucket = { name: demand.name, path: demand.path, demands: [] };
    demandsByKey.set(key, bucket);
  }
  bucket.demands.push(demand);
}

// Resolves direct and transitive dependencies into one install per package name per
// path. The chosen version satisfies every range that asks for the package, and a
// package requested under several aliases is installed once (under its direct alias
// when it has one); dependents that used another alias get their requires rewritten
// (see aliasRewrites, applied by the linker).
async function resolveDependencyGraph(params) {
  const groups = params.groups || [];
  const registry = params.registry;
  const lockEntries = params.lockEntries || [];
  const frozen = params.frozen === true;

  if (!registry) {
    throw new Error("resolveDependencyGraph requires a registry instance.");
  }

  const directDemands = [];
  for (const group of groups) {
    for (const dependency of group.dependencies) {
      directDemands.push({
        ...dependency,
        path: group.path,
        requiredBy: "config",
        isDirect: true,
      });
    }
  }

  const packageCache = new Map();

  async function queryPackage(name, lockEntry) {
    const cacheKey = `${name}::${lockEntry ? lockEntry.source : ""}`;
    if (!packageCache.has(cacheKey)) {
      const options = lockEntry
        ? {
            preferredSource: lockEntry.source,
            allowFallback: !frozen,
            throwOnProviderFailure: frozen,
          }
        : { allowFallback: true };
      packageCache.set(cacheKey, await registry.queryPackage(name, options));
    }
    return packageCache.get(cacheKey);
  }

  let selections = new Map();
  const maxPasses = 64;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const demandsByKey = new Map();

    for (const demand of directDemands) {
      addDemand(demandsByKey, demand);
    }

    for (const selection of selections.values()) {
      const transitive = parseTransitiveDependencies(
        `${selection.name}@${selection.version}`,
        selection.dependencies
      );
      for (const dependency of transitive) {
        addDemand(demandsByKey, {
          ...dependency,
          path: selection.path,
          requiredBy: `${selection.name}@${selection.version}`,
          isDirect: false,
        });
      }
    }

    const nextSelections = new Map();

    for (const [key, bucket] of demandsByKey) {
      const lockEntry = findLockEntryByName(lockEntries, bucket.path, bucket.name);
      if (frozen && !lockEntry) {
        throw new Error(`--frozen failed: no lockfile entry for ${bucket.name} at path "${bucket.path}".`);
      }

      const packageEntry = await queryPackage(bucket.name, lockEntry);
      if (!packageEntry) {
        throw new Error(`Package ${bucket.name} was not found in any index.`);
      }

      // A yanked version stays downloadable so existing lockfiles keep working, but fresh
      // resolution never picks it: only the exact version a lockfile pins may stay.
      const isUsable = (entry) =>
        !isYanked(entry) || Boolean(lockEntry && lockEntry.version === entry.version);
      const available = packageEntry.versions.filter(
        (entry) => isUsable(entry) && satisfiesAll(entry.version, bucket.demands)
      );

      let chosen = null;
      if (lockEntry) {
        chosen = available.find((entry) => entry.version === lockEntry.version) || null;
        if (!chosen && frozen) {
          throw new Error(
            `--frozen failed: locked ${bucket.name}@${lockEntry.version} does not satisfy every requirement:\n` +
              describeDemands(bucket.demands)
          );
        }
      }
      if (!chosen) {
        const best = semver.maxSatisfying(
          available.map((entry) => entry.version),
          "*",
          { includePrerelease: true }
        );
        chosen = available.find((entry) => entry.version === best) || null;
      }
      if (!chosen) {
        const yankedMatches = packageEntry.versions.filter(
          (entry) => isYanked(entry) && satisfiesAll(entry.version, bucket.demands)
        );
        const yankedNote =
          yankedMatches.length > 0
            ? `\n(yanked and therefore skipped: ${yankedMatches.map((entry) => entry.version).join(", ")})`
            : "";
        throw new Error(
          `No version of ${bucket.name} satisfies every requirement at "${bucket.path}":\n` +
            describeDemands(bucket.demands) +
            yankedNote
        );
      }

      const directDemand = bucket.demands.find((demand) => demand.isDirect);

      nextSelections.set(key, {
        name: bucket.name,
        path: bucket.path,
        alias: directDemand ? directDemand.alias : bucket.demands[0].alias,
        source: packageEntry.source,
        version: chosen.version,
        metadata: chosen.metadata || {},
        dependencies: chosen.dependencies || {},
        isDirect: Boolean(directDemand),
        lockEntry,
      });
    }

    const stable =
      nextSelections.size === selections.size &&
      Array.from(nextSelections).every(([key, selection]) => {
        const previous = selections.get(key);
        return previous && previous.version === selection.version && previous.alias === selection.alias;
      });

    selections = nextSelections;

    if (stable) {
      break;
    }

    if (pass === maxPasses) {
      throw new Error(`Dependency resolution did not settle after ${maxPasses} passes.`);
    }
  }

  // Two different packages can't be installed under the same alias in one folder.
  const aliasOwners = new Map();
  for (const selection of selections.values()) {
    const aliasKey = createInstallKey(selection.path, selection.alias.toLowerCase());
    const owner = aliasOwners.get(aliasKey);
    if (owner && owner !== selection.name) {
      throw new Error(
        `Dependency alias collision at path "${selection.path}": alias "${selection.alias}" maps to both "${owner}" and "${selection.name}".`
      );
    }
    aliasOwners.set(aliasKey, selection.name);
  }

  const entries = Array.from(selections.values()).map((selection) => {
    const aliasRewrites = {};
    for (const dependency of parseTransitiveDependencies(selection.name, selection.dependencies)) {
      const installed = selections.get(createInstallKey(selection.path, dependency.name));
      if (installed && installed.alias !== dependency.alias) {
        aliasRewrites[dependency.alias] = installed.alias;
      }
    }

    const lockEntry = selection.lockEntry;
    return {
      alias: selection.alias,
      name: selection.name,
      path: selection.path,
      source: selection.source,
      version: selection.version,
      dependencies: selection.dependencies,
      aliasRewrites,
      expectedChecksum:
        typeof selection.metadata.checksum === "string" && selection.metadata.checksum.trim() !== ""
          ? selection.metadata.checksum.trim()
          : null,
      lockedChecksum:
        lockEntry &&
        lockEntry.version === selection.version &&
        typeof lockEntry.checksum === "string" &&
        lockEntry.checksum.trim() !== ""
          ? lockEntry.checksum.trim()
          : null,
      isDirect: selection.isDirect,
    };
  });

  entries.sort((a, b) => {
    const pathComparison = a.path.localeCompare(b.path);
    return pathComparison !== 0 ? pathComparison : a.alias.localeCompare(b.alias);
  });

  return {
    entries,
  };
}

module.exports = {
  isYanked,
  resolveDependencyGraph,
};
