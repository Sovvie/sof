"use strict";

// Takes the screenshots used in README.md (and checks, by eye, how the tags really render).
//   npm run screenshots [-- --out <folder>]
//
// Launches a real VS Code with the built extension in a throwaway profile, lets
// test/visual/demo.js put the editor into each state, and captures only the editor window
// through the DevTools port (never the desktop). Needs a VS Code on this machine (see
// test/integration/stage.js).

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { stageExtension, findLocalVSCode, root } = require("../test/integration/stage");

const PORT = 9333;
const WIDTH = 1040;
const HEIGHT = 640;
const SCALE = 2;
const STEPS = ["tags", "hover", "hover-install", "completion-names", "completion-versions", "quickfix"];

const outIndex = process.argv.indexOf("--out");
const outDir = path.resolve(outIndex !== -1 ? process.argv[outIndex + 1] : path.join(root, "images"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((target) => target.type === "page" && /workbench/.test(target.url));
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve, { once: true });
          socket.addEventListener("error", reject, { once: true });
        });

        let nextId = 0;
        const pending = new Map();
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));
          const resolve = pending.get(message.id);
          if (resolve) {
            pending.delete(message.id);
            resolve(message);
          }
        });
        const send = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
            socket.send(JSON.stringify({ id, method, params }));
          });
        return { send, close: () => socket.close() };
      }
    } catch (_err) {
      // The editor is still starting.
    }
    await sleep(500);
  }
  throw new Error(`Could not reach the editor's DevTools port ${PORT}.`);
}

async function main() {
  const executable = findLocalVSCode();
  if (!executable) throw new Error("No VS Code found; set VSCODE_PATH.");

  const staged = stageExtension({ copy: { "test/visual": "test/visual", "test/integration/suite/mock-registry.js": "test/integration/suite/mock-registry.js" } });
  const syncDir = path.join(staged.stage, "sync");
  fs.mkdirSync(syncDir, { recursive: true });
  fs.mkdirSync(path.join(staged.userDataDir, "User"), { recursive: true });
  fs.writeFileSync(
    path.join(staged.userDataDir, "User", "settings.json"),
    JSON.stringify(
      {
        "workbench.colorTheme": "Default Dark Modern",
        "workbench.startupEditor": "none",
        "workbench.tips.enabled": false,
        "workbench.secondarySideBar.defaultVisibility": "hidden",
        "window.commandCenter": false,
        "chat.disableAIFeatures": true,
        "editor.fontSize": 14,
        "editor.lineHeight": 24,
        "editor.minimap.enabled": false,
        "editor.guides.indentation": false,
        "breadcrumbs.enabled": false,
        "update.mode": "none",
        "telemetry.telemetryLevel": "off",
        "files.hotExit": "off",
      },
      null,
      2
    )
  );
  fs.mkdirSync(outDir, { recursive: true });

  const child = spawn(
    executable,
    [
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${staged.userDataDir}`,
      `--extensions-dir=${staged.extensionsDir}`,
      `--extensionDevelopmentPath=${staged.extensionDir}`,
      `--extensionTestsPath=${path.join(staged.extensionDir, "test", "visual", "demo.js")}`,
    ],
    { env: { ...process.env, SOF_SHOT_DIR: syncDir }, stdio: "ignore" }
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));

  try {
    const cdp = await connect();
    // A fixed viewport, independent of the real window, at 2x for crisp images.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: SCALE,
      mobile: false,
    });

    for (const step of STEPS) {
      const ready = path.join(syncDir, `${step}.ready`);
      for (let waited = 0; !fs.existsSync(ready); waited += 100) {
        if (waited > 90000) throw new Error(`timed out waiting for "${step}"`);
        await sleep(100);
      }
      await sleep(300);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      const file = path.join(outDir, `${step}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`  ${path.relative(process.cwd(), file)} (${Math.round(data.length * 0.75 / 1024)} kB)`);
      fs.writeFileSync(path.join(syncDir, `${step}.done`), "");
    }

    cdp.close();
    await Promise.race([exited, sleep(15000)]);
  } finally {
    if (child.exitCode === null) child.kill();
    staged.cleanup();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
