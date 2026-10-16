"use strict";

// The part of the add-on host that needs nothing from sof: reading options, printing, asking.
// It requires only Node's built-ins, because a sandboxed add-on's process loads it too (the
// permission model lets it read this one file and nothing else of sof's).
//
//   run(argv, host) {
//     const { options, positional } = host.args.parse(argv, {
//       positional: { name: "input", min: 1 },
//       flags: { "--out": { key: "out", type: "string", alias: "-o" }, "--dry-run": { key: "dryRun" } },
//     });
//     host.log.info("working...");
//   }

function fail(message) {
  return new Error(message);
}

function wordsFor(flag) {
  return flag.replace(/^--?/, "");
}

// spec.flags: { "--name": { key, type: "boolean"|"string"|"number"|"integer", alias?, repeat?, default?, min?, max?, choices?, description? } }
// spec.positional: { name, min = 0, max = Infinity }. Everything after a lone "--" is positional.
// "--name=value" and "--name value" both work, and so does "--no-name" for a boolean.
function parseArgs(argv, spec = {}) {
  const flags = spec.flags || {};
  const byName = new Map();
  for (const [name, definition] of Object.entries(flags)) {
    byName.set(name, { name, ...definition });
    for (const alias of [].concat(definition.alias || [])) {
      byName.set(alias, { name, ...definition });
    }
  }

  const options = {};
  for (const definition of Object.values(flags)) {
    if (definition.default !== undefined) {
      options[definition.key] = definition.default;
    } else if (definition.repeat) {
      options[definition.key] = [];
    }
  }
  options.help = false;

  const positional = [];
  const input = argv.map(String);
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index];

    if (argument === "--") {
      positional.push(...input.slice(index + 1));
      break;
    }
    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("-") || argument === "-") {
      positional.push(argument);
      continue;
    }

    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const name = equals > 0 ? argument.slice(0, equals) : argument;
    let inline = equals > 0 ? argument.slice(equals + 1) : undefined;

    let definition = byName.get(name);
    let negated = false;
    if (!definition && name.startsWith("--no-")) {
      const base = byName.get(`--${name.slice(5)}`);
      if (base && (base.type || "boolean") === "boolean") {
        definition = base;
        negated = true;
      }
    }
    if (!definition) {
      throw fail(`Unknown option: ${name}`);
    }

    const type = definition.type || "boolean";
    if (type === "boolean") {
      if (inline !== undefined) {
        throw fail(`${definition.name} doesn't take a value.`);
      }
      options[definition.key] = !negated;
      continue;
    }

    let value = inline;
    if (value === undefined) {
      value = input[index + 1];
      if (value === undefined || (value.startsWith("-") && value.length > 1 && type === "string" && byName.has(value))) {
        throw fail(`${definition.name} needs a value.`);
      }
      index += 1;
    }

    if (type === "number" || type === "integer") {
      const parsed = Number(value);
      if (value.trim() === "" || !Number.isFinite(parsed) || (type === "integer" && !Number.isInteger(parsed))) {
        throw fail(`${definition.name} must be ${type === "integer" ? "a whole number" : "a number"}. Received: ${value}`);
      }
      if ((definition.min !== undefined && parsed < definition.min) || (definition.max !== undefined && parsed > definition.max)) {
        throw fail(`${definition.name} must be between ${definition.min ?? "-infinity"} and ${definition.max ?? "infinity"}. Received: ${value}`);
      }
      value = parsed;
    } else if (definition.choices && !definition.choices.includes(value)) {
      throw fail(`${definition.name} must be one of: ${definition.choices.join(", ")}. Received: ${value}`);
    }

    if (definition.repeat) {
      options[definition.key].push(value);
    } else {
      options[definition.key] = value;
    }
  }

  const rules = spec.positional || {};
  const min = rules.min || 0;
  const max = rules.max === undefined ? Infinity : rules.max;
  if (!options.help && positional.length < min) {
    throw fail(`Missing ${rules.name || "argument"}${min > 1 ? "s" : ""}.`);
  }
  if (positional.length > max) {
    throw fail(`Too many arguments (expected ${max === 0 ? "none" : `at most ${max}`}): ${positional.slice(max).join(" ")}`);
  }

  return { options, positional };
}

