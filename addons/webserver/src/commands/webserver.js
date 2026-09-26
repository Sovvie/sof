"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_DIRECTORY = path.join(os.homedir(), ".sof", "webservers");
const DEFAULT_PORT = 4010;
const STATIC_SERVER_SCRIPT = path.resolve(__dirname, "..", "webserver", "static-server.js");
const RBX_MESH_ALIAS = "rbx_mesh";
const RBX_MESH_UI_DEFAULT_PATH = "./tools/rbx_mesh-ui";
const RBX_MESH_TOOL_DEFAULT_PATH = "./tools/rbx_mesh";
const RBX_MESH_REPOSITORY_URL = "https://github.com/krakow10/rbx_mesh";

const HELP_TEXT = `
sof run webserver - Start/stop local website servers

USAGE:
  sof run webserver <path> [--name <alias>] [--port <port>]
  sof run webserver start <path> [--name <alias>] [--port <port>]
  sof run webserver stop <alias|path> [--all]
  sof run webserver status [alias|path]
  sof run webserver list
  sof run webserver rbx_mesh init [path] [--tool-path <path>]
  sof run webserver rbx_mesh start [path] [--port <port>]
  sof run webserver rbx_mesh stop
  sof run webserver rbx_mesh status

OPTIONS:
  --name <alias>                    Optional alias used for stop/status commands
  --port <port>                     HTTP port to listen on (default: ${DEFAULT_PORT})
  --all                             Stop all managed webservers (stop command only)
  -h, --help                        Show this help message

NOTES:
  - Servers run in the background and write logs to ~/.sof/webservers.
  - The rbx_mesh preset serves a custom UI. Default path: ${RBX_MESH_UI_DEFAULT_PATH}
`;

const START_HELP_TEXT = `
sof run webserver start - Start a background static website server

USAGE:
  sof run webserver <path> [--name <alias>] [--port <port>]
  sof run webserver start <path> [--name <alias>] [--port <port>]

OPTIONS:
  --name <alias>                    Optional alias used for stop/status commands
  --port <port>                     HTTP port to listen on (default: ${DEFAULT_PORT})
  -h, --help                        Show this help message
`;

const STOP_HELP_TEXT = `
sof run webserver stop - Stop one or more managed webservers

USAGE:
  sof run webserver stop <alias|path>
  sof run webserver stop --all

OPTIONS:
  --all                             Stop all managed webservers
  -h, --help                        Show this help message
`;

const STATUS_HELP_TEXT = `
sof run webserver status - Show managed webserver status

USAGE:
  sof run webserver status
  sof run webserver status <alias|path>
  sof run webserver list

OPTIONS:
  -h, --help                        Show this help message
`;

const RBX_MESH_HELP_TEXT = `
sof run webserver rbx_mesh - Manage an rbx_mesh website server

USAGE:
  sof run webserver rbx_mesh init [path] [--tool-path <path>]
  sof run webserver rbx_mesh start [path] [--port <port>]
  sof run webserver rbx_mesh stop
  sof run webserver rbx_mesh status

OPTIONS:
  --port <port>                     HTTP port to listen on (default: ${DEFAULT_PORT})
  --tool-path <path>                Path to local rbx_mesh checkout (default: ${RBX_MESH_TOOL_DEFAULT_PATH})
  -h, --help                        Show this help message

NOTES:
  - Default UI path is ${RBX_MESH_UI_DEFAULT_PATH}
  - rbx_mesh repository: ${RBX_MESH_REPOSITORY_URL}
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAlias(aliasRaw) {
  const alias = String(aliasRaw || "").trim().toLowerCase();
  if (!alias) {
    return "";
  }
  if (!/^[a-z0-9_.-]+$/.test(alias)) {
    throw new Error(`Invalid alias "${aliasRaw}". Allowed characters: letters, numbers, ".", "_" and "-".`);
  }
  return alias;
}

function deriveAliasFromPath(rootPath) {
  const rawBaseName = String(path.basename(rootPath) || "webserver").toLowerCase();
  const sanitized = rawBaseName
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
  return sanitized || "webserver";
}

function normalizePathForComparison(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function ensureStateDirectory() {
  fs.mkdirSync(STATE_DIRECTORY, { recursive: true });
}

function parsePort(valueRaw) {
  const value = Number.parseInt(String(valueRaw || "").trim(), 10);
  if (Number.isNaN(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid port "${valueRaw}".`);
  }
  return value;
}

