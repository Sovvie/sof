"use strict";

const { runChecks } = require("../doctor/checks");
const { isOffline } = require("../cache");
const { safeText } = require("../safe-text");

const HELP_TEXT = `
sof run doctor - Check that sof, your tools, packages and add-ons are in working order

USAGE:
  sof run doctor [path/to/sof.toml] [--fix] [--offline] [--json]

CHECKS:
  sof        node version, the ~/.sof folder, sandbox support
  project    tools (installed, shims, on PATH, matching sof.tools.lock and what sof installed),
             packages (installed and unchanged since the last install), scripts (can run, trusted)
  add-ons    folder present and valid, dependencies installed, requirements (sof, add-ons, tools) met
  registry   reachable
  account    signed in, AI tools blocked from ~/.sof

OPTIONS:
  --fix        Do what is safe without asking: set up shims, install an add-on's npm dependencies,
               install the add-ons another add-on needs. It never downloads tools or packages
               (it tells you the command) and never touches your files.
  --offline    Skip the checks that need the network
  --json       Print the findings as JSON
  -h, --help   Show this help message

Exits with 1 when a problem is found (warnings and notes don't count).
`;

const SYMBOL = { ok: "✓", info: "·", warn: "!", problem: "✗" };

function render(findings, { fixed = [] } = {}) {
  let section = null;
  for (const finding of findings) {
    if (finding.section !== section) {
      section = finding.section;
      console.log(`\n${section}`);
    }
    console.log(`  ${SYMBOL[finding.status]} ${safeText(finding.message)}`);
    if (finding.fix && finding.status !== "ok" && finding.status !== "info") {
      console.log(`      fix: ${safeText(finding.fix.command)}${finding.fix.apply ? "   (sof run doctor --fix)" : ""}`);
    }
  }
  for (const line of fixed) {
    console.log(`  + ${line}`);
  }
}

async function runDoctor(argv) {
  let fix = false;
  let json = false;
  let offline = false;
  const positional = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(HELP_TEXT);
      return;
    } else if (arg === "--fix") fix = true;
    else if (arg === "--json") json = true;
    else if (arg === "--offline") offline = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) {
    throw new Error("doctor accepts at most one positional argument (the config path).");
  }
  if (offline) {
    require("../cache").setOffline();
  }

  const options = { config: positional[0] || null, network: !isOffline() };
  let findings = await runChecks(options);

  const fixed = [];
  if (fix) {
    const done = new Set();
    for (const finding of findings) {
      if (!finding.fix || !finding.fix.apply || done.has(finding.fix.command)) {
        continue;
      }
      done.add(finding.fix.command);
      try {
        await finding.fix.apply();
        fixed.push(`${finding.fix.label}`);
      } catch (err) {
        fixed.push(`couldn't ${finding.fix.label}: ${err.message}`);
      }
    }
    if (fixed.length > 0) {
      findings = await runChecks(options);
    }
  }

  const problems = findings.filter((finding) => finding.status === "problem").length;
  const warnings = findings.filter((finding) => finding.status === "warn").length;

  if (json) {
    console.log(
      JSON.stringify(
        {
          problems,
          warnings,
          fixed,
          findings: findings.map(({ section, status, message, fix }) => ({ section, status, message, ...(fix ? { fix: fix.command } : {}) })),
        },
        null,
        2
      )
    );
  } else {
    render(findings, { fixed });
    console.log(`\n${problems === 0 ? "No problems found" : `${problems} problem(s) found`}${warnings > 0 ? `, ${warnings} warning(s)` : ""}.`);
  }
  process.exitCode = problems === 0 ? 0 : 1;
}

module.exports = { runDoctor };
