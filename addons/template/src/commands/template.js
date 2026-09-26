"use strict";

const fs = require("fs");
const path = require("path");
const {
  REGISTRY_PATH,
  listTemplates,
  removeTemplate,
  saveTemplate,
  useTemplate,
} = require("../template/registry");

const DEFAULT_PROJECT_FILE_NAME = "default.project.json";

const HELP_TEXT = `
sof run template - Manage reusable project templates

USAGE:
  sof run template <command> [arguments] [options]

COMMANDS:
  save
    sof run template save [name] [path]
    Save a directory as a template
    OPTIONS:
      -h, --help                      Show save command help

  use
    sof run template use [name] as <project name> [--force]
    Create a project from a saved template
    OPTIONS:
      --force                         Allow template use in a non-empty destination
      -h, --help                      Show use command help

  list
    sof run template list
    List saved templates
    OPTIONS:
      -h, --help                      Show list command help

  remove
    sof run template remove [name]
    Remove a saved template
    OPTIONS:
      -h, --help                      Show remove command help
`;

function parseSaveArgs(argv) {
  const args = {
    name: null,
    sourcePath: null,
    help: false,
  };

  const positional = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 2) {
    throw new Error("template save accepts at most two positional arguments: [name] [path].");
  }

  args.name = positional[0] || null;
  args.sourcePath = positional[1] || null;
  return args;
}

function parseUseArgs(argv) {
  const args = {
    name: null,
    projectName: null,
    force: false,
    help: false,
  };

  const positional = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }

    if (arg === "--force") {
      args.force = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (args.help) {
    return args;
  }

  if (positional.length < 3) {
    throw new Error('template use requires: [name] as "Project Name".');
  }

  if (positional[1] !== "as") {
    throw new Error('template use syntax is: [name] as "Project Name".');
  }

  args.name = positional[0];
  args.projectName = positional.slice(2).join(" ").trim();
  if (!args.projectName) {
    throw new Error('template use requires a project name after "as".');
  }

  return args;
}

function parseListArgs(argv) {
  const args = {
    help: false,
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }

    throw new Error(`Unknown argument for template list: ${arg}`);
  }

  return args;
}

function parseRemoveArgs(argv) {
  const args = {
    name: null,
    help: false,
  };

  const positional = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("template remove accepts exactly one positional argument: [name].");
  }

  args.name = positional[0] || null;
  return args;
}

function promptYesNo(question) {
  const buffer = Buffer.alloc(1024);
  process.stdout.write(question);
  const bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
  if (bytesRead <= 0) {
    return false;
  }

  const answer = buffer.toString("utf8", 0, bytesRead).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function formatSavedDate(savedAt) {
  if (!savedAt) {
    return "unknown";
  }

  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toISOString().slice(0, 10);
}

function runSave(argv) {
  const args = parseSaveArgs(argv);
  if (args.help || !args.name) {
    console.log(HELP_TEXT);
    process.exit(args.help ? 0 : 1);
  }

  const result = saveTemplate(args.name, args.sourcePath);
  if (result.overwritten) {
    console.warn(`  ! Template "${result.name}" already existed and was overwritten.`);
  }

  console.log(`  ✓ Saved template "${result.name}" from ${result.sourcePath}`);
  console.log(`Registry: ${result.registryPath}`);
}

function runUse(argv) {
  const args = parseUseArgs(argv);
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const result = useTemplate(args.name, args.projectName, {
    force: args.force,
    confirmOverwrite: ({ destinationPath, entries }) => {
      console.warn(
        `  ! Destination directory "${destinationPath}" is not empty (${entries.length} entr${
          entries.length === 1 ? "y" : "ies"
        }).`
      );

      if (!process.stdin.isTTY) {
        throw new Error("Cannot prompt for overwrite confirmation without an interactive terminal.");
      }

      return promptYesNo("Continue and allow overwriting conflicting files? [y/N]: ");
    },
  });

  const relativeProjectPath = path.relative(process.cwd(), result.projectFilePath);
  const projectPathDisplay = relativeProjectPath || DEFAULT_PROJECT_FILE_NAME;

  console.log(`Using template "${result.name}" from ${result.sourcePath}`);
  console.log(`  ✓ Copied ${result.copiedFileCount} file(s) into ${result.destinationPath}`);
  console.log(`  ✓ Updated ${projectPathDisplay} with name "${args.projectName}"`);
  console.log("  ✓ Initialized a fresh git repository");
}

function runList(argv) {
  const args = parseListArgs(argv);
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const templates = listTemplates();
  if (templates.length === 0) {
    console.log("No templates saved.");
    return;
  }

  const longestName = templates.reduce((max, template) => Math.max(max, template.name.length), 0);
  console.log(`Saved templates (${REGISTRY_PATH}):`);

  for (const template of templates) {
    const name = template.name.padEnd(longestName, " ");
    const savedDate = formatSavedDate(template.savedAt);
    const templatePath = template.path || "<invalid path>";
    console.log(`  ${name}  ${templatePath}  (saved ${savedDate})`);
  }
}

function runRemove(argv) {
  const args = parseRemoveArgs(argv);
  if (args.help || !args.name) {
    console.log(HELP_TEXT);
    process.exit(args.help ? 0 : 1);
  }

  const result = removeTemplate(args.name);
  console.log(`Removed template "${result.name}".`);
}

function runTemplate(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "-h" || command === "--help") {
    console.log(HELP_TEXT);
    process.exit(command ? 0 : 1);
  }

  if (command === "save") {
    runSave(rest);
    return;
  }

  if (command === "use") {
    runUse(rest);
    return;
  }

  if (command === "list") {
    runList(rest);
    return;
  }

  if (command === "remove") {
    runRemove(rest);
    return;
  }

  throw new Error(`Unknown template command: ${command}`);
}

module.exports = {
  runTemplate,
};
