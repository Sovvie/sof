"use strict";

// The hosts the sov.gg login may ever be used for, whatever an add-on asks for. Core decides this
// list; an add-on can only narrow it (its manifest names the hosts it needs, the user grants them).

const { SOF_REGISTRY_URL } = require("../packages/constants");

const BRIDGE_HOST = "roblox-sync.sov.gg";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

// SOF_ACCOUNT_EXTRA_HOSTS ("host:port,host") exists for tests against a local fake server.
function extraHosts() {
  return (process.env.SOF_ACCOUNT_EXTRA_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function registryHost(registryUrl = SOF_REGISTRY_URL) {
  try {
    return new URL(registryUrl).host.toLowerCase();
  } catch (_err) {
    return "";
  }
}

function ceilingHosts(registryUrl = SOF_REGISTRY_URL) {
  return new Set([registryHost(registryUrl), BRIDGE_HOST, ...extraHosts()].filter(Boolean));
}

// https only. The one exception is a loopback host that was added through SOF_ACCOUNT_EXTRA_HOSTS.
function schemeAllowed(url) {
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && LOOPBACK.has(url.hostname) && extraHosts().includes(url.host.toLowerCase());
}

module.exports = { BRIDGE_HOST, ceilingHosts, registryHost, schemeAllowed };
