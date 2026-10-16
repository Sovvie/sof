"use strict";

// Launches a real VS Code with this extension loaded and runs suite/index.js inside it.
//   npm run test:integration
//
// What is tested is the built bundle (package.json + dist/), staged in a temp folder (see
// stage.js). The profile (user data + extensions) is temporary too, so nothing in your own
// editor is touched. VS Code Insiders / VS Code are used if installed (no download); set
// VSCODE_PATH to use another build, otherwise a stable build is downloaded into .vscode-test.

const path = require("path");
const { runTests } = require("@vscode/test-electron");
const { stageExtension, findLocalVSCode } = require("./stage");

async function main() {
  const staged = stageExtension({ copy: { "test/integration/suite": "test/integration/suite" } });

  try {
    await runTests({
      vscodeExecutablePath: findLocalVSCode(),
      extensionDevelopmentPath: staged.extensionDir,
      extensionTestsPath: path.join(staged.extensionDir, "test", "integration", "suite", "index.js"),
      launchArgs: [
        "--disable-extensions",
        "--disable-workspace-trust",
        `--user-data-dir=${staged.userDataDir}`,
        `--extensions-dir=${staged.extensionsDir}`,
      ],
    });
  } finally {
    staged.cleanup();
  }
}

main().catch((err) => {
  console.error("Integration tests failed:", err && err.message ? err.message : err);
  process.exit(1);
});
