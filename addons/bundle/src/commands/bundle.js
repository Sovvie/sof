"use strict";

const { HELP_TEXT, parseArgs } = require("../lib/args");
const { planBundle } = require("../lib/plan");
const { writeArchive } = require("../lib/write");

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

function notes(plan) {
  const lines = [];
  if (plan.symlinks.length) {
    const shown = plan.symlinks.slice(0, 10).join(", ");
    const more = plan.symlinks.length > 10 ? `, and ${plan.symlinks.length - 10} more` : "";
    lines.push(`Skipped ${plan.symlinks.length} symlink${plan.symlinks.length === 1 ? "" : "s"} (never followed): ${shown}${more}`);
  }
  if (plan.special.length) {
    lines.push(`Skipped ${plan.special.length} special file${plan.special.length === 1 ? "" : "s"} (sockets, devices, pipes).`);
  }
  return lines;
}

// Programmatic entry: returns the result object without printing.
async function bundle(cli, context) {
  const plan = planBundle(cli, context);
  if (plan.files.length === 0) {
    throw new Error("Nothing to bundle: no files matched.");
  }
  const total = plan.files.reduce((sum, file) => sum + file.size, 0);
  const base = {
    folder: plan.folder,
    format: plan.format,
    files: plan.files.length,
    totalSize: total,
    skippedSymlinks: plan.symlinks,
    skippedSpecial: plan.special,
  };
  if (plan.options.list) {
    return { ...base, list: plan.files.map((f) => ({ path: plan.rootFolder ? `${plan.rootFolder}/${f.rel}` : f.rel, size: f.size })), plan };
  }
  const written = await writeArchive(plan);
  return { ...base, out: plan.outPath, size: written.size, sha256: written.sha256, plan };
}

async function run(argv) {
  const cli = parseArgs(argv);
  if (cli.help) {
    console.log(HELP_TEXT);
    return;
  }
  const result = await bundle(cli);
  const { plan, ...data } = result;
  if (plan.options.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.list) {
    for (const item of data.list) {
      console.log(`${String(item.size).padStart(10)}  ${item.path}`);
    }
    console.log(`${data.files} file${data.files === 1 ? "" : "s"}, ${human(data.totalSize)} total (nothing written)`);
  } else {
    console.log(`Wrote ${data.out}`);
    console.log(`  files:  ${data.files}`);
    console.log(`  size:   ${human(data.size)} (${data.size} bytes)`);
    console.log(`  sha256: ${data.sha256}`);
  }
  for (const line of notes(plan)) {
    console.log(line);
  }
}

module.exports = { run, bundle, HELP_TEXT };
