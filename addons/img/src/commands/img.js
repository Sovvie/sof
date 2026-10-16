"use strict";

const { HELP_TEXT, parseArgs, applyDefaults } = require("../img/args");
const { readImgConfig } = require("../img/config");
const { collectInputs } = require("../img/collect");
const { planAll } = require("../img/plan");
const { formatLine, formatTotal, summarize, buildJson } = require("../img/report");

async function run(argv) {
  const cwd = process.cwd();
  let options;
  let items;
  try {
    const parsed = parseArgs(argv || []);
    if (parsed.help) {
      console.log(HELP_TEXT);
      return;
    }
    options = applyDefaults(parsed, readImgConfig(cwd));
    items = collectInputs(options.inputs, { cwd, recursive: options.recursive });
  } catch (err) {
    console.error(`img: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let processOne;
  try {
    ({ processOne } = require("../img/process"));
    require("sharp");
  } catch (err) {
    console.error(`img: sharp is not available (${err.message}). Run "npm install" in the img add-on folder.`);
    process.exitCode = 1;
    return;
  }

  const plans = planAll(items, options);
  const results = [];
  for (const plan of plans) {
    const result = await processOne(plan, options);
    results.push(result);
    if (!options.json) {
      const line = formatLine(result, cwd);
      if (result.status === "failed") console.error(line);
      else console.log(line);
    }
  }

  const summary = summarize(results);
  if (options.json) console.log(JSON.stringify(buildJson(results, options, cwd), null, 2));
  else console.log(formatTotal(summary, options.dryRun));
  if (summary.failed > 0) process.exitCode = 1;
}

module.exports = { run };
