"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  LOCAL_UPLOADER_ENV_PATH,
  loadUploaderEnv,
  sanitizeRoblosecurity,
  writeUploaderEnv,
} = require("../uploader/env");
const {
  DEFAULT_REMOTE_EXEC_PORT,
  DEFAULT_REMOTE_EXEC_TIMEOUT_MS,
  uploadMeshesViaRemoteExec,
} = require("../uploader/remote-exec-mesh");
loadUploaderEnv();

const HELP_TEXT = `
sof run uploader - Roblox asset upload tooling

USAGE:
  sof run uploader <command> [arguments] [options]
  sof run uploader env [options]
  sof run uploader serve [--port <port>]
  sof run uploader images <assetId...> [options]
  sof run uploader animations <assetId...> [options]
  sof run uploader meshes <assetId...> [options]
  sof run uploader image files <file...> [options]
  sof run uploader model files <file...> [options]

COMMANDS:
  env                            Prompt for uploader credentials and save locally
  serve                          Start a web dashboard for uploading assets
  image files <file...>          Upload local image files
  model files <file...>          Upload local model/mesh files
  images <assetId...>            Re-upload image assets by ID
  animations <assetId...>        Re-upload animation assets by ID
  meshes <assetId...>            Re-upload mesh assets by ID

OPTIONS:
  --remote-exec                 Mesh uploads only: use Remote Exec plugin bridge
  --remote-port <port>          Mesh uploads only: Remote Exec port (default: 8080)
  --remote-timeout <ms>         Mesh uploads only: plugin wait/request timeout (default: 120000)
  -h, --help                       Show this help message
`;

const FULL_HELP_TEXT = `
sof run uploader - Full command reference

USAGE:
  sof run uploader <command> [arguments] [options]

COMMANDS:
  env
    sof run uploader env [options]
    OPTIONS:
      -h, --help                   Show env command help

  serve
    sof run uploader serve [options]
    OPTIONS:
      --port <port>                HTTP port to listen on (default: 4000)
      -h, --help                   Show serve command help

  image files
    sof run uploader image files <file...> [options]
  model files
    sof run uploader model files <file...> [options]
  images
    sof run uploader images <assetId...> [options]
  animations
    sof run uploader animations <assetId...> [options]
  meshes
    sof run uploader meshes <assetId...> [options]
    SHARED OPTIONS:
      --creator-id <id>            Creator user/group ID (defaults to ROBLOX_CREATOR_ID)
      --group                      Treat creator ID as a group ID (default: user ID)
      --api-key <key>              Override ROBLOX_API_KEY for API key uploads
      --cookie <value>             Override ROBLOSECURITY cookie/token
      --remote-exec                Upload meshes via Studio Remote Exec + AssetService
      --remote-port <port>         Remote Exec port (default: 8080)
      --remote-timeout <ms>        Plugin wait/request timeout (default: 120000)
      -h, --help                   Show upload command help

NOTES:
  - "serve" starts a local web dashboard with the same upload capabilities.
  - "image files" accepts local image files (png/jpg/jpeg + convertible formats).
  - "model files" accepts model/mesh files (obj/fbx/gltf/glb/stl/mesh/rbxmesh).
  - "images", "animations", and "meshes" re-upload by existing asset IDs.
  - "meshes" re-upload requires both API key (Open Cloud) and ROBLOSECURITY.
  - "meshes --remote-exec" uses the Studio plugin bridge and AssetService:CreateAssetAsync.
  - "sof run uploader env" writes ROBLOX_API_KEY, ROBLOSECURITY, and ROBLOX_CREATOR_ID.
  - User uploads auto-resolve --creator-id from authenticated cookie when omitted.
  - Group uploads require --creator-id unless ROBLOX_CREATOR_ID is configured.
  - Legacy alias "sof run uploader upload ..." is still accepted.

MORE HELP:
  sof run uploader env --help
  sof run uploader serve --help
  sof run uploader images --help
  sof run uploader image files --help
`;

const ENV_HELP_TEXT = `
sof run uploader env - Save uploader credentials to a machine-local env file

USAGE:
  sof run uploader env [options]

OPTIONS:
  -h, --help               Show this help message
`;

