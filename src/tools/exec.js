"use strict";

// `sof run tools exec <alias> [arguments...]`: what a shim runs. Starts the tool at the version
// the nearest sof.toml pins and exits with its exit code. Output of its own goes to stderr only,
// because the tool's stdout may be a protocol (a language server) that nothing may interleave with.

const childProcess = require("child_process");
const os = require("os");
const path = require("path");

const { findToolEntry } = require("./resolve");
const { parseToolSpecifier } = require("./spec");
const { isToolInstalled, toolExecutablePath } = require("./store");

function fail(message) {
  console.error(`sof: ${message}`);
  return 1;
}

function displayDirectory(file) {
  return path.dirname(file);
}

// Starts the program and resolves to its exit code. Ctrl+C reaches the tool itself (it shares our
// console or process group), so it is ignored here and we wait for the tool to finish.
function spawnTool(executable, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = childProcess.spawn(executable, args, { stdio: "inherit" });
    } catch (err) {
      // Windows throws for a file that isn't a program (a damaged or quarantined download).
      console.error(`sof: couldn't start ${executable}: ${err.message}`);
      resolve(126);
      return;
    }

    const ignore = () => {};
    process.on("SIGINT", ignore);
    const forward = (signal) => () => child.kill(signal);
    const handlers = ["SIGTERM", "SIGHUP"].map((signal) => [signal, forward(signal)]);
    for (const [signal, handler] of handlers) {
      process.on(signal, handler);
    }

    const finish = (code) => {
      process.off("SIGINT", ignore);
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
      resolve(code);
    };

    child.on("error", (err) => {
      console.error(`sof: couldn't start ${executable}: ${err.message}`);
      finish(126);
    });
    child.on("close", (code, signal) => {
      finish(signal ? 128 + (os.constants.signals[signal] || 0) : code === null ? 1 : code);
    });
  });
}

async function runTool(alias, args) {
  const entry = findToolEntry(alias);
  if (!entry) {
    return fail(
      `"${alias}" isn't listed under [tools] in any sof.toml from here up, or in your global tools. ` +
        `Add it with: sof run tools add <owner>/<repo>`
    );
  }

  let spec;
  try {
    spec = parseToolSpecifier(entry.specifier, `${entry.file}: [tools].${entry.alias}`);
  } catch (err) {
    return fail(err.message);
  }

  if (!isToolInstalled(spec)) {
    return fail(
      `${entry.alias} ${spec.version} isn't installed yet. Run: sof run tools install` +
        (entry.global ? " --global" : ` (in ${displayDirectory(entry.file)})`)
    );
  }

  return spawnTool(toolExecutablePath(spec), args);
}

module.exports = {
  runTool,
  spawnTool,
};