function parseStartArgs(argv, defaults = {}) {
  const output = {
    help: false,
    name: defaults.name || null,
    path: defaults.path || null,
    port: typeof defaults.port === "number" ? defaults.port : DEFAULT_PORT,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }
    if (arg === "--name") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--name requires a value.");
      }
      output.name = value;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--port requires a value.");
      }
      output.port = parsePort(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("webserver start accepts at most one positional argument (the path).");
  }
  if (positional[0]) {
    output.path = positional[0];
  }

  return output;
}

function parseStopArgs(argv, options = {}) {
  const output = {
    help: false,
    all: false,
    target: null,
  };

  const positional = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }
    if (arg === "--all") {
      output.all = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("webserver stop accepts at most one positional argument (alias or path).");
  }
  output.target = positional[0] || null;
  const allowMissingTarget = Boolean(options.allowMissingTarget);
  if (!output.all && !output.target && !output.help && !allowMissingTarget) {
    throw new Error('webserver stop requires "<alias|path>" or --all.');
  }

  return output;
}

function parseStatusArgs(argv) {
  const output = {
    help: false,
    target: null,
  };

  const positional = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("webserver status accepts at most one positional argument (alias or path).");
  }
  output.target = positional[0] || null;
  return output;
}

function parseRbxMeshStartArgs(argv, defaults = {}) {
  const output = {
    help: false,
    path: defaults.path || RBX_MESH_UI_DEFAULT_PATH,
    port: typeof defaults.port === "number" ? defaults.port : DEFAULT_PORT,
    toolPath: defaults.toolPath || RBX_MESH_TOOL_DEFAULT_PATH,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }
    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--port requires a value.");
      }
      output.port = parsePort(value);
      index += 1;
      continue;
    }
    if (arg === "--tool-path") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--tool-path requires a value.");
      }
      output.toolPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("rbx_mesh start accepts at most one positional argument (the UI path).");
  }
  if (positional[0]) {
    output.path = positional[0];
  }

  return output;
}

function parseRbxMeshInitArgs(argv, defaults = {}) {
  const output = {
    help: false,
    path: defaults.path || RBX_MESH_UI_DEFAULT_PATH,
    toolPath: defaults.toolPath || RBX_MESH_TOOL_DEFAULT_PATH,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }
    if (arg === "--tool-path") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--tool-path requires a value.");
      }
      output.toolPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("rbx_mesh init accepts at most one positional argument (the UI path).");
  }
  if (positional[0]) {
    output.path = positional[0];
  }

  return output;
}

