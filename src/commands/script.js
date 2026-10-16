"use strict";

const os = require("os");
const path = require("path");

const { ask } = require("../account/grants");
const { safeText } = require("../safe-text");
const { findScript, findScriptsTable } = require("../scripts/parse");
const { buildPlan, outline, planCommands, planShape } = require("../scripts/plan");
const { resolveScript, runPlan } = require("../scripts/runner");
const { definitionHash, trust, trustStatus, untrust } = require("../scripts/trust");

const HELP_TEXT = `
sof run script - Run the project's own commands from [scripts] in sof.toml

USAGE:
  sof run script <name> [arguments...]    Run a script (the arguments go on the end of its last command)
  sof run script --watch <name> [args]    Run it, then again whenever files matching its watch globs change
  sof run script list                     Show the scripts and whether you have trusted them
  sof run script trust [name...]          Say yes to scripts (needs a terminal); all of them if none is named
  sof run script untrust [name...]        Take that back

IN sof.toml:
  [scripts]
  build = "rojo build -o game.rbxl"
  check = ["stylua --check src", "selene src"]      # in order, stopping at the first that fails

  # A table adds pipelines. depends run first (once each, even if several scripts need them), then run.
  lint  = { run = "selene src", watch = ["src/**"] }
  test  = "lune run tests"
  ci    = { depends = ["lint", "test"], parallel = true, run = "rojo build -o game.rbxl", description = "what CI runs" }

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
  - A script is limited in size (25 commands, 1000 characters each, 3000 in all, counting the scripts
    it depends on) so the whole of it fits on the screen when you are asked. Your yes covers the
    whole pipeline: change a script anywhere in it and sof asks again.
  - --watch only polls the files matching "watch" globs (relative to sof.toml). It re-reads sof.toml
    before every run and stops if the pipeline is no longer one you trusted. Stop it with Ctrl+C.
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

// Everything that has to be true for a script to run, worked out before anything runs: the script
// and the scripts it depends on, every command resolved to an exact program, and the trust state of
// the whole.
function prepare(found, name) {
  const plan = buildPlan(found, name);
  const tools = {};
  const nodes = plan.nodes.map((node) => {
    const resolved = resolveScript({ name: node.name, commands: node.commands }, found.directory);
    Object.assign(tools, resolved.tools);
    return { ...node, steps: resolved.steps };
  });

  const hash = definitionHash(planCommands(plan).map((command) => command.argv), tools, planShape(plan));
  return {
    script: found.scripts[name],
    plan: { ...plan, nodes },
    outline: outline(plan),
    resolved: { tools },
    hash,
    status: trustStatus(found.directory, name, hash),
  };
}

function headline(found, name, prepared) {
  return `The script "${name}" in ${safeText(found.file)} ${prepared.status === "changed" ? "has changed since you trusted it" : "hasn't been trusted yet"}`;
}

function describeForPrompt(found, name, prepared) {
  const tools = Object.entries(prepared.resolved.tools).map(([alias, specifier]) => `${alias} = ${specifier}`);
  return [
    `${headline(found, name, prepared)}. It would run:`,
    ...prepared.outline,
    tools.length > 0 ? `with these tools: ${tools.join(", ")}` : "",
    "A script runs programs on this computer with your permissions: say yes only to ones you have read.",
  ].filter(Boolean);
}

async function runNamed(argv, deps) {
  let args = argv;
  let watch = false;
  if (args[0] === "--watch") {
    watch = true;
    args = args.slice(1);
  }
  const [name, ...rest] = args;
  if (!name || name.startsWith("-")) {
    throw new Error("Name the script to run: sof run script [--watch] <name> [arguments...]");
  }
  // `sof run script build -- --flag`: a lone leading -- only separates, like in npm.
  const extraArguments = rest[0] === "--" ? rest.slice(1) : rest;
  const found = findScript(name);
  if (!found) {
    throw new Error(`There is no script "${name}" in a sof.toml here or in a folder above it. See: sof run script list`);
  }

  const prepared = prepare(found, name);
  if (extraArguments.length > 0 && prepared.plan.nodes[prepared.plan.nodes.length - 1].steps.length === 0) {
    throw new Error(`The script "${name}" has no commands of its own, so there is nothing to pass the arguments to.`);
  }
  if (watch && prepared.plan.watch.length === 0) {
    throw new Error(`The script "${name}" has no watch globs: add watch = ["src/**"] to it (or to a script it depends on) to use --watch.`);
  }

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

  if (watch) {
    await watchLoop(found, name, prepared, extraArguments, deps);
    return;
  }

  process.exitCode = await runPlan(prepared.plan, { directory: found.directory, extraArguments });
}

// Runs the pipeline, then again each time a watched file changes. sof.toml is read again before
// every run: if the pipeline is no longer the one that was trusted (a git pull edited it), it stops.
async function watchLoop(found, name, first, extraArguments, deps) {
  const { snapshot, waitForChange } = deps.watch || require("../scripts/watch");
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);

  try {
    let prepared = first;
    let current = found;
    for (;;) {
      const before = snapshot(prepared.plan.watch, current.directory);
      const code = await runPlan(prepared.plan, { directory: current.directory, extraArguments });
      if (stopped) {
        break;
      }
      console.error(code === 0 ? "sof: done. Watching for changes (Ctrl+C to stop)..." : `sof: failed (exit ${code}). Watching for changes (Ctrl+C to stop)...`);

      const change = await waitForChange(prepared.plan.watch, current.directory, before, {
        shouldStop: () => stopped,
        ...(deps.watchTiming || {}),
      });
      if (!change) {
        break;
      }

      const shown = change.files.slice(0, 3).map((file) => safeText(file)).join(", ");
      console.error(`sof: ${shown}${change.files.length > 3 ? ` and ${change.files.length - 3} more` : ""} changed.`);

      current = findScript(name, current.directory) || current;
      prepared = prepare(current, name);
      if (prepared.hash !== first.hash && process.env.SOF_TRUST_SCRIPTS !== "1") {
        console.error(`sof: "${name}" is no longer the pipeline you trusted, so watching stopped. Read it with: sof run script list`);
        process.exitCode = 1;
        return;
      }
    }
  } finally {
    process.off("SIGINT", stop);
  }
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
      const own = prepared.script.commands;
      const first = own.length > 0 ? summarize(own[0].text) : `runs ${prepared.script.depends.join(", ")}`;
      const more = own.length > 1 ? ` (+${own.length - 1} more)` : "";
      const after = own.length > 0 && prepared.script.depends.length > 0 ? ` after ${prepared.script.depends.join(", ")}${prepared.script.parallel ? " (at once)" : ""}` : "";
      const note = prepared.script.description ? `  - ${prepared.script.description}` : "";
      status = `${{ trusted: "trusted", changed: "changed since trusted", untrusted: "not trusted" }[prepared.status].padEnd(21)}  ${first}${more}${after}${note}`;
    } catch (err) {
      status = `can't run: ${err.message.replace(/^script "[^"]*":? ?/, "")}`;
    }
    // Names and messages come from the file: show control characters, don't send them to the terminal.
    console.log(`  ${safeText(name).padEnd(width)}  ${safeText(status)}`);
  }
}

async function runScript(argv, deps = {}) {
  const resolvedDeps = { ask: deps.ask || ask, interactive: deps.interactive || defaultInteractive, watch: deps.watch, watchTiming: deps.watchTiming };
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