const SERVE_HELP_TEXT = `
sof run uploader serve - Start a web dashboard for uploading assets

USAGE:
  sof run uploader serve [options]

OPTIONS:
  --port <port>            HTTP port to listen on (default: 4000)
  -h, --help               Show this help message

DESCRIPTION:
  Opens a local web page in your browser where you can upload images, 3D models,
  and re-upload existing assets — all without using the command line.

  The server only listens on 127.0.0.1 (localhost) and is not accessible from
  other machines on your network.
`;

const UPLOAD_HELP_TEXT = `
sof run uploader - Upload assets without a local host server

USAGE:
  sof run uploader image files <file...> [options]
  sof run uploader model files <file...> [options]
  sof run uploader images <assetId...> [options]
  sof run uploader animations <assetId...> [options]
  sof run uploader meshes <assetId...> [options]

TARGETS:
  image files                Local image files (png/jpg/jpeg + supported conversion formats)
  model files                Local model/mesh files (obj/fbx/gltf/glb/stl/mesh/rbxmesh)
  images                     Existing image asset IDs to re-upload
  animations                 Existing animation asset IDs to re-upload
  meshes                     Existing mesh asset IDs to re-upload

OPTIONS:
  --creator-id <id>          Creator user/group ID (defaults to ROBLOX_CREATOR_ID)
  --group                    Treat creator ID as a group ID (default: user ID)
  --api-key <key>            Override ROBLOX_API_KEY for API key uploads
  --cookie <value>           Override ROBLOSECURITY cookie/token
  --remote-exec              Mesh uploads only: use Remote Exec plugin bridge
  --remote-port <port>       Mesh uploads only: Remote Exec port (default: 8080)
  --remote-timeout <ms>      Mesh uploads only: plugin wait/request timeout (default: 120000)
  -h, --help                 Show this help message
`;

function parseEnvArgs(argv) {
  const output = { help: false };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return output;
}

function parseServeArgs(argv) {
  const output = { help: false, port: 4000 };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--port requires a numeric value.");
      }
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port number: ${value}`);
      }
      output.port = port;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return output;
}

function parseRemotePort(valueRaw) {
  const value = Number.parseInt(String(valueRaw || "").trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid remote exec port: ${valueRaw}`);
  }
  return value;
}

function parseRemoteTimeout(valueRaw) {
  const value = Number.parseInt(String(valueRaw || "").trim(), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid remote timeout: ${valueRaw}`);
  }
  return value;
}

function parseCreatorId(value) {
  const creatorId = String(value || "").trim();
  if (!creatorId) {
    throw new Error("--creator-id requires a value.");
  }
  if (!/^\d+$/.test(creatorId)) {
    throw new Error(`Invalid creator ID: ${value}`);
  }
  return creatorId;
}

function normalizeCookieOverride(value) {
  const token = sanitizeRoblosecurity(value);
  if (!token) {
    throw new Error("--cookie cannot be empty.");
  }
  return `.ROBLOSECURITY=${token}`;
}

function getConfiguredCreatorId() {
  const configuredCreatorId = String(process.env.ROBLOX_CREATOR_ID || "").trim();
  if (!configuredCreatorId) {
    return null;
  }

  try {
    return parseCreatorId(configuredCreatorId);
  } catch {
    throw new Error(
      `Invalid ROBLOX_CREATOR_ID in ${LOCAL_UPLOADER_ENV_PATH}: ${configuredCreatorId}`
    );
  }
}

async function resolveAuthenticatedUserId(cookie) {
  const fetch = require("node-fetch");
  const response = await fetch("https://users.roblox.com/v1/users/authenticated", {
    method: "GET",
    headers: { Cookie: cookie },
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve authenticated user (status ${response.status})`);
  }

  const payload = await response.json();
  if (!payload.id) {
    throw new Error(`Authenticated user response missing id: ${JSON.stringify(payload)}`);
  }

  return String(payload.id);
}

