#!/usr/bin/env node
"use strict";

const { runCli } = require("../src/cli");
const { safeText } = require("../src/safe-text");

Promise.resolve(runCli(process.argv.slice(2))).catch((err) => {
  console.error(`Error: ${safeText(err.message)}`);
  process.exitCode = 1;
});
