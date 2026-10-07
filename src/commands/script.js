"use strict";

const os = require("os");
const path = require("path");

const { ask } = require("../account/grants");
const { safeText } = require("../safe-text");
const { findScript, findScriptsTable } = require("../scripts/parse");
const { resolveScript, runSteps } = require("../scripts/runner");
const { definitionHash, trust, trustStatus, untrust } = require("../scripts/trust");

const HELP_TEXT = `
sof run script - Run the project's own commands from [scripts] in sof.toml

USAGE:
  sof run script <name> [arguments...]    Run a script (the arguments go on the end of its last command)
  sof run script list                     Show the scripts and whether you have trusted them
  sof run script trust [name...]          Say yes to scripts (needs a terminal); all of them if none is named
  sof run script untrust [name...]        Take that back

IN sof.toml:
  [scripts]
  build = "rojo build -o game.rbxl"
  check = ["stylua --check src", "selene src"]      # in order, stopping at the first that fails

SAFETY:
  - A script is a list of commands started directly, with no shell: no pipes, redirects, chaining
    or variable expansion (an unquoted | & ; < > ( ) $ \` % is refused rather than guessed at).
  - A command runs a tool from [tools] (at the version pinned there), or sof to set the project up
    (sof run install, package install|check|outdated|search, tools install|list|outdated|doctor|
    which|lock), and nothing else: no paths, no programs found on PATH, no publishing or sign-in.
  - The first run of a script shows its commands and asks. Your yes covers those commands and the
    tool versions they run; if either changes (a git pull, say), sof asks again. It does not
    cover files the commands read, such as a lune script.
  - sof never runs a script by itself: not on install, not on update.
  - Without a terminal (CI, an AI agent) a script that isn't trusted is refused, and so is
    trusting one. For a CI job you control, SOF_TRUST_SCRIPTS=1 skips the check.
  - A script is limited in size (25 commands, 1000 characters each, 3000 in all) so the whole
    of it fits on the screen when you are asked.
`;

function displayPath(targetPath) {
  const relativePath = path.relative(process.cwd(), targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    const fromHome = path.relative(os.homedir(), targetPath);
    return fromHome.startsWith("..") || path.isAbsolute(fromHome) ? targetPath : path.join("~", fromHome);
  }
  return relativePath || ".";
}

function defaultInteractive() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

// Everything that has to be true for a script to run, worked out before anything runs.
function prepare(found, name) {
  const problem = found.problems.find((entry) => entry.name === name);
  if (problem) {
    throw new Error(problem.message);
  }

  const script = found.scripts[name];
  if (!script) {
    throw new Error(`There is no script "${name}" in ${found.file}.`);
  }

  const resolved = resolveScript(script, found.directory);
  const hash = definitionHash(script.commands.map((command) => command.argv), resolved.tools);
  return { script, resolved, hash, status: trustStatus(found.directory, name, hash) };
}

function headline(found, name, prepared) {
  return `The script "${name}" in ${safeText(found.file)} ${prepared.status === "changed" ? "has changed since you trusted it" : "hasn't been trusted yet"}`;
}

function describeForPrompt(found, name, prepared) {
  const tools = Object.entries(prepared.resolved.tools).map(([alias, specifier]) => `${alias} = ${specifier}`);
  return [
    `${headline(found, name, prepared)}. It would run:`,
    ...prepared.script.commands.map((command, index) => `  ${index + 1}. ${command.text}`),
    tools.length > 0 ? `with these tools: ${tools.join(", ")}` : "",
    "A script runs programs on this computer with your permissions: say yes only to ones you have read.",
  ].filter(Boolean);
}