function renderRbxMeshUiIndex(toolPathValue) {
  const safeToolPath = String(toolPathValue || RBX_MESH_TOOL_DEFAULT_PATH)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>rbx_mesh Workbench</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="app">
    <header class="hero">
      <h1>rbx_mesh Workbench</h1>
      <p>Custom frontend UI for local mesh tooling workflows in Sof.</p>
      <a href="${RBX_MESH_REPOSITORY_URL}" target="_blank" rel="noreferrer">Open rbx_mesh repository</a>
    </header>

    <section class="card">
      <h2>Tool Setup</h2>
      <label for="toolPath">Local rbx_mesh path</label>
      <input id="toolPath" type="text" value="${safeToolPath}" />
      <p class="hint">
        rbx_mesh is an external parser tool, so this UI is meant to be your workflow shell.
        Wire your parser/backend endpoints here as needed.
      </p>
    </section>

    <section class="card">
      <h2>Asset Command Builder</h2>
      <label for="assetIds">Asset IDs (comma, space, newline, or rbxassetid://)</label>
      <textarea id="assetIds" rows="6" placeholder="123456789&#10;rbxassetid://987654321"></textarea>

      <div class="row">
        <div class="field">
          <label for="assetKind">Asset type</label>
          <select id="assetKind">
            <option value="meshes">Meshes</option>
            <option value="images">PNGs / Images</option>
          </select>
        </div>
        <div class="field">
          <label for="creatorId">Creator ID</label>
          <input id="creatorId" type="text" placeholder="12345678" />
        </div>
      </div>

      <div class="actions">
        <button id="generateBtn" type="button">Generate command</button>
        <button id="copyBtn" type="button" disabled>Copy</button>
      </div>

      <pre id="commandOutput">No command generated yet.</pre>
      <p class="hint">
        PNG note: downloaded image blobs can be passed directly for upload; no extra decode step is required.
      </p>
    </section>
  </main>

  <script src="./app.js"></script>
</body>
</html>
`;
}

function renderRbxMeshUiStyles() {
  return `* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #0b1020;
  color: #e6edf7;
}

.app {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px;
}

.hero {
  margin-bottom: 20px;
}

.hero h1 {
  margin: 0 0 8px;
  font-size: 32px;
}

.hero p {
  margin: 0 0 8px;
  color: #9fb0c8;
}

.hero a {
  color: #6ab0ff;
}

.card {
  background: #111936;
  border: 1px solid #25345f;
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 16px;
}

h2 {
  margin-top: 0;
}

label {
  display: block;
  margin-bottom: 6px;
  font-weight: 600;
}

input,
select,
textarea,
button {
  width: 100%;
  font: inherit;
}

input,
select,
textarea {
  padding: 10px;
  border: 1px solid #324571;
  border-radius: 8px;
  background: #0b1530;
  color: #e6edf7;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.actions {
  display: flex;
  gap: 10px;
  margin: 12px 0;
}

.actions button {
  width: auto;
  border: 0;
  border-radius: 8px;
  padding: 10px 14px;
  cursor: pointer;
  background: #2f7bf5;
  color: #fff;
}

.actions button[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}

pre {
  margin: 0;
  white-space: pre-wrap;
  background: #060c1f;
  border: 1px solid #25345f;
  border-radius: 8px;
  padding: 12px;
}

.hint {
  color: #9fb0c8;
  font-size: 14px;
}
`;
}

function renderRbxMeshUiScript(toolPathValue) {
  return `(function () {
  "use strict";

  var STORAGE_KEY = "sof.rbx_mesh.tool_path";
  var DEFAULT_TOOL_PATH = ${JSON.stringify(String(toolPathValue || RBX_MESH_TOOL_DEFAULT_PATH))};

  var toolPathInput = document.getElementById("toolPath");
  var assetIdsInput = document.getElementById("assetIds");
  var assetKindSelect = document.getElementById("assetKind");
  var creatorIdInput = document.getElementById("creatorId");
  var generateBtn = document.getElementById("generateBtn");
  var copyBtn = document.getElementById("copyBtn");
  var output = document.getElementById("commandOutput");

  function restoreToolPath() {
    var saved = localStorage.getItem(STORAGE_KEY);
    toolPathInput.value = saved || DEFAULT_TOOL_PATH;
  }

  function normalizeIds(rawValue) {
    var matches = String(rawValue || "").match(/\\d+/g);
    if (!matches) {
      return [];
    }

    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < matches.length; i += 1) {
      var id = matches[i];
      if (!seen[id]) {
        seen[id] = true;
        out.push(id);
      }
    }
    return out;
  }

  function buildCommand() {
    var kind = assetKindSelect.value;
    var ids = normalizeIds(assetIdsInput.value);
    var creatorId = String(creatorIdInput.value || "").trim() || "<creator-id>";

    if (ids.length === 0) {
      return "Add one or more asset IDs first.";
    }

    var base = "sof run uploader " + kind + " " + ids.join(" ") + " --creator-id " + creatorId;
    if (kind === "images") {
      return base + "\\n\\n# PNG passthrough: raw downloaded PNG bytes can be uploaded directly.";
    }

    return base;
  }

  function generate() {
    localStorage.setItem(STORAGE_KEY, String(toolPathInput.value || DEFAULT_TOOL_PATH));
    var command = buildCommand();
    output.textContent = command;
    copyBtn.disabled = command.indexOf("sof run uploader ") !== 0;
  }

  function copyOutput() {
    var text = output.textContent || "";
    if (!text || text.indexOf("sof run uploader ") !== 0) {
      return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        copyBtn.textContent = "Copied";
        setTimeout(function () {
          copyBtn.textContent = "Copy";
        }, 1200);
      }).catch(function () {});
    }
  }

  generateBtn.addEventListener("click", generate);
  copyBtn.addEventListener("click", copyOutput);
  restoreToolPath();
})();`;
}

function renderRbxMeshUiReadme(targetPathValue, toolPathValue) {
  return `# rbx_mesh UI

