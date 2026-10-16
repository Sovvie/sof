"use strict";

// A script and everything it depends on, worked out as data before anything runs: the order the
// scripts run in, and the commands the trust prompt has to show. A plain script (a command or a
// list of commands) is a plan of one script.

const MAX_COMMANDS = 25;
const MAX_LENGTH = 3000;

// found: the result of readScriptsFile ({ scripts, problems, file }). Returns
//   { root, nodes: [{ name, script, depends, parallel, commands }], watch: [globs] }
// with nodes in the order they first run (dependencies before the scripts that need them).
function buildPlan(found, rootName) {
  const nodes = [];
  const seen = new Set();

  const visit = (name, chain) => {
    const problem = found.problems.find((entry) => entry.name === name);
    if (problem) {
      throw new Error(problem.message);
    }
    const script = found.scripts[name];
    if (!script) {
      throw new Error(
        chain.length === 0
          ? `There is no script "${name}" in ${found.file}.`
          : `script "${chain[chain.length - 1]}" depends on "${name}", which isn't a script in ${found.file}.`
      );
    }
    if (chain.includes(name)) {
      throw new Error(`scripts depend on each other in a circle: ${[...chain.slice(chain.indexOf(name)), name].join(" -> ")}.`);
    }
    if (seen.has(name)) {
      return;
    }

    for (const dependency of script.depends) {
      visit(dependency, [...chain, name]);
    }
    seen.add(name);
    nodes.push({ name, script, depends: script.depends, parallel: script.parallel, commands: script.commands });
  };

  visit(rootName, []);

  const commandCount = nodes.reduce((total, node) => total + node.commands.length, 0);
  const length = nodes.reduce((total, node) => total + node.commands.reduce((sum, command) => sum + command.text.length, 0), 0);
  if (commandCount > MAX_COMMANDS || length > MAX_LENGTH) {
    throw new Error(
      `script "${rootName}" and the scripts it depends on are more than ${MAX_COMMANDS} commands or ${MAX_LENGTH} characters in all: ` +
        `split it up so everything it runs can be read in one go.`
    );
  }

  const watch = [...new Set(nodes.flatMap((node) => node.script.watch))];
  return { root: rootName, nodes, watch };
}

// A plan of one script with nothing around it.
function isSimple(plan) {
  const [node] = plan.nodes;
  return plan.nodes.length === 1 && node.depends.length === 0 && !node.parallel;
}

// What goes into the trust hash besides the commands: how the scripts are put together. Nothing
// for a simple script, so a yes given before pipelines existed still holds.
function planShape(plan) {
  if (isSimple(plan)) {
    return undefined;
  }
  return plan.nodes.map((node) => ({
    name: node.name,
    depends: node.depends,
    parallel: node.parallel,
    commands: node.commands.length,
  }));
}

function planCommands(plan) {
  return plan.nodes.flatMap((node) => node.commands);
}

// Lines for the trust prompt: each script in the order it first runs, what it waits for, its commands.
function outline(plan) {
  if (isSimple(plan)) {
    return plan.nodes[0].commands.map((command, index) => `  ${index + 1}. ${command.text}`);
  }

  const lines = [];
  for (const node of plan.nodes) {
    const waits =
      node.depends.length === 0
        ? ""
        : `, after ${node.depends.join(", ")}${node.parallel && node.depends.length > 1 ? " (those at the same time)" : ""}`;
    lines.push(`  [${node.name}]${waits}${node.commands.length === 0 ? "" : ":"}`);
    node.commands.forEach((command, index) => lines.push(`    ${index + 1}. ${command.text}`));
  }
  return lines;
}

module.exports = {
  buildPlan,
  isSimple,
  outline,
  planCommands,
  planShape,
};
