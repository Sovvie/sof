"use strict";

const { SofProvider } = require("./providers/sof");
const { WallyProvider } = require("./providers/wally");

function createRegistry(options = {}) {
  const sofProvider = new SofProvider({
    token: options.token,
    registryUrl: options.registryUrl,
  });
  const wallyProvider = new WallyProvider();

  const providers = [sofProvider, wallyProvider];
  const providersBySource = new Map(providers.map((provider) => [provider.source, provider]));

  function getProviderOrder(preferredSource, allowFallback) {
    if (!preferredSource) {
      return providers.slice();
    }

    const preferredProvider = providersBySource.get(preferredSource);
    if (!preferredProvider) {
      throw new Error(`Unknown package source "${preferredSource}".`);
    }

    if (!allowFallback) {
      return [preferredProvider];
    }

    const remaining = providers.filter((provider) => provider.source !== preferredSource);
    return [preferredProvider, ...remaining];
  }

  async function queryPackage(packageName, options = {}) {
    const preferredSource = options.preferredSource || null;
    const allowFallback = options.allowFallback !== false;
    const throwOnProviderFailure = options.throwOnProviderFailure === true;

    const providerFailures = [];
    for (const provider of getProviderOrder(preferredSource, allowFallback)) {
      try {
        const result = await provider.queryPackage(packageName);
        if (result && Array.isArray(result.versions) && result.versions.length > 0) {
          return result;
        }
      } catch (err) {
        providerFailures.push({ source: provider.source, error: err });
      }
    }

    if (throwOnProviderFailure && providerFailures.length > 0) {
      const failureText = providerFailures
        .map((failure) => `${failure.source}: ${failure.error.message}`)
        .join("; ");
      throw new Error(`Failed to query package "${packageName}" (${failureText}).`);
    }

    return null;
  }

  async function downloadPackage(source, packageName, version) {
    const provider = providersBySource.get(source);
    if (!provider) {
      throw new Error(`Unknown package source "${source}" for ${packageName}@${version}.`);
    }

    return provider.downloadPackage(packageName, version);
  }

  async function publishPackage(packageEntry, archivePath, checksum) {
    return sofProvider.publishPackage(packageEntry, archivePath, checksum);
  }

  // Listing/search is a feature of the sof registry; Wally is searched through its index tree.
  async function searchPackages(searchOptions) {
    return sofProvider.searchPackages(searchOptions);
  }

  return {
    queryPackage,
    downloadPackage,
    publishPackage,
    searchPackages,
  };
}

module.exports = {
  createRegistry,
};
