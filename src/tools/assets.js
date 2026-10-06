"use strict";

// Picks the release asset that runs on this machine, by name: Roblox tools don't follow one
// naming scheme (rojo-7.4.1-windows-x86_64.zip, selene-0.27.1-windows.zip, wally-v0.3.2-win64.zip,
// luau-lsp-win64.zip, stylua-linux-x86_64-musl.zip, ...), so each asset is scored.

const OS_PATTERNS = {
  windows: /(?:^|[^a-z])(?:windows|win(?:32|64)?)(?:[^a-z]|$)/,
  macos: /(?:^|[^a-z])(?:macos|mac|osx|darwin)(?:[^a-z]|$)/,
  linux: /(?:^|[^a-z])(?:linux|ubuntu)(?:[^a-z]|$)/,
};

// Checked in this order: "x86_64" must win over its "x86" prefix.
const ARCH_PATTERNS = [
  ["arm64", /(?:^|[^a-z0-9])(?:aarch64|arm64|armv8)(?:[^a-z0-9]|$)/],
  ["x64", /(?:^|[^a-z0-9])(?:x86[_-]64|x64|amd64|intel64|win64)(?:[^a-z0-9]|$)/],
  ["x86", /(?:^|[^a-z0-9])(?:x86|i?[3-6]86|ia32|win32)(?:[^a-z0-9]|$)/],
  ["other", /(?:^|[^a-z0-9])(?:armv[5-7][a-z]*|arm|riscv64|ppc64(?:le)?|s390x|mips[a-z0-9]*)(?:[^a-z0-9]|$)/],
];

const TOOLCHAIN_PATTERN = /(?:^|[^a-z0-9])(gnu|musl|msvc)(?:[^a-z0-9]|$)/;

// Words that describe the platform or the build rather than a different program, so they don't
// count against an asset (selene-light-* is a different program, selene-* is the one asked for).
const NEUTRAL_WORDS = new Set([
  "apple", "pc", "unknown", "release", "universal", "universal2", "static", "bin", "binary", "cli", "x", "v",
  "windows", "win", "macos", "mac", "osx", "darwin", "linux", "ubuntu", "gnu", "musl", "msvc",
]);

const ARCHIVE_SUFFIXES = [
  [/\.tar\.gz$/, "tar.gz"],
  [/\.tgz$/, "tar.gz"],
  [/\.tar\.xz$/, "tar.xz"],
  [/\.txz$/, "tar.xz"],
  [/\.zip$/, "zip"],
  [/\.tar$/, "tar"],
  [/\.gz$/, "gz"],
];

// Never a tool: checksums, signatures, docs, installers, other compression formats sof can't open.
const SKIPPED_SUFFIX_PATTERN =
  /\.(?:sha\d*|md5|sig|asc|pem|cert|txt|md|json|jsonl|sbom|spdx|sarif|msi|deb|rpm|dmg|pkg|apk|appimage|vsix|nupkg|whl|jar|xz|zst|bz2|7z|rar|sh|ps1|rbxm|rbxmx|rbxl|rbxlx|luau|lua|crate|pdb|dll|so|dylib|a|lib)$/;

function archiveFormat(name) {
  const lower = String(name).toLowerCase();
  for (const [pattern, format] of ARCHIVE_SUFFIXES) {
    if (pattern.test(lower)) {
      return format;
    }
  }

  if (SKIPPED_SUFFIX_PATTERN.test(lower)) {
    return null;
  }

  // Not an archive: a bare executable ("tool-linux-x86_64", "tool.exe").
  return /\.[a-z0-9]+$/.test(lower) && !lower.endsWith(".exe") ? null : "raw";
}

function detectOs(lowerName) {
  return Object.keys(OS_PATTERNS).find((osName) => OS_PATTERNS[osName].test(lowerName)) || null;
}

function detectArch(lowerName) {
  const found = ARCH_PATTERNS.find(([, pattern]) => pattern.test(lowerName));
  return found ? found[0] : null;
}

