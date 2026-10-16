"use strict";

// Copies the built extension (package.json + dist/) and some test folders into a fresh temp
// folder, and finds a VS Code to run it in. Staging sidesteps two problems: the launcher splits
// paths at spaces on Windows (this repo may live in one), and it makes sure the tests exercise
// the bundle that would actually ship.

const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");

function findLocalVSCode() {
  if (process.env.VSCODE_PATH) return process.env.VSCODE_PATH;
  const local = process.env.LOCALAPPDATA;
  const candidates = local
    ? [
        path.join(local, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"),
        path.join(local, "Programs", "Microsoft VS Code", "Code.exe"),
      ]
    : [];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * @param {{ copy?: Record<string, string> }} [options]  Extra folders/files to copy: { "test/visual": "test/visual" } (from root -> into the extension).
 */
function stageExtension(options = {}) {
  if (!fs.existsSync(path.join(root, "dist", "extension.js"))) {
    throw new Error("dist/extension.js is missing: run `npm run build` first.");
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "sof-vscode-test-"));
  if (/\s/.test(stage)) {
    throw new Error(`The temp folder path contains a space (${stage}); set TMP/TEMP to one without.`);
  }

  const extensionDir = path.join(stage, "extension");
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.copyFileSync(path.join(root, "package.json"), path.join(extensionDir, "package.json"));
  fs.cpSync(path.join(root, "dist"), path.join(extensionDir, "dist"), { recursive: true });
  for (const [from, to] of Object.entries(options.copy || {})) {
    fs.cpSync(path.join(root, from), path.join(extensionDir, to), { recursive: true });
  }

  return {
    stage,
    extensionDir,
    userDataDir: path.join(stage, "user-data"),
    extensionsDir: path.join(stage, "extensions"),
    cleanup() {
      fs.rmSync(stage, { recursive: true, force: true });
    },
  };
}

module.exports = { stageExtension, findLocalVSCode, root };
