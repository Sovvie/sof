"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { ensureRokit } = require("../rokit/bootstrap");
const { runRokit } = require("../rokit/executor");
const { addToolToConfig, prepareRokitManifest } = require("../rokit/manifest");
const { scaffoldToolConfigs } = require("../rokit/tool-configs");

const HELP_TEXT = `
sof run tools - Manage external tools via Rokit

USAGE:
  sof run tools <command> [arguments] [options]

COMMANDS:
  install
    sof run tools install [path/to/sof.toml]
    Generate internal rokit.toml from [tools], then run rokit install
    OPTIONS:
      -h, --help                      Show install command help

  list
    sof run tools list [path/to/sof.toml]
    Generate internal rokit.toml from [tools], then run rokit list
    OPTIONS:
      -h, --help                      Show list command help

  add
    sof run tools add <owner/repo> [path/to/sof.toml] [--alias <name>]
    Resolve latest release tag, add [tools] entry, and run tools install
    OPTIONS:
      --alias <name>                  Override alias written into [tools]
      -h, --help                      Show add command help

  setup
    sof run tools setup
    Download the built-in Rokit and put its tool folder (~/.rokit/bin) on PATH.
    Runs automatically on first install; the sof installer runs it too.

  self-update
    sof run tools self-update
    Redownload/update Sof-managed Rokit binary
    OPTIONS:
      -h, --help                      Show self-update command help

  rokit
    sof run tools rokit <arguments...>
    Run the built-in Rokit directly (you shouldn't normally need this)
`;

const INSTALL_HELP_TEXT = `
sof run tools install - Install tools from [tools] in sof.toml

USAGE:
  sof run tools install [path/to/sof.toml]

OPTIONS:
  -h, --help                      Show this help message
`;

const LIST_HELP_TEXT = `
sof run tools list - List installed tools via Rokit

USAGE:
  sof run tools list [path/to/sof.toml]

OPTIONS:
  -h, --help                      Show this help message
`;

const ADD_HELP_TEXT = `
sof run tools add - Add a tool to [tools] in sof.toml

USAGE:
  sof run tools add <owner/repo> [path/to/sof.toml] [--alias <name>]

OPTIONS:
  --alias <name>                  Override alias written into [tools]
  -h, --help                      Show this help message
`;

const SELF_UPDATE_HELP_TEXT = `
sof run tools self-update - Update Sof-managed Rokit binary

USAGE:
  sof run tools self-update

OPTIONS:
  -h, --help                      Show this help message
`;

function displayPath(targetPath) {
  const relativePath = path.relative(process.cwd(), targetPath);
  if (relativePath.startsWith("..")) {
    const fromHome = path.relative(os.homedir(), targetPath);
    return fromHome.startsWith("..") ? targetPath : path.join("~", fromHome);
  }
  return relativePath || ".";
}

function createGithubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "sof-cli",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const token = process.env.GITHUB_TOKEN;
  if (typeof token === "string" && token.trim() !== "") {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  return headers;
}

function parseConfigArgs(argv, commandName) {
  const output = {
    configPath: null,
    help: false,
  };

  const positional = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option for tools ${commandName}: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error(`tools ${commandName} accepts at most one positional argument (the config path).`);
  }

  output.configPath = positional[0] || null;
  return output;
}

function parseAddArgs(argv) {
  const output = {
    toolId: null,
    alias: null,
    configPath: null,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--alias") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--alias requires a value.");
      }
      output.alias = value.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option for tools add: ${arg}`);
    }

    positional.push(arg);
  }

  if (!output.help && positional.length === 0) {
    throw new Error("tools add requires a tool identifier in the form owner/repo.");
  }

  if (positional.length > 2) {
    throw new Error(
      "tools add accepts one required positional argument (<owner/repo>) and one optional config path."
    );
  }

  output.toolId = positional[0] || null;
  output.configPath = positional[1] || null;
  return output;
}

function parseSelfUpdateArgs(argv) {
  const output = {
    help: false,
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }
    throw new Error(`Unknown argument for tools self-update: ${arg}`);
  }

  return output;
}

function parseToolId(toolIdRaw) {
  const raw = String(toolIdRaw || "").trim();
  const withoutProvider = raw.startsWith("github:") ? raw.slice("github:".length) : raw;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(withoutProvider);
  if (!match) {
    throw new Error(`Invalid tool identifier "${raw}". Expected "owner/repo".`);
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}

async function fetchLatestReleaseVersion(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const response = await fetch(url, {
    headers: createGithubHeaders(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to resolve latest release for ${owner}/${repo} ` +
        `(${response.status} ${response.statusText})` +
        (body ? `: ${body.slice(0, 200)}` : "")
    );
  }

  const release = await response.json();
  const resolvedVersion = String(release.tag_name || release.name || "").trim().replace(/^v/i, "");
  if (!resolvedVersion) {
    throw new Error(`Latest release for ${owner}/${repo} did not include a usable tag/version.`);
  }

  return resolvedVersion;
}

