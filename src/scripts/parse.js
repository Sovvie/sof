"use strict";

// [scripts] in sof.toml: named commands.
//
//   [scripts]
//   build = "rojo build -o game.rbxl"
//   check = ["stylua --check src", "selene src"]     # in order, stopping at the first that fails
//
// sof.toml can come from a repository you just cloned, so a script is data, never shell code:
//   - A command is split into arguments here and started directly. There is no shell, so there are
//     no pipes, redirects, chaining, substitution or variable expansion; the characters that would
//     mean those things in a shell are refused instead of quietly doing something else.
//   - The program is a bare name that has to be a tool from [tools] (or "sof"), never a path and
//     never a PATH lookup. That is checked when the script runs (src/scripts/runner.js).

const fs = require("fs");
const path = require("path");
const toml = require("smol-toml");

const SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
// `sof run script <word>` means these, so a script can't be called one of them.
const RESERVED_SCRIPT_NAMES = new Set(["list", "trust", "untrust", "help"]);
const PROGRAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Small on purpose: the whole script has to fit on one screen of the trust prompt, because a yes to
// something that scrolled out of view isn't informed.
const MAX_COMMANDS_PER_SCRIPT = 25;
const MAX_COMMAND_LENGTH = 1000;
const MAX_SCRIPT_LENGTH = 3000;

// Outside quotes these belong to a shell. Inside quotes they are just text.
const SHELL_CHARACTERS = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`", "%"]);

// Characters that print as nothing, move the cursor, or reorder text (control characters, zero-width
// and bidirectional marks, line separators). A script containing one could make the command shown
// in the trust prompt differ from the one that runs, so none is accepted; a tab is plain whitespace.
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The command as it will really run, for the trust prompt, `list` and the echo before it starts:
// built from the arguments, not from the text that was typed, so the two can't differ.
function formatCommand(argv) {
  return argv
    .map((argument) => {
      if (/^[A-Za-z0-9_@%+=:,./\\*?~-]+$/.test(argument)) {
        return argument;
      }
      if (!argument.includes('"')) {
        return `"${argument}"`;
      }
      return argument.includes("'") ? JSON.stringify(argument) : `'${argument}'`;
    })
    .join(" ");
}

// "rojo build -o 'my game.rbxl'" -> ["rojo", "build", "-o", "my game.rbxl"]. Whitespace separates
// arguments; "double" or 'single' quotes group (and are the only escape: a backslash is always a
// backslash, so Windows paths work, and a quote character can be written inside the other kind).
function splitCommand(text) {
  const argv = [];
  let current = "";
  let inToken = false;
  let quote = null;

  const push = () => {
    if (inToken) {
      argv.push(current);
    }
    current = "";
    inToken = false;
  };

  for (const character of String(text)) {
    if (character !== "\t" && HIDDEN_CHARACTER.test(character)) {
      const code = character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
      throw new Error(`contains an invisible or control character (U+${code}), which sof refuses so that what you read is what runs.`);
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      inToken = true;
    } else if (/\s/.test(character)) {
      push();
    } else if (SHELL_CHARACTERS.has(character) || (character === "#" && !inToken)) {
      throw new Error(
        `contains "${character}", which sof doesn't interpret: commands run without a shell. ` +
          `Put it in quotes if you mean it literally, or list commands in order as an array.`
      );
    } else {
      current += character;
      inToken = true;
    }
  }

  if (quote) {
    throw new Error(`has a ${quote} quote that is never closed.`);
  }
  push();

  if (argv.length === 0) {
    throw new Error("is empty.");
  }
  return argv;
}

function parseCommand(text, scriptName, position) {
  const where = `script "${scriptName}"${position === null ? "" : `, command ${position}`}`;
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error(`${where} must be a non-empty string.`);
  }
  if (text.length > MAX_COMMAND_LENGTH) {
    throw new Error(`${where} is longer than ${MAX_COMMAND_LENGTH} characters.`);
  }

  let argv;
  try {
    argv = splitCommand(text);
  } catch (err) {
    throw new Error(`${where} ${err.message}`);
  }

  if (!PROGRAM_PATTERN.test(argv[0])) {
    throw new Error(
      `${where} starts with "${argv[0]}": a script runs a tool from [tools] (or "sof") by its name, ` +
        `not a path or another program. Add the tool with: sof run tools add owner/repo`
    );
  }

  const shown = formatCommand(argv);
  if (shown.length > MAX_COMMAND_LENGTH) {
    throw new Error(`${where} is longer than ${MAX_COMMAND_LENGTH} characters.`);
  }

  return { text: shown, argv };
}

// value: a string (one command) or an array of strings (several, in order).
function parseScript(name, value) {
  if (!SCRIPT_NAME_PATTERN.test(name)) {
    throw new Error(`script name "${name}" must start with a letter or number and use only letters, numbers, ".", "_", ":" and "-" (64 characters at most).`);
  }
  if (RESERVED_SCRIPT_NAMES.has(name.toLowerCase())) {
    throw new Error(`script name "${name}" is reserved: "sof run script ${name}" is a command of its own.`);
  }

  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`script "${name}" must be a command (a string) or a non-empty array of commands.`);
  }
  if (list.length > MAX_COMMANDS_PER_SCRIPT) {
    throw new Error(`script "${name}" has more than ${MAX_COMMANDS_PER_SCRIPT} commands.`);
  }

  const commands = list.map((text, index) => parseCommand(text, name, typeof value === "string" ? null : index + 1));
  if (commands.reduce((total, command) => total + command.text.length, 0) > MAX_SCRIPT_LENGTH) {
    throw new Error(`script "${name}" is longer than ${MAX_SCRIPT_LENGTH} characters in all: split it up so it can be read in one go.`);
  }

  return { name, commands };
}

// Reads one sof.toml. { directory, names, scripts, problems }: names is every key under [scripts],
// scripts the ones that parse, problems { name, message } for the ones that don't (one bad script
// must not stop the others from running).
function readScriptsFile(file) {
  let table;
  try {
    table = toml.parse(fs.readFileSync(file, "utf8")).scripts;
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${err.message}`);
  }

  const result = { file, directory: path.dirname(file), names: [], scripts: {}, problems: [], hasTable: table !== undefined };
  if (table === undefined) {
    return result;
  }
  if (!isPlainObject(table)) {
    throw new Error(`[scripts] in ${file} must be a TOML table.`);
  }

  for (const [name, value] of Object.entries(table)) {
    result.names.push(name);
    try {
      result.scripts[name] = parseScript(name, value);
    } catch (err) {
      result.problems.push({ name, message: err.message });
    }
  }
  return result;
}

// The sof.toml files from this folder upwards that exist, nearest first.
function* configFilesFrom(startDirectory) {
  let directory = path.resolve(startDirectory);
  for (;;) {
    const file = path.join(directory, "sof.toml");
    if (fs.existsSync(file)) {
      yield file;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}

// The nearest sof.toml that defines this script, or null.
function findScript(name, startDirectory = process.cwd()) {
  for (const file of configFilesFrom(startDirectory)) {
    const read = readScriptsFile(file);
    if (read.names.includes(name)) {
      return read;
    }
  }
  return null;
}

// The nearest sof.toml that has a [scripts] table, or null.
function findScriptsTable(startDirectory = process.cwd()) {
  for (const file of configFilesFrom(startDirectory)) {
    const read = readScriptsFile(file);
    if (read.hasTable) {
      return read;
    }
  }
  return null;
}

module.exports = {
  formatCommand,
  findScript,
  findScriptsTable,
  parseScript,
  readScriptsFile,
  splitCommand,
};