// Most to least wanted. null stands for a name that says nothing about the architecture.
function archPreference(osName, arch) {
  if (arch === "arm64") {
    // Windows on Arm and Apple silicon both run x64 builds.
    return osName === "linux" ? ["arm64", null] : ["arm64", "x64", null, "x86"];
  }
  if (arch === "x64") {
    return osName === "windows" ? ["x64", null, "x86"] : ["x64", null];
  }
  return [arch, null];
}

function toolchainRank(osName, toolchain) {
  if (osName === "linux") {
    // A static musl build runs on any distribution; a gnu build needs a recent enough glibc.
    return toolchain === "musl" ? 0 : toolchain === null ? 1 : 2;
  }
  if (osName === "windows") {
    return toolchain === "msvc" ? 0 : toolchain === null ? 1 : 2;
  }
  return 0;
}

function countExtraWords(lowerName, repo) {
  const repoWords = new Set(String(repo).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  // The file extension goes first: the patterns below also swallow the separator in front of it.
  let remainder = lowerName.replace(/\.(?:tar\.gz|tgz|tar\.xz|txz|zip|tar|gz|exe)$/, "");
  for (const [, pattern] of ARCH_PATTERNS) {
    remainder = remainder.replace(new RegExp(pattern.source, "g"), " ");
  }
  for (const pattern of Object.values(OS_PATTERNS)) {
    remainder = remainder.replace(new RegExp(pattern.source, "g"), " ");
  }

  return remainder
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !/^v?\d+$/.test(word) && !NEUTRAL_WORDS.has(word) && !repoWords.has(word)).length;
}

function formatRank(osName, format) {
  // tar.xz last: it needs a tar program that can read xz.
  const preferred =
    osName === "windows"
      ? ["zip", "raw", "tar.gz", "tar", "gz", "tar.xz"]
      : ["tar.gz", "zip", "tar", "raw", "gz", "tar.xz"];
  return preferred.indexOf(format);
}

// asset: a GitHub release asset ({ name, ... }). Returns { asset, format } or throws with the names it saw.
function pickAsset(assets, { repo, platform = process.platform, arch = process.arch, label = repo } = {}) {
  const osName = { win32: "windows", darwin: "macos", linux: "linux" }[platform];
  const wantedArch = { x64: "x64", arm64: "arm64", ia32: "x86" }[arch];
  if (!osName || !wantedArch) {
    throw new Error(`sof can't install tools on ${platform}/${arch}.`);
  }

  const preference = archPreference(osName, wantedArch);
  const candidates = [];
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (!asset || typeof asset.name !== "string") {
      continue;
    }

    const lowerName = asset.name.toLowerCase();
    const format = archiveFormat(lowerName);
    if (!format || detectOs(lowerName) !== osName) {
      continue;
    }

    const archRank = preference.indexOf(detectArch(lowerName));
    if (archRank === -1) {
      continue;
    }

    const toolchainMatch = TOOLCHAIN_PATTERN.exec(lowerName);
    candidates.push({
      asset,
      format,
      rank: [
        countExtraWords(lowerName, repo),
        archRank,
        toolchainRank(osName, toolchainMatch ? toolchainMatch[1] : null),
        formatRank(osName, format),
        lowerName.length,
      ],
    });
  }

  candidates.sort((a, b) => {
    for (let index = 0; index < a.rank.length; index += 1) {
      if (a.rank[index] !== b.rank[index]) {
        return a.rank[index] - b.rank[index];
      }
    }
    return 0;
  });

  if (candidates.length === 0) {
    const names = (Array.isArray(assets) ? assets : []).map((asset) => asset && asset.name).filter(Boolean);
    throw new Error(
      `${label} has no release asset for ${osName}/${wantedArch}` +
        (names.length > 0 ? ` (assets: ${names.join(", ")}).` : " (the release has no assets).")
    );
  }

  return { asset: candidates[0].asset, format: candidates[0].format };
}

module.exports = {
  archiveFormat,
  pickAsset,
};