async function runNamed(argv, deps) {
  const [name, ...rest] = argv;
  // `sof run script build -- --flag`: a lone leading -- only separates, like in npm.
  const extraArguments = rest[0] === "--" ? rest.slice(1) : rest;
  const found = findScript(name);
  if (!found) {
    throw new Error(`There is no script "${name}" in a sof.toml here or in a folder above it. See: sof run script list`);
  }

  const prepared = prepare(found, name);
  if (prepared.status !== "trusted" && process.env.SOF_TRUST_SCRIPTS !== "1") {
    if (!deps.interactive()) {
      // The way around this for CI is in the README and the help, not here: this text is what an
      // AI agent reads, and it should be told to ask, not handed the bypass.
      throw new Error(
        `${headline(found, name, prepared)}, so it wasn't run. Read it with: sof run script list. ` +
          `Then ask the user to say yes in their own terminal: sof run script trust ${name}.`
      );
    }

    if (!(await deps.ask(`${describeForPrompt(found, name, prepared).join("\n")}\nTrust it and run it? [y/N] `))) {
      console.error("Not trusted: nothing was run.");
      process.exitCode = 1;
      return;
    }
    trust(found.directory, name, prepared.hash);
  }

  process.exitCode = await runSteps(prepared.resolved.steps, { directory: found.directory, extraArguments });
}

async function runTrust(names, deps) {
  if (!deps.interactive()) {
    throw new Error(
      "Trusting a script needs a terminal, on purpose. Ask the user to run this in their own terminal: sof run script trust" +
        (names.length > 0 ? ` ${names.join(" ")}` : "")
    );
  }

  const found = findScriptsTable();
  if (!found) {
    throw new Error("There is no [scripts] table in a sof.toml here or in a folder above it.");
  }

  for (const name of names.length > 0 ? names : found.names) {
    if (!found.names.includes(name)) {
      throw new Error(`There is no script "${name}" in ${found.file}.`);
    }

    const prepared = prepare(found, name);
    if (prepared.status === "trusted") {
      console.log(`"${name}" is already trusted.`);
      continue;
    }

    if (await deps.ask(`${describeForPrompt(found, name, prepared).join("\n")}\nTrust it? [y/N] `)) {
      trust(found.directory, name, prepared.hash);
      console.log(`Trusted "${name}".`);
    } else {
      console.log(`Left "${name}" untrusted.`);
    }
  }
}

function runUntrust(names) {
  const found = findScriptsTable();
  if (!found) {
    throw new Error("There is no [scripts] table in a sof.toml here or in a folder above it.");
  }

  let removed = 0;
  if (names.length === 0) {
    removed = untrust(found.directory);
  } else {
    for (const name of names) {
      removed += untrust(found.directory, name);
    }
  }

  console.log(removed > 0 ? `Removed your trust from ${removed} script(s).` : "None of those scripts was trusted.");
}

function summarize(text) {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function runList() {
  const found = findScriptsTable();
  if (!found) {
    console.log("There is no [scripts] table in a sof.toml here or in a folder above it.");
    return;
  }

  console.log(`Scripts in ${safeText(displayPath(found.file))}`);
  if (found.names.length === 0) {
    console.log("  (none)");
    return;
  }

  const width = Math.max(...found.names.map((name) => name.length));
  for (const name of found.names) {
    let status;
    try {
      const prepared = prepare(found, name);
      const first = summarize(prepared.script.commands[0].text);
      const more = prepared.script.commands.length > 1 ? ` (+${prepared.script.commands.length - 1} more)` : "";
      status = `${{ trusted: "trusted", changed: "changed since trusted", untrusted: "not trusted" }[prepared.status].padEnd(21)}  ${first}${more}`;
    } catch (err) {
      status = `can't run: ${err.message.replace(/^script "[^"]*":? ?/, "")}`;
    }
    // Names and messages come from the file: show control characters, don't send them to the terminal.
    console.log(`  ${safeText(name).padEnd(width)}  ${safeText(status)}`);
  }
}

async function runScript(argv, deps = {}) {
  const resolvedDeps = { ask: deps.ask || ask, interactive: deps.interactive || defaultInteractive };
  const [first, ...rest] = argv;

  if (!first || first === "-h" || first === "--help" || first === "help") {
    console.log(HELP_TEXT);
    process.exit(first ? 0 : 1);
  }

  if (first === "list") {
    runList();
  } else if (first === "trust") {
    await runTrust(rest, resolvedDeps);
  } else if (first === "untrust") {
    runUntrust(rest);
  } else {
    await runNamed(argv, resolvedDeps);
  }
}

module.exports = { runScript };
