"use strict";

// What sof asks GitHub for when it installs a tool: a release (by tag, or the latest one) and
// one of its assets. GITHUB_TOKEN / GH_TOKEN, when set, only raise the API rate limit (or let a
// private repository's releases be read); they are sent to the API host and nowhere else.

const crypto = require("crypto");

const API_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const RELEASE_LIST_PAGE_SIZE = 100;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

// SOF_GITHUB_API_URL points sof at a GitHub Enterprise server or a mirror.
function apiBase() {
  return (process.env.SOF_GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

function githubToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
}

function apiHeaders(accept = "application/vnd.github+json") {
  const headers = {
    Accept: accept,
    "User-Agent": "sof-cli",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const token = githubToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function describeFailure(response, url, body) {
  if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const when = reset ? ` It resets at ${new Date(reset * 1000).toLocaleTimeString()}.` : "";
    return `GitHub's API rate limit is used up.${when} Set GITHUB_TOKEN to raise it.`;
  }

  return `GitHub request failed (${response.status} ${response.statusText}) for ${url}` + (body ? `: ${body.slice(0, 200)}` : "");
}

async function apiJson(url, { allowNotFound = false } = {}) {
  const response = await fetch(url, { headers: apiHeaders(), signal: AbortSignal.timeout(API_TIMEOUT_MS) });

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(describeFailure(response, url, await response.text().catch(() => "")));
  }

  return response.json();
}

function repoUrl(owner, repo, suffix) {
  return `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

async function latestRelease(owner, repo) {
  const release = await apiJson(repoUrl(owner, repo, "/releases/latest"), { allowNotFound: true });
  if (!release) {
    throw new Error(`${owner}/${repo} has no published release (or the repository doesn't exist).`);
  }
  return release;
}

// The version sof writes into sof.toml for the newest release: its tag without a leading "v".
async function latestVersion(owner, repo) {
  const release = await latestRelease(owner, repo);
  const version = String(release.tag_name || release.name || "").trim().replace(/^v(?=\d)/i, "");
  if (!version) {
    throw new Error(`The latest release of ${owner}/${repo} has no usable tag.`);
  }
  return version;
}

// Tags are usually "v1.2.3" or "1.2.3"; a few repositories prefix the tool name ("rojo-v1.2.3").
async function findRelease(owner, repo, version) {
  for (const tag of [`v${version}`, version]) {
    const release = await apiJson(repoUrl(owner, repo, `/releases/tags/${encodeURIComponent(tag)}`), { allowNotFound: true });
    if (release) {
      return release;
    }
  }

  const releases = await apiJson(repoUrl(owner, repo, `/releases?per_page=${RELEASE_LIST_PAGE_SIZE}`), { allowNotFound: true });
  const suffix = new RegExp(`(?:^|[^0-9.])v?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const match = (Array.isArray(releases) ? releases : []).find((release) => suffix.test(String(release.tag_name || "")));
  if (match) {
    return match;
  }

  throw new Error(`${owner}/${repo} has no release "${version}" (tried tags v${version} and ${version}).`);
}

// Returns the asset's bytes, checked against the size and sha256 GitHub reports for it.
async function downloadAsset(asset) {
  if (typeof asset.size === "number" && asset.size > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${asset.name} is ${Math.round(asset.size / 1048576)} MB, more than the 1 GiB sof will download for a tool.`);
  }

  const viaApi = githubToken() !== null && typeof asset.url === "string" && asset.url.startsWith(`${apiBase()}/`);
  const url = viaApi ? asset.url : asset.browser_download_url;
  if (typeof url !== "string" || url === "") {
    throw new Error(`Release asset ${asset.name} has no download address.`);
  }

  const response = await fetch(url, {
    headers: viaApi ? apiHeaders("application/octet-stream") : { "User-Agent": "sof-cli" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(describeFailure(response, url, await response.text().catch(() => "")));
  }

  if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${asset.name} is larger than the 1 GiB sof will download for a tool.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (typeof asset.size === "number" && asset.size > 0 && buffer.length !== asset.size) {
    throw new Error(`Download of ${asset.name} was cut short (${buffer.length} of ${asset.size} bytes).`);
  }

  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ""));
  if (digest && crypto.createHash("sha256").update(buffer).digest("hex") !== digest[1].toLowerCase()) {
    throw new Error(`Download of ${asset.name} doesn't match the checksum GitHub lists for it.`);
  }

  return buffer;
}

module.exports = {
  downloadAsset,
  findRelease,
  latestRelease,
  latestVersion,
};
