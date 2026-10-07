"use strict";

const path = require("path");

const { findAddonForCommand, readManifest } = require("./addons/store");
const { safeText } = require("./safe-text");

const HELP_TEXT = `
sof - Roblox package manager and project tooling

USAGE:
  sof <command> [arguments] [options]
  sof --help [run] <command ...>

COMMANDS:
  run install [config]                            Install packages and tools from sof.toml
  run package install [config]                    Install packages from sof.toml
  run package publish [config]                    Publish package(s) from sof.toml
  run package check [config]                      Validate package require alias integrity
  run package outdated [config]                   Show available package updates
  run package search <query>                      Search the registry and Wally
  run package login|logout|whoami                 Sign in to the registry (needed to publish)
  run account login|logout|whoami|grants|revoke   Your sov.gg sign-in (private add-ons; add-ons use it without seeing it)
  run package owner add|remove <scope> <user>     Manage who may publish to a scope
  run package yank|unyank <scope/name> <version>  Hide a version from new installs
  run tools install|add|remove|update|list|...    Tools (rojo, selene, ...) pinned per project in sof.toml
  run script <name>|list|trust|untrust            Project commands from [scripts] in sof.toml (no shell; trusted first)
  run addon list|add|remove|update|publish        Optional features (docs, video, uploader, ...)
  run self update                                 Update sof itself

OPTIONS:
  -h, --help                         Show this help message
  --version                          Show version

EXTENDED HELP:
  sof run <command> --help
  sof run <command> <subcommand> --help
`;

function helpText() {
  let addons = [];
  try {
    addons = Object.values(readManifest().addons);
  } catch {
    addons = [];
  }

  if (addons.length === 0) {
    return `${HELP_TEXT}\nADD-ONS:\n  none installed - see "sof run addon list"\n`;
  }

  const lines = addons
    .sort((a, b) => a.command.localeCompare(b.command))
    .map((addon) => `  run ${(addon.usage || addon.command).padEnd(44)} ${addon.description}`);

  return `${HELP_TEXT}\nADD-ONS:\n${lines.join("\n")}\n`;
}

async function runExtendedHelp(argv) {
  let tokens = argv.slice();
  if (tokens[0] === "run") {
    tokens = tokens.slice(1);
  }

  while (tokens[0] === "help" || tokens[0] === "-h" || tokens[0] === "--help") {
    tokens = tokens.slice(1);
  }

  if (tokens.length === 0) {
    console.log(helpText());
    process.exit(0);
  }

  await runRunCommand([...tokens, "--help"]);
}

const BUILT_IN = {
  install: () => require("./commands/install").runInstall,
  package: () => require("./commands/package").runPackage,
  account: () => require("./commands/account").runAccount,
  tools: () => require("./commands/tools").runTools,
  script: () => require("./commands/script").runScript,
  addon: () => require("./commands/addon").runAddon,
  self: () => require("./commands/self").runSelf,
};

async function runRunCommand(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command) {
    console.log(helpText());
    process.exit(1);
  }

  if (command === "-h" || command === "--help" || command === "help") {
    if (rest.length === 0) {
      console.log(helpText());
      process.exit(0);
    }
    await runExtendedHelp(rest);
    return;
  }

  if (BUILT_IN[command]) {
    await BUILT_IN[command]()(rest);
    return;
  }

  const addon = findAddonForCommand(command);
  if (addon) {
    // An add-on that opted in ("sandbox": true) runs in a restricted child process and uses the
    // sov.gg account through sof, never holding the login. The rest run in this process.
    let sandboxed = false;
    try {
      sandboxed = require("./addons/store").readAddonDescriptor(addon.directory).sandbox === true;
    } catch {
      sandboxed = false;
    }
    if (sandboxed) {
      await require("./addons/run-sandboxed").runSandboxed(addon, rest);
      return;
    }

    const module = require(path.join(addon.directory, addon.entry));
    const run = module[addon.export || "run"];
    if (typeof run !== "function") {
      throw new Error(`Add-on "${addon.name}" doesn't export a "${addon.export || "run"}" function.`);
    }
    await run(rest);
    return;
  }

  console.error(`Unknown command "${command}". If it's an add-on, install it: sof run addon add ${command}`);
  console.log(helpText());
  process.exit(1);
}

async function runCli(argv) {
  const command = argv[0];

  if (!command) {
    console.log(helpText());
    process.exit(1);
  }

  if (command === "help" || command === "-h" || command === "--help") {
    await runExtendedHelp(argv.slice(1));
    return;
  }

  if (command === "--version") {
    const pkg = require("../package.json");
    console.log(pkg.version);
    process.exit(0);
  }

  if (command !== "run") {
    console.error(`Unknown command: ${command}`);
    console.log(helpText());
    process.exit(1);
  }

  try {
    await runRunCommand(argv.slice(1));
  } catch (err) {
    // exitCode rather than exit(): exiting while a fetch socket closes aborts Node on Windows.
    console.error(`Error: ${safeText(err.message)}`);
    process.exitCode = 1;
  }
}

module.exports = { runCli };
