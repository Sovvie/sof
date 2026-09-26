#!/usr/bin/env node
"use strict";

const { runCli } = require("../src/cli");

Promise.resolve(runCli(process.argv.slice(2))).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
