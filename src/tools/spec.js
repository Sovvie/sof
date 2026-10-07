"use strict";

// "owner/repo@version" (or "github:owner/repo@version"): how [tools] in sof.toml names a tool.
// sof.toml may come from a repository you just cloned, so everything here ends up as a file name
// or a folder name under ~/.sof and is checked accordingly.

const NAME_PART = "[A-Za-z0-9_][A-Za-z0-9_.-]*";
const OWNER_REPO_PATTERN = new RegExp(`^(${NAME_PART})/(${NAME_PART})$`);
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const WINDOWS_DEVICE_PATTERN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// A shim named after a tool goes in ~/.sof/bin, which sits on PATH (first, on macOS and Linux), so a
// sof.toml from a cloned repository must not be able to claim the name of a program that sof, its
// shims or the user's shell depend on: [tools] node = "evil/node@1" would otherwise run evil's
// binary every time sof or any script starts node.
const RESERVED_ALIASES = new Set([
  "node", "nodejs", "npm", "npx", "corepack", "yarn", "pnpm", "bun", "deno",
  "sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "cmd", "powershell", "pwsh", "conhost",
  "env", "dirname", "basename", "cat", "ls", "cp", "mv", "rm", "mkdir", "chmod", "chown", "ln", "find", "xargs", "sed", "awk", "grep",
  "tar", "gzip", "gunzip", "unzip", "zip", "curl", "wget", "git", "ssh", "scp", "sudo", "su", "doas",
  "where", "which", "whoami", "reg", "setx", "taskkill", "tasklist", "msiexec", "rundll32", "wscript", "cscript", "mshta",
  "python", "python3", "pip", "pip3", "ruby", "perl", "php", "java", "make", "cargo", "rustc", "go", "dotnet",
  "gh", "code", "code-insiders", "cursor", "docker", "podman", "kubectl", "helm", "terraform", "aws", "az", "gcloud",
  "brew", "apt", "apt-get", "dnf", "yum", "pacman", "winget", "choco", "scoop", "rustup", "openssl", "gpg",
  "ssh-keygen", "ssh-add", "ssh-agent", "sftp", "rsync", "nc", "ncat", "telnet", "ftp", "vim", "vi", "nano", "emacs", "less", "more", "tmux",
  "ping", "nslookup", "ipconfig", "netsh", "net", "sc", "schtasks", "wmic", "certutil", "bitsadmin", "regsvr32", "explorer",
]);

// "sof", and every file sof keeps next to the shims (sof.cmd, sof.ps1, sof-shim.cfg, ...).
const SOF_OWN_NAME_PATTERN = /^sof([.-]|$)/i;

function normalizeAlias(alias, contextLabel) {
  if (typeof alias !== "string" || alias.trim() === "") {
    throw new Error(`${contextLabel}: tool alias must be a non-empty string.`);
  }

  const normalized = alias.trim();
  if (!ALIAS_PATTERN.test(normalized) || WINDOWS_DEVICE_PATTERN.test(normalized)) {
    throw new Error(
      `${contextLabel}: tool alias "${normalized}" must start with a letter or number and may only contain letters, numbers, ".", "_" and "-".`
    );
  }

  if (RESERVED_ALIASES.has(normalized.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "")) || SOF_OWN_NAME_PATTERN.test(normalized)) {
    throw new Error(`${contextLabel}: "${normalized}" is reserved (it names a program sof or your shell relies on) and can't be used as a tool alias.`);
  }

  return normalized;
}

// { owner, repo, version }; version never carries a leading "v" (sof tries both tags).
function parseToolSpecifier(specifier, contextLabel = "tool") {
  const raw = String(specifier == null ? "" : specifier).trim().replace(/^github:/, "");
  const atIndex = raw.lastIndexOf("@");
  const match = atIndex > 0 ? OWNER_REPO_PATTERN.exec(raw.slice(0, atIndex)) : null;
  const version = atIndex > 0 ? raw.slice(atIndex + 1).replace(/^v(?=\d)/i, "") : "";

  if (!match || !VERSION_PATTERN.test(version)) {
    throw new Error(`${contextLabel}: "${raw}" must use "owner/repo@version" (or "github:owner/repo@version").`);
  }

  return { owner: match[1], repo: match[2], version };
}

function normalizeSpecifier(specifier, contextLabel, aliasLabel) {
  if (typeof specifier !== "string" || specifier.trim() === "") {
    throw new Error(`${contextLabel}: [tools].${aliasLabel} must be a string like "owner/repo@version".`);
  }

  const normalized = specifier.trim();
  parseToolSpecifier(normalized, `${contextLabel}: [tools].${aliasLabel}`);
  return normalized;
}

// "owner/repo" or "owner/repo@version" as typed to `sof run tools add`.
function parseToolId(toolIdRaw) {
  const raw = String(toolIdRaw || "").trim().replace(/^github:/, "");
  const atIndex = raw.indexOf("@");
  const idPart = atIndex === -1 ? raw : raw.slice(0, atIndex);
  const match = OWNER_REPO_PATTERN.exec(idPart);
  if (!match) {
    throw new Error(`Invalid tool identifier "${toolIdRaw}". Expected "owner/repo" or "owner/repo@version".`);
  }

  const version = atIndex === -1 ? null : raw.slice(atIndex + 1).replace(/^v(?=\d)/i, "");
  if (version !== null && !VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid tool version "${raw.slice(atIndex + 1)}" in "${toolIdRaw}".`);
  }

  return { owner: match[1], repo: match[2], version };
}

function formatSpecifier({ owner, repo, version }) {
  return `${owner}/${repo}@${version}`;
}

module.exports = {
  formatSpecifier,
  normalizeAlias,
  normalizeSpecifier,
  parseToolId,
  parseToolSpecifier,
};