const ROKIT_BIN_DIR = path.join(os.homedir(), ".rokit", "bin");
const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";

// Rokit runs tools through links in ~/.rokit/bin, which `rokit self-install` creates and adds to
// PATH. sof ships its own Rokit binary, so it does that setup itself: users never install Rokit.
async function ensureRokitSetup(cwd) {
  const bootstrapResult = await ensureRokit();
  const rokitLink = path.join(ROKIT_BIN_DIR, `rokit${EXE_SUFFIX}`);

  if (bootstrapResult.didDownload || !fs.existsSync(rokitLink)) {
    console.log("Setting up Rokit (tool folder ~/.rokit/bin, added to PATH)...");
    const setupExitCode = await runRokit(["self-install"], cwd || process.cwd());
    if (setupExitCode !== 0) {
      console.warn(
        `  ! Rokit self-install exited with ${setupExitCode}. Continuing because Sof invokes Rokit directly.`
      );
    }
    return { ...bootstrapResult, didSetup: true };
  }

  return { ...bootstrapResult, didSetup: false };
}

function normalizeDir(directory) {
  const resolved = path.resolve(directory);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// Another toolchain manager (Aftman, Foreman) earlier on PATH would shadow the Rokit links with
// its own copies of rojo/selene/..., which then ignore the versions pinned in sof.toml.
function findShadowedTools(toolAliases) {
  const directories = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const rokitIndex = directories.findIndex((directory) => normalizeDir(directory) === normalizeDir(ROKIT_BIN_DIR));
  const searchUntil = rokitIndex === -1 ? directories.length : rokitIndex;
  const shadowed = [];

  for (const alias of toolAliases) {
    for (const directory of directories.slice(0, searchUntil)) {
      const candidates = process.platform === "win32" ? [`${alias}.exe`, `${alias}.cmd`, `${alias}.bat`] : [alias];
      const found = candidates.map((name) => path.join(directory, name)).find((file) => fs.existsSync(file));
      if (found) {
        shadowed.push({ alias, path: found });
        break;
      }
    }
  }

  return { shadowed, rokitOnPath: rokitIndex !== -1 };
}

function printPathWarnings(toolAliases, didSetup) {
  const { shadowed, rokitOnPath } = findShadowedTools(toolAliases);

  if (!rokitOnPath) {
    console.log(
      didSetup
        ? "Tools are ready. Open a new terminal so ~/.rokit/bin is on your PATH."
        : `  ! ${displayPath(ROKIT_BIN_DIR)} isn't on PATH in this terminal. Open a new one, or run: sof run tools setup`
    );
  }

  for (const entry of shadowed) {
    console.warn(
      `  ! "${entry.alias}" resolves to ${entry.path} before sof's version. ` +
        `Remove that copy or move ${displayPath(ROKIT_BIN_DIR)} earlier on PATH.`
    );
  }
}

async function runRokitCommand(args, cwd, commandLabel) {
  const exitCode = await runRokit(args, cwd);
  if (exitCode !== 0) {
    throw new Error(`Rokit ${commandLabel} failed with exit code ${exitCode}.`);
  }
}

function printScaffoldSummary(scaffoldResult) {
  if (scaffoldResult.created.length > 0) {
    console.log("Created tool config file(s):");
    for (const fileName of scaffoldResult.created) {
      console.log(`  ✓ ${fileName}`);
    }
  }

  if (scaffoldResult.skippedExisting.length > 0) {
    console.log("Skipped existing tool config file(s):");
    for (const fileName of scaffoldResult.skippedExisting) {
      console.log(`  - ${fileName}`);
    }
  }
}

async function runToolsInstall(configPathArg) {
  const manifest = prepareRokitManifest(configPathArg);
  const toolAliases = Object.keys(manifest.tools);

  console.log(`Using config: ${displayPath(manifest.configPath)}`);
  if (toolAliases.length === 0) {
    console.log("No [tools] entries were found. Skipping tool installation.");
    return {
      skipped: true,
      configPath: manifest.configPath,
      toolAliases: [],
      scaffoldResult: {
        created: [],
        skippedExisting: [],
      },
    };
  }

  console.log(`Generated internal manifest: ${displayPath(manifest.rokitManifestPath)}`);

  const setupResult = await ensureRokitSetup(manifest.configDirectory);

  await runRokitCommand(["install", "--no-trust-check"], manifest.configDirectory, "install");

  const scaffoldResult = scaffoldToolConfigs(manifest.configDirectory, toolAliases);
  printScaffoldSummary(scaffoldResult);
  printPathWarnings(toolAliases, setupResult.didSetup);

  return {
    skipped: false,
    configPath: manifest.configPath,
    toolAliases,
    scaffoldResult,
  };
}

async function runInstall(argv) {
  const args = parseConfigArgs(argv, "install");
  if (args.help) {
    console.log(INSTALL_HELP_TEXT);
    process.exit(0);
  }

  await runToolsInstall(args.configPath);
}

async function runList(argv) {
  const args = parseConfigArgs(argv, "list");
  if (args.help) {
    console.log(LIST_HELP_TEXT);
    process.exit(0);
  }

  const manifest = prepareRokitManifest(args.configPath);
  const toolAliases = Object.keys(manifest.tools);
  console.log(`Using config: ${displayPath(manifest.configPath)}`);

  if (toolAliases.length === 0) {
    console.log("No [tools] entries were found.");
    return;
  }

  console.log(`Generated internal manifest: ${displayPath(manifest.rokitManifestPath)}`);
  await runRokitCommand(["list"], manifest.configDirectory, "list");
}

async function runAdd(argv) {
  const args = parseAddArgs(argv);
  if (args.help) {
    console.log(ADD_HELP_TEXT);
    process.exit(0);
  }

  const tool = parseToolId(args.toolId);
  const latestVersion = await fetchLatestReleaseVersion(tool.owner, tool.repo);
  const alias = args.alias || tool.repo.toLowerCase();
  const specifier = `${tool.owner}/${tool.repo}@${latestVersion}`;
  const addResult = addToolToConfig(args.configPath, alias, specifier);

  if (addResult.replaced) {
    console.log(`Updated [tools].${addResult.alias} = "${addResult.specifier}"`);
  } else {
    console.log(`Added [tools].${addResult.alias} = "${addResult.specifier}"`);
  }
  console.log(`Config: ${displayPath(addResult.configPath)}`);

  await runToolsInstall(addResult.configPath);
}

async function runSelfUpdate(argv) {
  const args = parseSelfUpdateArgs(argv);
  if (args.help) {
    console.log(SELF_UPDATE_HELP_TEXT);
    process.exit(0);
  }

  const result = await ensureRokit({ forceDownload: true });
  console.log(`Rokit ${result.version || "(unknown version)"} is ready at ${result.binaryPath}`);
}

async function runSetup(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const result = await ensureRokitSetup(process.cwd());
  const version = result.version ? ` ${result.version}` : "";
  console.log(`Rokit${version} is set up; tools install into ${displayPath(ROKIT_BIN_DIR)}.`);
  printPathWarnings([], result.didSetup);
}

async function runRokitPassthrough(argv) {
  const exitCode = await runRokit(argv, process.cwd());
  process.exitCode = exitCode;
}

async function runTools(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "-h" || command === "--help") {
    console.log(HELP_TEXT);
    process.exit(command ? 0 : 1);
  }

  if (command === "install") {
    await runInstall(rest);
    return;
  }

  if (command === "list") {
    await runList(rest);
    return;
  }

  if (command === "add") {
    await runAdd(rest);
    return;
  }

  if (command === "self-update") {
    await runSelfUpdate(rest);
    return;
  }

  if (command === "setup") {
    await runSetup(rest);
    return;
  }

  if (command === "rokit") {
    await runRokitPassthrough(rest);
    return;
  }

  throw new Error(`Unknown tools command: ${command}`);
}

module.exports = {
  ensureRokitSetup,
  runTools,
  runToolsInstall,
};
