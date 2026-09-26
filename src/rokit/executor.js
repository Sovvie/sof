"use strict";

const childProcess = require("child_process");
const { ensureRokit } = require("./bootstrap");

function spawnRokitProcess(binaryPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(binaryPath, args, {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to launch Rokit: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`Rokit process exited due to signal ${signal}.`));
        return;
      }
      resolve(code || 0);
    });
  });
}

async function runRokit(args, cwd) {
  if (!Array.isArray(args)) {
    throw new Error("runRokit expects an array of CLI arguments.");
  }

  const bootstrapResult = await ensureRokit();
  return spawnRokitProcess(bootstrapResult.binaryPath, args, cwd);
}

module.exports = {
  runRokit,
};
