"use strict";

const fs = require("fs");
const https = require("https");
const path = require("path");
const toml = require("smol-toml");
const { loadUploaderEnv } = require("../uploader/env");

const HELP_TEXT = `
sof run place - Roblox place publishing helpers

USAGE:
  sof run place <publish|versions|rollback|info> [arguments] [options]

COMMANDS:
  publish
    sof run place publish [path/to/place.rbxlx] [options]
    Publish a place file

  versions
    sof run place versions [options]
    List recent place versions

  rollback
    sof run place rollback <version> [options]
    Roll back to a previous version

  info
    sof run place info [options]
    Show universe/place metadata

SHARED OPTIONS:
  --config <path/to/sof.toml>     Config path (default: ./sof.toml)
  --universe <id>                 Override universe ID
  --place <id>                    Override place ID
  --json                          Output JSON
  -h, --help                      Show this help message
`;

function displayPath(value) {
  const relative = path.relative(process.cwd(), value);
  return relative || ".";
}

function parseArgs(argv) {
  const output = {
    command: null,
    commandArgs: [],
    configPath: "sof.toml",
    universeId: "",
    placeId: "",
    json: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }
    if (arg === "--json") {
      output.json = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--config requires a value.");
      }
      output.configPath = value.trim();
      index += 1;
      continue;
    }
    if (arg === "--universe") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--universe requires a value.");
      }
      output.universeId = value.trim();
      index += 1;
      continue;
    }
    if (arg === "--place") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--place requires a value.");
      }
      output.placeId = value.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 0) {
    output.command = positional[0];
    output.commandArgs = positional.slice(1);
  }
  return output;
}

function readPlaceConfig(configPathArg) {
  const configPath = path.resolve(configPathArg || "sof.toml");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file does not exist: ${configPath}`);
  }

  let parsed = {};
  try {
    parsed = toml.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse TOML config at ${configPath}: ${err.message}`);
  }

  const place = parsed.place && typeof parsed.place === "object" ? parsed.place : {};
  return {
    configPath,
    universeId: place.universe_id ? String(place.universe_id).trim() : "",
    placeId: place.place_id ? String(place.place_id).trim() : "",
    filePath: place.file ? String(place.file).trim() : "",
  };
}

function resolveIds(args, config) {
  const universeId = args.universeId || config.universeId;
  const placeId = args.placeId || config.placeId;
  if (!/^\d+$/.test(universeId)) {
    throw new Error('Universe ID is required. Set [place].universe_id or pass --universe <id>.');
  }
  if (!/^\d+$/.test(placeId)) {
    throw new Error('Place ID is required. Set [place].place_id or pass --place <id>.');
  }
  return { universeId, placeId };
}

function createHeaders() {
  loadUploaderEnv();
  const apiKey = process.env.ROBLOX_API_KEY ? process.env.ROBLOX_API_KEY.trim() : "";
  if (!apiKey) {
    throw new Error(
      'ROBLOX_API_KEY is missing. Configure it with "sof run uploader env" or environment variables.'
    );
  }

  return {
    "x-api-key": apiKey,
    Connection: "close",
  };
}

function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const request = https.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode || 0,
            statusText: response.statusMessage || "",
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    request.on("error", (err) => reject(err));
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

async function requestJson(url, options) {
  const response = await requestText(url, options);
  const text = response.text;
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (_err) {
    parsed = {
      raw: text,
    };
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
  }

  return parsed;
}

async function runPublish(args, config, ids, headers) {
  const rawPath = args.commandArgs[0] || config.filePath;
  if (!rawPath) {
    throw new Error(
      "Place file path is required. Provide [place].file in sof.toml or pass publish [path/to/file.rbxlx]."
    );
  }

  const absoluteFilePath = path.resolve(rawPath);
  if (!fs.existsSync(absoluteFilePath) || !fs.statSync(absoluteFilePath).isFile()) {
    throw new Error(`Place file does not exist: ${absoluteFilePath}`);
  }

  const body = fs.readFileSync(absoluteFilePath);
  const endpoint =
    `https://apis.roblox.com/universes/v1/${ids.universeId}/places/${ids.placeId}/versions` +
    "?versionType=Published";

  const response = await requestText(endpoint, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/octet-stream",
    },
    body,
  });

  const text = response.text;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Publish failed (${response.status}): ${text}`);
  }

  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (_err) {
    parsed = { raw: text };
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          universeId: ids.universeId,
          placeId: ids.placeId,
          filePath: displayPath(absoluteFilePath),
          result: parsed,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Published ${displayPath(absoluteFilePath)} to universe ${ids.universeId}, place ${ids.placeId}.`);
  if (Object.keys(parsed).length > 0) {
    console.log(JSON.stringify(parsed, null, 2));
  }
}

async function runVersions(args, ids, headers) {
  const endpoint =
    `https://apis.roblox.com/universes/v1/${ids.universeId}/places/${ids.placeId}/versions?maxPageSize=20`;
  const payload = await requestJson(endpoint, {
    method: "GET",
    headers,
  });

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const entries = Array.isArray(payload.data) ? payload.data : [];
  console.log(`Place versions for universe ${ids.universeId}, place ${ids.placeId}:`);
  if (entries.length === 0) {
    console.log("  (no versions returned)");
    return;
  }
  for (const entry of entries) {
    const version = entry.versionNumber || entry.version || entry.id || "<unknown>";
    const created = entry.created || entry.createdTime || entry.createdAt || "";
    console.log(`  - ${version}${created ? ` (${created})` : ""}`);
  }
}

async function runRollback(args, ids, headers) {
  const version = args.commandArgs[0];
  if (!version) {
    throw new Error("rollback requires a version argument.");
  }

  const endpoint =
    `https://apis.roblox.com/universes/v1/${ids.universeId}/places/${ids.placeId}/versions/${encodeURIComponent(
      version
    )}:rollback`;
  const payload = await requestJson(endpoint, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Rollback requested for version ${version}.`);
  if (Object.keys(payload).length > 0) {
    console.log(JSON.stringify(payload, null, 2));
  }
}

async function runInfo(args, ids, headers) {
  const endpoint =
    `https://apis.roblox.com/cloud/v2/universes/${ids.universeId}/places/${ids.placeId}`;
  const payload = await requestJson(endpoint, {
    method: "GET",
    headers,
  });

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Universe ${ids.universeId}, place ${ids.placeId}`);
  console.log(JSON.stringify(payload, null, 2));
}

async function runPlace(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.command) {
    console.log(HELP_TEXT);
    process.exit(args.help ? 0 : 1);
  }

  const config = readPlaceConfig(args.configPath);
  const ids = resolveIds(args, config);
  const headers = createHeaders();

  console.log(`Using config: ${displayPath(config.configPath)}`);

  if (args.command === "publish") {
    await runPublish(args, config, ids, headers);
    return;
  }

  if (args.command === "versions") {
    await runVersions(args, ids, headers);
    return;
  }

  if (args.command === "rollback") {
    await runRollback(args, ids, headers);
    return;
  }

  if (args.command === "info") {
    await runInfo(args, ids, headers);
    return;
  }

  throw new Error(`Unknown place command: ${args.command}`);
}

module.exports = {
  runPlace,
};
