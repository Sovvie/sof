"use strict";

// Turns a parsed script into programs to start, and starts them. The program of every command is
// looked up in [tools] (or is sof itself) and run from its install folder as an exact path: nothing
// is found through PATH, so a script can't reach a program that merely happens to be installed
// (a shell, curl, powershell, ...), and a hostile PATH can't redirect it.

const path = require("path");

const { spawnTool } = require("../tools/exec");
const { findLockEntry, lockPathFor, readToolsLock } = require("../tools/lock");
const { findToolEntry } = require("../tools/resolve");
const { entryPoint } = require("../tools/shims");
const { formatSpecifier, normalizeAlias, parseToolSpecifier } = require("../tools/spec");
const { binDirectory, isToolInstalled, readInstallRecord, toolExecutablePath } = require("../tools/store");

// What a script may ask sof itself to do: set the project up. Not publish (that signs in as you),
// not add-ons (their code runs with your permissions), not `tools x` (it runs any release from
// GitHub), not sign-in or self update. The value is the subcommands allowed after the command,
// or null for any arguments.
const SOF_COMMANDS_FOR_SCRIPTS = {
  install: null,
  package: new Set(["install", "check", "outdated", "search"]),
  tools: new Set(["install", "list", "outdated", "doctor", "which", "lock"]),
};

// Beyond the command, only flags (--force, --frozen, --global, ...) are accepted: a value could be a
// path to some other sof.toml or sof.lock (even a \\server\share one, which makes Windows send
// your credentials to that server), so setup always happens on the project the script is in. Free
// text is accepted only for `package search`, whose words go to the registry, and a bare tool name
// for `tools which`.
const FLAG_PATTERN = /^--?[A-Za-z][A-Za-z-]*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function checkSofCommand(argv, scriptName) {
  const [, run, command, subcommand] = argv;
  const allowed = run === "run" && Object.prototype.hasOwnProperty.call(SOF_COMMANDS_FOR_SCRIPTS, command) ? SOF_COMMANDS_FOR_SCRIPTS[command] : undefined;

  if (allowed === undefined || (allowed !== null && !allowed.has(subcommand))) {
    throw new Error(
      `script "${scriptName}": a script can ask sof only to set the project up: ` +
        `sof run install, sof run package install|check|outdated|search, sof run tools install|list|outdated|doctor|which|lock ` +
        `(not "${argv.join(" ")}").`
    );
  }

  if (command === "package" && subcommand === "search") {
    return;
  }

  for (const argument of argv.slice(command === "install" ? 3 : 4)) {
    const accepted = FLAG_PATTERN.test(argument) || (command === "tools" && subcommand === "which" && TOOL_NAME_PATTERN.test(argument));
    if (!accepted) {
      throw new Error(
        `script "${scriptName}": "${argument}" isn't accepted after "sof ${argv.slice(1, command === "install" ? 3 : 4).join(" ")}": ` +
          `a script can pass only flags (like --force) to sof, never a path or another value.`
      );
    }
  }
}

// With a sof.tools.lock next to the sof.toml that pins the tool, what is installed must be what
// was locked: an unverified or swapped copy is never started from a script.
function checkAgainstLock(entry, spec, scriptName) {
  if (entry.global) {
    return;
  }

  const lock = readToolsLock(lockPathFor(entry.file));
  const expected = lock.exists ? findLockEntry(lock, spec) : null;
  if (!expected) {
    return;
  }

  const record = readInstallRecord(spec);
  if (!record || record.sha256 !== expected.sha256) {
    throw new Error(
      `script "${scriptName}": ${entry.alias} ${spec.version} doesn't match sof.tools.lock, so it isn't started. ` +
        `Reinstall it with: sof run tools install --force`
    );
  }
}

// script: { name, commands: [{ text, argv }] }; directory: the folder of the sof.toml that defines
// it (tools are looked up from there). Throws, before anything has run, if a command can't run.
// Returns { steps: [{ text, executable, args }], tools: { alias: "owner/repo@version" } }.
function resolveScript(script, directory) {
  const steps = [];
  const tools = {};

  for (const command of script.commands) {
    const program = command.argv[0];

    if (program.toLowerCase() === "sof") {
      checkSofCommand(command.argv, script.name);
      steps.push({ text: command.text, executable: process.execPath, args: [entryPoint(), ...command.argv.slice(1)] });
      continue;
    }

    const entry = findToolEntry(program, directory);
    if (!entry) {
      throw new Error(
        `script "${script.name}": "${program}" isn't listed under [tools]. A script can only run tools from [tools] ` +
          `(and sof itself). Add it with: sof run tools add owner/repo`
      );
    }

    // The same rules as `sof run tools install` (a [tools] entry named sh or powershell is not a tool).
    normalizeAlias(entry.alias, `${entry.file}: [tools]`);
    const spec = parseToolSpecifier(entry.specifier, `${entry.file}: [tools].${entry.alias}`);
    if (!isToolInstalled(spec)) {
      throw new Error(
        `script "${script.name}": ${entry.alias} ${spec.version} isn't installed yet. Run: sof run tools install` +
          (entry.global ? " --global" : "")
      );
    }

    checkAgainstLock(entry, spec, script.name);
    tools[entry.alias.toLowerCase()] = formatSpecifier(spec);
    steps.push({ text: command.text, executable: toolExecutablePath(spec), args: command.argv.slice(1) });
  }

  return { steps, tools };
}

// The environment a script runs in: the caller's, with sof's shim folder first on PATH so that a
// tool starting another tool (a lune script calling selene) gets the pinned version too.
function scriptEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  const key = Object.keys(environment).find((name) => name.toLowerCase() === "path") || "PATH";
  environment[key] = [binDirectory(), environment[key]].filter(Boolean).join(path.delimiter);
  return environment;
}

// Runs the steps in order from `directory`, stopping at the first that fails. extraArguments go on
// the end of the last command. Resolves to the exit code.
async function runSteps(steps, { directory, extraArguments = [], environment = scriptEnvironment() }) {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const last = index === steps.length - 1;
    const args = last ? [...step.args, ...extraArguments] : step.args;

    console.error(`> ${[step.text, ...(last ? extraArguments : [])].join(" ")}`);
    const code = await spawnTool(step.executable, args, { cwd: directory, env: environment });
    if (code !== 0) {
      console.error(`sof: "${step.text}" exited with ${code}${steps.length > 1 ? ` (step ${index + 1} of ${steps.length}); nothing after it ran` : ""}.`);
      return code;
    }
  }
  return 0;
}

module.exports = {
  resolveScript,
  runSteps,
  scriptEnvironment,
};