function parseUploadTarget(argv) {
  if (argv[0] === "image" && argv[1] === "files") {
    return { mode: "image-files", rest: argv.slice(2) };
  }
  if (argv[0] === "model" && argv[1] === "files") {
    return { mode: "model-files", rest: argv.slice(2) };
  }
  if (argv[0] === "image-files") {
    return { mode: "image-files", rest: argv.slice(1) };
  }
  if (argv[0] === "model-files") {
    return { mode: "model-files", rest: argv.slice(1) };
  }
  if (argv[0] === "images") {
    return { mode: "images", rest: argv.slice(1) };
  }
  if (argv[0] === "animations") {
    return { mode: "animations", rest: argv.slice(1) };
  }
  if (argv[0] === "meshes") {
    return { mode: "meshes", rest: argv.slice(1) };
  }
  throw new Error("uploader requires one of: image files, model files, images, animations, meshes.");
}

function normalizeFileTargets(targets) {
  return targets.map((target) => {
    const resolvedPath = path.resolve(target);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${target}`);
    }
    if (!fs.statSync(resolvedPath).isFile()) {
      throw new Error(`Expected a file path: ${target}`);
    }
    return resolvedPath;
  });
}

function normalizeAssetTargets(targets) {
  const normalized = [];
  for (const rawValue of targets) {
    const value = String(rawValue || "").trim();
    if (!value) {
      continue;
    }
    const parts = value.split(",");
    for (const part of parts) {
      const candidate = part.trim();
      if (candidate) {
        normalized.push(candidate);
      }
    }
  }
  return normalized;
}

function parseUploadArgs(argv) {
  const target = parseUploadTarget(argv);
  const output = {
    mode: target.mode,
    creatorId: getConfiguredCreatorId(),
    isGroup: false,
    apiKey: null,
    cookie: null,
    useRemoteExec: false,
    remotePort: DEFAULT_REMOTE_EXEC_PORT,
    remoteTimeout: DEFAULT_REMOTE_EXEC_TIMEOUT_MS,
    help: false,
    targets: [],
  };

  for (let index = 0; index < target.rest.length; index += 1) {
    const arg = target.rest[index];

    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--group") {
      output.isGroup = true;
      continue;
    }

    if (arg === "--creator-id") {
      const value = target.rest[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--creator-id requires a numeric value.");
      }
      output.creatorId = parseCreatorId(value);
      index += 1;
      continue;
    }

    if (arg === "--api-key") {
      const value = target.rest[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--api-key requires a value.");
      }
      output.apiKey = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--cookie") {
      const value = target.rest[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--cookie requires a value.");
      }
      output.cookie = normalizeCookieOverride(value);
      index += 1;
      continue;
    }

    if (arg === "--remote-exec") {
      output.useRemoteExec = true;
      continue;
    }

    if (arg === "--remote-port") {
      const value = target.rest[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--remote-port requires a value.");
      }
      output.remotePort = parseRemotePort(value);
      index += 1;
      continue;
    }

    if (arg === "--remote-timeout") {
      const value = target.rest[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--remote-timeout requires a value.");
      }
      output.remoteTimeout = parseRemoteTimeout(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    output.targets.push(arg);
  }

  if (output.help) {
    return output;
  }

  if (output.isGroup && !output.creatorId) {
    throw new Error("--group requires --creator-id <groupId>.");
  }

  if (output.targets.length === 0) {
    throw new Error("uploader command requires at least one file path or asset ID.");
  }

  if (output.useRemoteExec && output.mode !== "meshes") {
    throw new Error("--remote-exec is currently supported only with: sof run uploader meshes <assetId...>");
  }

  if (output.mode === "image-files" || output.mode === "model-files") {
    output.targets = normalizeFileTargets(output.targets);
  } else {
    output.targets = normalizeAssetTargets(output.targets);
  }

  if (output.targets.length === 0) {
    throw new Error("No valid file paths or asset IDs were provided.");
  }

  return output;
}

function askQuestion(prompt, question) {
  return new Promise((resolve) => {
    prompt.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function promptRequiredValue(prompt, question, errorMessage) {
  while (true) {
    const value = await askQuestion(prompt, question);
    if (value) {
      return value;
    }

    console.error(errorMessage);
  }
}

async function promptManualCreatorId(prompt) {
  while (true) {
    const enteredCreatorId = await askQuestion(prompt, "ROBLOX_CREATOR_ID (numeric): ");
    if (!enteredCreatorId) {
      console.error("ROBLOX_CREATOR_ID cannot be empty.");
      continue;
    }

    try {
      return parseCreatorId(enteredCreatorId);
    } catch (err) {
      console.error(err.message);
    }
  }
}

async function promptCreatorId(prompt, roblosecurity) {
  const creatorIdInput = await askQuestion(
    prompt,
    "ROBLOX_CREATOR_ID (leave blank to auto-resolve from ROBLOSECURITY): "
  );

  if (creatorIdInput) {
    try {
      return parseCreatorId(creatorIdInput);
    } catch (err) {
      console.error(err.message);
      return promptManualCreatorId(prompt);
    }
  }

  try {
    const resolvedCreatorId = await resolveAuthenticatedUserId(
      normalizeCookieOverride(roblosecurity)
    );
    console.log(`[uploader env] Auto-resolved ROBLOX_CREATOR_ID: ${resolvedCreatorId}`);
    return parseCreatorId(resolvedCreatorId);
  } catch (err) {
    console.warn(`[uploader env] Auto-resolve failed: ${err.message}`);
    return promptManualCreatorId(prompt);
  }
}

async function runUploaderEnv(argv) {
  let args;
  try {
    args = parseEnvArgs(argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.log(ENV_HELP_TEXT);
    process.exit(1);
  }

  if (args.help) {
    console.log(ENV_HELP_TEXT);
    process.exit(0);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("uploader env requires an interactive terminal.");
  }

  if (fs.existsSync(LOCAL_UPLOADER_ENV_PATH)) {
    console.log(`Updating existing uploader credentials in ${LOCAL_UPLOADER_ENV_PATH}`);
  } else {
    console.log(`Saving uploader credentials to ${LOCAL_UPLOADER_ENV_PATH}`);
  }

  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    const apiKey = await promptRequiredValue(
      prompt,
      "ROBLOX_API_KEY: ",
      "ROBLOX_API_KEY cannot be empty."
    );
    const roblosecurity = await promptRequiredValue(
      prompt,
      ".ROBLOSECURITY value (without .ROBLOSECURITY= prefix): ",
      "ROBLOSECURITY cannot be empty."
    );
    const creatorId = await promptCreatorId(prompt, roblosecurity);

    writeUploaderEnv({ apiKey, roblosecurity, creatorId });
  } finally {
    prompt.close();
  }

  console.log(`Saved uploader credentials to ${LOCAL_UPLOADER_ENV_PATH}`);
}

async function runUploaderServe(argv) {
  let args;
  try {
    args = parseServeArgs(argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.log(SERVE_HELP_TEXT);
    process.exit(1);
  }

  if (args.help) {
    console.log(SERVE_HELP_TEXT);
    process.exit(0);
  }

  const { startServer } = require("../uploader/serve");
  startServer({ port: args.port });
}

function createProgressPrinter(label) {
  let lastMessage = "";
  return (done, total, message) => {
    const output = `[${label}] ${done}/${total} ${message}`;
    if (output === lastMessage) {
      return;
    }
    lastMessage = output;
    console.log(output);
  };
}

function printUploadReport(report) {
  const results = report.results || [];
  const moderated = report.moderated || [];
  const failures = report.failures || [];

  console.log("");
  console.log(
    `Upload completed: ${results.length} succeeded, ` +
      `${moderated.length} moderated, ${failures.length} failed.`
  );

  if (results.length > 0) {
    console.log("Successful uploads:");
    for (const entry of results) {
      console.log(`  ✓ ${entry.oldId} -> ${entry.newId}`);
    }
  }

  if (moderated.length > 0) {
    console.warn("Moderated uploads:");
    for (const entry of moderated) {
      console.warn(`  ! ${entry.oldId} -> ${entry.newId} (${entry.state})`);
    }
  }

  if (failures.length > 0) {
    console.error("Failed uploads:");
    for (const entry of failures) {
      console.error(`  x ${entry.assetId} [${entry.stage}] ${entry.error}`);
    }
  }
}

async function runUploaderUpload(argv) {
  if (!argv[0] || argv[0] === "-h" || argv[0] === "--help") {
    console.log(UPLOAD_HELP_TEXT);
    process.exit(argv[0] ? 0 : 1);
  }

  let args;
  try {
    args = parseUploadArgs(argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.log(UPLOAD_HELP_TEXT);
    process.exit(1);
  }

  if (args.help) {
    console.log(UPLOAD_HELP_TEXT);
    process.exit(0);
  }

  const {
    uploadAnimations,
    uploadImageFiles,
    uploadImages,
    uploadMeshes,
    uploadModelFiles,
    resolveCreatorId,
  } = require("../uploader/asset-upload");

  if (args.mode === "meshes" && args.useRemoteExec) {
    if (!args.creatorId) {
      console.log(
        "[uploader] --remote-exec mesh uploads default to your active Studio user unless --creator-id is provided."
      );
    }

    const report = await uploadMeshesViaRemoteExec({
      assetIDs: args.targets,
      creatorID: args.creatorId,
      cookie: args.cookie || undefined,
      isGroup: args.isGroup,
      remotePort: args.remotePort,
      remoteTimeout: args.remoteTimeout,
      onProgress: createProgressPrinter("meshes-remote"),
    });

    printUploadReport(report);
    if (report.failures && report.failures.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  let creatorId;
  try {
    creatorId = await resolveCreatorId({
      creatorID: args.creatorId,
      isGroup: args.isGroup,
      cookie: args.cookie || null,
    });
  } catch (err) {
    if (!args.creatorId && !args.isGroup) {
      throw new Error(`${err.message}\nTry passing --creator-id explicitly.`);
    }
    throw err;
  }

  if (!args.creatorId) {
    console.log(`[uploader] Auto-resolved creator ID: ${creatorId}`);
  }

  const commonArgs = {
    creatorID: creatorId,
    isGroup: args.isGroup,
    onProgress: createProgressPrinter(args.mode),
  };

  let report;
  if (args.mode === "image-files") {
    report = await uploadImageFiles({
      ...commonArgs,
      filePaths: args.targets,
      apiKey: args.apiKey || undefined,
    });
  } else if (args.mode === "model-files") {
    report = await uploadModelFiles({
      ...commonArgs,
      filePaths: args.targets,
      apiKey: args.apiKey || undefined,
    });
  } else if (args.mode === "images") {
    report = await uploadImages({
      ...commonArgs,
      assetIDs: args.targets,
      apiKey: args.apiKey || undefined,
      cookie: args.cookie || undefined,
    });
  } else if (args.mode === "animations") {
    report = await uploadAnimations({
      ...commonArgs,
      assetIDs: args.targets,
      cookie: args.cookie || undefined,
    });
  } else {
    report = await uploadMeshes({
      ...commonArgs,
      assetIDs: args.targets,
      apiKey: args.apiKey || undefined,
      cookie: args.cookie || undefined,
    });
  }

  printUploadReport(report);
  if (report.failures && report.failures.length > 0) {
    process.exitCode = 1;
  }
}

async function runUploader(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "-h" || command === "--help") {
    console.log(FULL_HELP_TEXT);
    process.exit(command ? 0 : 1);
  }

  if (command === "env") {
    await runUploaderEnv(rest);
    return;
  }

  if (command === "serve") {
    await runUploaderServe(rest);
    return;
  }

  if (
    command === "images" ||
    command === "animations" ||
    command === "meshes" ||
    command === "image" ||
    command === "model" ||
    command === "image-files" ||
    command === "model-files"
  ) {
    await runUploaderUpload([command, ...rest]);
    return;
  }

  if (command === "upload") {
    await runUploaderUpload(rest);
    return;
  }

  throw new Error(`Unknown uploader command: ${command}`);
}

module.exports = { runUploader };