Generated by \`sof run webserver rbx_mesh init\`.

This folder provides a custom frontend shell for \`rbx_mesh\` workflows and can be served with:

\`\`\`powershell
sof run webserver rbx_mesh start "${targetPathValue}"
\`\`\`

Default linked tool path in the UI: \`${toolPathValue}\`

Tool repository: ${RBX_MESH_REPOSITORY_URL}
`;
}

function scaffoldRbxMeshUi(targetPathRaw, toolPathRaw) {
  const targetPath = path.resolve(targetPathRaw || RBX_MESH_UI_DEFAULT_PATH);
  const toolPathValue = String(toolPathRaw || RBX_MESH_TOOL_DEFAULT_PATH);

  if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) {
    throw new Error(`rbx_mesh UI path must be a directory: ${targetPath}`);
  }
  fs.mkdirSync(targetPath, { recursive: true });

  const files = {
    "index.html": renderRbxMeshUiIndex(toolPathValue),
    "styles.css": renderRbxMeshUiStyles(),
    "app.js": renderRbxMeshUiScript(toolPathValue),
    "README.md": renderRbxMeshUiReadme(targetPathRaw || RBX_MESH_UI_DEFAULT_PATH, toolPathValue),
  };

  const created = [];
  const skipped = [];
  for (const [fileName, content] of Object.entries(files)) {
    const filePath = path.join(targetPath, fileName);
    if (fs.existsSync(filePath)) {
      skipped.push(fileName);
      continue;
    }
    fs.writeFileSync(filePath, content, "utf8");
    created.push(fileName);
  }

  return {
    targetPath,
    toolPath: toolPathValue,
    created,
    skipped,
  };
}

function getStateFilePath(key) {
  return path.join(STATE_DIRECTORY, `${key}.json`);
}

function getLogFilePath(key) {
  return path.join(STATE_DIRECTORY, `${key}.log`);
}

function stateKeyFor(alias, rootPath) {
  const aliasPart = alias ? normalizeAlias(alias) : deriveAliasFromPath(rootPath);
  const hash = crypto
    .createHash("sha1")
    .update(normalizePathForComparison(rootPath))
    .digest("hex")
    .slice(0, 12);

  return `${aliasPart}-${hash}`;
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

function readStateFromPath(statePath) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (!parsed.key || !parsed.alias || !parsed.rootPath || !Number.isInteger(parsed.pid)) {
      return null;
    }
    return parsed;
  } catch (_err) {
    return null;
  }
}

function readAllStates() {
  ensureStateDirectory();
  const files = fs
    .readdirSync(STATE_DIRECTORY)
    .filter((fileName) => fileName.toLowerCase().endsWith(".json"));
  const output = [];
  for (const fileName of files) {
    const state = readStateFromPath(path.join(STATE_DIRECTORY, fileName));
    if (state) {
      output.push(state);
    }
  }
  return output;
}

