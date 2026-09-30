"use strict";

const { runPackageInstall } = require("./package");
const { runToolsInstall } = require("./tools");
const MISSING_DEPENDENCIES_PATTERN = /must define at least one \[\[dependencies\]\] entry\./;

const HELP_TEXT = `
sof run install - Install packages and tools

USAGE:
  sof run install [path/to/sof.toml]

DESCRIPTION:
  Runs package install first, then tools install. Only what is new, changed or missing since
  the last run is downloaded or installed.

OPTIONS:
  --force                         Reinstall every package and re-run the tool install
  -h, --help                      Show this help message
`;

function parseArgs(argv) {
  const output = {
    configPath: null,
    force: false,
    help: false,
  };

  const positional = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--force") {
      output.force = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("install accepts at most one positional argument (the config path).");
  }

  output.configPath = positional[0] || null;
  return output;
}

async function runInstall(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const packageArgs = [...(args.force ? ["--force"] : []), ...(args.configPath ? [args.configPath] : [])];
  try {
    await runPackageInstall(packageArgs);
  } catch (err) {
    if (MISSING_DEPENDENCIES_PATTERN.test(String(err && err.message ? err.message : ""))) {
      console.log("No [[dependencies]] entries found. Skipping package install.");
    } else {
      throw err;
    }
  }

  await runToolsInstall(args.configPath, { force: args.force });
}

module.exports = {
  runInstall,
};