// A help text built from the same spec, so it can't drift from what is accepted.
function helpFor(name, spec = {}, summary = "") {
  const lines = [`sof run ${name}${summary ? ` - ${summary}` : ""}`, ""];
  const positional = spec.positional ? ` <${spec.positional.name || "argument"}${spec.positional.max === Infinity || (spec.positional.max || 0) > 1 ? "..." : ""}>` : "";
  lines.push("USAGE:", `  sof run ${name}${positional} [options]`, "", "OPTIONS:");
  const entries = Object.entries(spec.flags || {}).map(([flag, definition]) => {
    const names = [].concat(definition.alias || [], flag).join(", ");
    const value = (definition.type || "boolean") === "boolean" ? "" : ` <${definition.choices ? definition.choices.join("|") : definition.type}>`;
    return [`${names}${value}`, definition.description || ""];
  });
  entries.push(["-h, --help", "Show this help message"]);
  const width = Math.max(...entries.map(([left]) => left.length));
  for (const [left, right] of entries) {
    lines.push(`  ${left.padEnd(width)}  ${right}`.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

function bytes(count) {
  if (!Number.isFinite(count) || count < 0) {
    return "?";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function duration(milliseconds) {
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)} ms`;
  }
  const seconds = milliseconds / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

// Output goes through console, so a test (or a caller) can capture it. Progress and errors go to
// stderr, results to stdout, which is what lets `sof run x --json | jq` work.
function createLog(sink = console) {
  return {
    info: (...parts) => sink.log(...parts),
    success: (...parts) => sink.log("✓", ...parts),
    warn: (...parts) => sink.error("!", ...parts),
    error: (...parts) => sink.error(...parts),
    step: (...parts) => sink.error("·", ...parts),
    json: (value) => sink.log(JSON.stringify(value, null, 2)),
  };
}

// Asks on the terminal. Without one (CI, a pipe, an AI agent) the answer is the default, never a
// guess: an add-on that must have a yes should refuse when there is no terminal.
async function confirm(question, { defaultValue = false, input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY) {
    return defaultValue;
  }
  const readline = require("readline");
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await new Promise((resolve) => {
      rl.once("close", () => resolve(""));
      rl.question(`${question} ${defaultValue ? "[Y/n]" : "[y/N]"} `, resolve);
    });
    const text = String(answer).trim().toLowerCase();
    return text === "" ? defaultValue : text === "y" || text === "yes";
  } finally {
    rl.close();
  }
}

function createKit() {
  return {
    args: { parse: parseArgs, help: helpFor },
    log: createLog(),
    format: { bytes, duration },
    confirm,
  };
}

// For an add-on's own tests: a host that records what is printed and takes its answers from
// `answers`, so `run(argv, host)` can be called without a terminal.
function createTestHost({ answers = [], config = {}, sandboxed = false, addons = {} } = {}) {
  const output = [];
  const record = (prefix) => (...parts) => output.push([prefix, ...parts].filter(Boolean).join(" "));
  const sink = { log: record(""), error: record("") };
  const queue = answers.slice();

  return {
    host: {
      ...createKit(),
      log: createLog(sink),
      confirm: async () => (queue.length > 0 ? Boolean(queue.shift()) : false),
      sandboxed,
      config: async () => config,
      addons: { run: async (command, argv) => (addons[command] ? addons[command](argv) : Promise.reject(new Error(`No add-on "${command}" in this test host.`))) },
    },
    output: () => output.join("\n"),
    lines: output,
  };
}

module.exports = { bytes, confirm, createKit, createLog, createTestHost, duration, helpFor, parseArgs };
