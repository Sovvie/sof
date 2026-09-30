"use strict";

// Creates the GitHub release v<version> and uploads dist/sof-<version>.zip, install.ps1 and
// install.sh to it (run `npm run release` first). Safe to re-run: an existing release is reused
// and assets that are already attached are skipped.
//
// Auth: GITHUB_TOKEN / GH_TOKEN, else the token git itself has stored for github.com.

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const { version } = require(path.join(root, "package.json"));
const repository = process.env.SOF_CLI_REPO || "sovvie/sof";
const tag = `v${version}`;
const assets = [path.join(root, "dist", `sof-${version}.zip`), path.join(root, "install.ps1"), path.join(root, "install.sh")];

function findToken() {
  const fromEnvironment = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnvironment) {
    return fromEnvironment.trim();
  }

  const result = childProcess.spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const match = /^password=(.+)$/m.exec(result.stdout || "");
  if (!match) {
    throw new Error("No GitHub token: set GITHUB_TOKEN, or sign in to github.com through git.");
  }
  return match[1].trim();
}

async function api(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "sof-release",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  return response;
}

async function ensureRelease(token) {
  const existing = await api(token, `https://api.github.com/repos/${repository}/releases/tags/${tag}`);
  if (existing.ok) {
    console.log(`Release ${tag} already exists; reusing it.`);
    return existing.json();
  }

  const created = await api(token, `https://api.github.com/repos/${repository}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: `sof ${version}`, generate_release_notes: true }),
  });
  if (!created.ok) {
    throw new Error(`Couldn't create release ${tag} (${created.status}): ${(await created.text()).slice(0, 300)}`);
  }
  console.log(`Created release ${tag}.`);
  return created.json();
}

async function main() {
  for (const asset of assets) {
    if (!fs.existsSync(asset)) {
      throw new Error(`Missing ${path.relative(root, asset)}. Run "npm run release" first.`);
    }
  }

  const token = findToken();
  const release = await ensureRelease(token);
  const attached = new Set((release.assets || []).map((asset) => asset.name));
  const uploadUrl = release.upload_url.replace(/\{.*$/, "");

  for (const asset of assets) {
    const name = path.basename(asset);
    if (attached.has(name)) {
      console.log(`  - ${name} already attached`);
      continue;
    }

    const uploaded = await api(token, `${uploadUrl}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": name.endsWith(".zip") ? "application/zip" : "text/plain" },
      body: fs.readFileSync(asset),
    });
    if (!uploaded.ok) {
      throw new Error(`Couldn't upload ${name} (${uploaded.status}): ${(await uploaded.text()).slice(0, 300)}`);
    }
    console.log(`  ✓ ${name}`);
  }

  console.log(`Released: ${release.html_url}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