function removeStateByKey(key) {
  const statePath = getStateFilePath(key);
  if (fs.existsSync(statePath)) {
    fs.rmSync(statePath, { force: true });
  }
}

function writeState(state) {
  ensureStateDirectory();
  const statePath = getStateFilePath(state.key);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function findStateByTarget(targetRaw) {
  const states = readAllStates();
  if (!targetRaw) {
    return null;
  }

  const target = String(targetRaw).trim();
  if (!target) {
    return null;
  }

  let targetAlias = "";
  if (/^[a-z0-9_.-]+$/i.test(target)) {
    targetAlias = normalizeAlias(target);
  }
  const targetPath = normalizePathForComparison(target);
  const matches = states.filter((state) => {
    if (state.key === target) {
      return true;
    }
    if (state.alias === targetAlias) {
      return true;
    }
    if (normalizePathForComparison(state.rootPath) === targetPath) {
      return true;
    }
    return false;
  });

  if (matches.length > 1) {
    throw new Error(`Target "${target}" matched multiple webservers. Use a more specific alias or path.`);
  }

  return matches[0] || null;
}

function cleanStaleStates(states) {
  const running = [];
  for (const state of states) {
    if (isProcessRunning(state.pid)) {
      running.push(state);
      continue;
    }
    removeStateByKey(state.key);
  }
  return running;
}

function assertValidRootPath(rootPathRaw) {
  const resolved = path.resolve(rootPathRaw);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Path must be a directory: ${resolved}`);
  }
  return resolved;
}

function spawnDetachedStaticServer({ rootPath, port, key }) {
  const logPath = getLogFilePath(key);
  const outputFd = fs.openSync(logPath, "a");

  const child = childProcess.spawn(
    process.execPath,
    [STATIC_SERVER_SCRIPT, "--root", rootPath, "--port", String(port)],
    {
      cwd: rootPath,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outputFd, outputFd],
      env: process.env,
    }
  );

  fs.closeSync(outputFd);
  child.unref();
  return {
    pid: child.pid,
    logPath,
  };
}

async function startWebserver({ rootPath, alias, port, preset }) {
  const resolvedRoot = assertValidRootPath(rootPath);
  const resolvedAlias = alias ? normalizeAlias(alias) : deriveAliasFromPath(resolvedRoot);
  const key = stateKeyFor(resolvedAlias, resolvedRoot);

  const allStates = cleanStaleStates(readAllStates());
  const duplicateAlias = allStates.find(
    (state) =>
      state.alias === resolvedAlias &&
      normalizePathForComparison(state.rootPath) !== normalizePathForComparison(resolvedRoot)
  );
  if (duplicateAlias) {
    throw new Error(
      `Alias "${resolvedAlias}" is already in use for ${duplicateAlias.rootPath}. ` +
        "Use --name to choose a different alias."
    );
  }

  const existing = allStates.find((state) => state.key === key);
  if (existing && isProcessRunning(existing.pid)) {
    throw new Error(
      `A webserver is already running for ${resolvedRoot} (PID ${existing.pid}, alias "${existing.alias}").`
    );
  }

  removeStateByKey(key);
  const started = spawnDetachedStaticServer({
    rootPath: resolvedRoot,
    port,
    key,
  });

  await sleep(400);
  if (!isProcessRunning(started.pid)) {
    throw new Error(
      `Webserver failed to start for ${resolvedRoot}. Check logs: ${started.logPath}`
    );
  }

  const state = {
    key,
    alias: resolvedAlias,
    rootPath: resolvedRoot,
    port,
    pid: started.pid,
    logPath: started.logPath,
    preset: preset || null,
    startedAt: new Date().toISOString(),
  };
  writeState(state);
  return state;
}

async function stopState(state) {
  if (!isProcessRunning(state.pid)) {
    removeStateByKey(state.key);
    return {
      state,
      stopped: false,
      stale: true,
    };
  }

  try {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch (signalErr) {
      if (signalErr.code !== "ERR_UNKNOWN_SIGNAL") {
        throw signalErr;
      }
      process.kill(state.pid);
    }
  } catch (err) {
    if (err.code === "ESRCH") {
      removeStateByKey(state.key);
      return {
        state,
        stopped: false,
        stale: true,
      };
    }
    throw new Error(`Failed to stop PID ${state.pid}: ${err.message}`);
  }

  await sleep(300);
  if (isProcessRunning(state.pid)) {
    try {
      process.kill(state.pid);
    } catch (err) {
      if (err.code !== "ESRCH") {
        throw new Error(`Failed to stop PID ${state.pid}: ${err.message}`);
      }
    }
  }

  removeStateByKey(state.key);
  return {
    state,
    stopped: true,
    stale: false,
  };
}

function printStatusEntries(states) {
  if (states.length === 0) {
    console.log("No managed webservers are currently running.");
    return;
  }

  console.log(`Managed webservers (${states.length}):`);
  for (const state of states) {
    const status = isProcessRunning(state.pid) ? "running" : "stale";
    console.log(`- ${state.alias}`);
    console.log(`  status: ${status}`);
    console.log(`  pid: ${state.pid}`);
    console.log(`  port: ${state.port}`);
    console.log(`  root: ${state.rootPath}`);
    console.log(`  log: ${state.logPath}`);
    if (state.preset) {
      console.log(`  preset: ${state.preset}`);
    }
  }
}

function printStartedServerInfo(state) {
  console.log(`Started webserver "${state.alias}" (PID ${state.pid}).`);
  console.log(`URL: http://127.0.0.1:${state.port}`);
  console.log(`Root: ${state.rootPath}`);
  console.log(`Log: ${state.logPath}`);
  console.log(`Stop: sof run webserver stop ${state.alias}`);
}

function printRbxMeshScaffold(result) {
  console.log(`rbx_mesh UI path: ${result.targetPath}`);
  console.log(`Linked tool path: ${result.toolPath}`);

  if (result.created.length > 0) {
    console.log("Created UI file(s):");
    for (const fileName of result.created) {
      console.log(`  + ${fileName}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log("Kept existing UI file(s):");
    for (const fileName of result.skipped) {
      console.log(`  - ${fileName}`);
    }
  }
}

async function runStart(argv, defaults = {}) {
  const args = parseStartArgs(argv, defaults);
  if (args.help) {
    console.log(START_HELP_TEXT);
    process.exit(0);
  }
  if (!args.path) {
    throw new Error("webserver start requires a path.");
  }

  const state = await startWebserver({
    rootPath: args.path,
    alias: args.name || defaults.name || null,
    port: args.port,
    preset: defaults.preset || null,
  });

  printStartedServerInfo(state);
}

async function runStop(argv, defaults = {}) {
  const args = parseStopArgs(argv, {
    allowMissingTarget: Boolean(defaults.target),
  });
  if (args.help) {
    console.log(STOP_HELP_TEXT);
    process.exit(0);
  }

  const allStates = cleanStaleStates(readAllStates());
  const target = defaults.target || args.target;

  if (args.all) {
    if (allStates.length === 0) {
      console.log("No managed webservers are currently running.");
      return;
    }

    for (const state of allStates) {
      const result = await stopState(state);
      if (result.stopped) {
        console.log(`Stopped "${state.alias}" (PID ${state.pid}).`);
      } else {
        console.log(`Removed stale entry for "${state.alias}" (PID ${state.pid}).`);
      }
    }
    return;
  }

  if (!target) {
    throw new Error('webserver stop requires "<alias|path>" or --all.');
  }

  const state = findStateByTarget(target);
  if (!state) {
    console.log(`No managed webserver found for target: ${target}`);
    return;
  }

  const result = await stopState(state);
  if (result.stopped) {
    console.log(`Stopped "${state.alias}" (PID ${state.pid}).`);
  } else {
    console.log(`Removed stale entry for "${state.alias}" (PID ${state.pid}).`);
  }
}

function runStatus(argv, defaults = {}) {
  const args = parseStatusArgs(argv);
  if (args.help) {
    console.log(STATUS_HELP_TEXT);
    process.exit(0);
  }

  const runningStates = cleanStaleStates(readAllStates());
  const target = defaults.target || args.target;
  if (!target) {
    printStatusEntries(runningStates);
    return;
  }

  const state = findStateByTarget(target);
  if (!state) {
    console.log(`No managed webserver found for target: ${target}`);
    return;
  }

  printStatusEntries([state]);
}

async function runRbxMesh(argv) {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    console.log(RBX_MESH_HELP_TEXT);
    process.exit(subcommand ? 0 : 1);
  }

  if (subcommand === "init") {
    const initArgs = parseRbxMeshInitArgs(rest, {
      path: RBX_MESH_UI_DEFAULT_PATH,
      toolPath: RBX_MESH_TOOL_DEFAULT_PATH,
    });
    if (initArgs.help) {
      console.log(RBX_MESH_HELP_TEXT);
      process.exit(0);
    }

    const scaffold = scaffoldRbxMeshUi(initArgs.path, initArgs.toolPath);
    printRbxMeshScaffold(scaffold);
    return;
  }

  if (subcommand === "start") {
    const startArgs = parseRbxMeshStartArgs(rest, {
      path: RBX_MESH_UI_DEFAULT_PATH,
      toolPath: RBX_MESH_TOOL_DEFAULT_PATH,
      port: DEFAULT_PORT,
    });
    if (startArgs.help) {
      console.log(RBX_MESH_HELP_TEXT);
      process.exit(0);
    }

    const scaffold = scaffoldRbxMeshUi(startArgs.path, startArgs.toolPath);
    if (scaffold.created.length > 0) {
      printRbxMeshScaffold(scaffold);
    }

    const state = await startWebserver({
      rootPath: scaffold.targetPath,
      alias: RBX_MESH_ALIAS,
      port: startArgs.port,
      preset: "rbx_mesh",
    });
    printStartedServerInfo(state);
    console.log(`Tool repo: ${RBX_MESH_REPOSITORY_URL}`);
    console.log(`Suggested local tool checkout: ${path.resolve(startArgs.toolPath)}`);
    return;
  }

  if (subcommand === "stop") {
    const stopHelp = rest.includes("-h") || rest.includes("--help");
    if (stopHelp) {
      console.log(RBX_MESH_HELP_TEXT);
      process.exit(0);
    }
    if (rest.length > 0) {
      throw new Error("rbx_mesh stop does not accept additional arguments.");
    }

    await runStop([], { target: RBX_MESH_ALIAS });
    return;
  }

  if (subcommand === "status") {
    const statusArgs = parseStatusArgs(rest);
    if (statusArgs.help) {
      console.log(RBX_MESH_HELP_TEXT);
      process.exit(0);
    }
    if (statusArgs.target) {
      throw new Error("rbx_mesh status does not accept additional arguments.");
    }

    runStatus([], { target: RBX_MESH_ALIAS });
    return;
  }

  throw new Error(`Unknown rbx_mesh webserver subcommand: ${subcommand}`);
}

async function runWebserver(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "-h" || command === "--help") {
    console.log(HELP_TEXT);
    process.exit(command ? 0 : 1);
  }

  if (command === "start") {
    await runStart(rest);
    return;
  }

  if (command === "stop") {
    await runStop(rest);
    return;
  }

  if (command === "status" || command === "list") {
    runStatus(rest);
    return;
  }

  if (command === "rbx_mesh" || command === "rbx-mesh") {
    await runRbxMesh(rest);
    return;
  }

  if (command === "help") {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  // Shorthand: sof run webserver <path> [--name ...] [--port ...]
  await runStart([command, ...rest]);
}

module.exports = {
  runWebserver,
};
