"use strict";

const {
    DEFAULT_PORT,
    DEFAULT_HOST,
} = require("../editable-mesh-bypasser/test");

const HELP_TEXT = `
sof run editable-mesh-bypasser - Asset proxy with mesh parsing and image downscaling

USAGE:
  sof run editable-mesh-bypasser [options]

ENDPOINTS:
  GET /asset?id=<assetId>[&version=<v>]        Fetch and optionally downscale an asset
  GET /mesh?id=<assetId>[&version=<v>][&pretty=1]  Fetch and parse a Roblox mesh

OPTIONS:
  --port <port>            HTTP port to listen on (default: ${DEFAULT_PORT})
  --host <host>            Host interface to bind (default: ${DEFAULT_HOST})
  -h, --help               Show this help message

CREDENTIALS:
  Uses ROBLOSECURITY from "sof run uploader env".
  Run that command first if you haven't configured credentials yet.
`;

function parseArgs(argv) {
    const output = {
        help: false,
        port: DEFAULT_PORT,
        host: DEFAULT_HOST,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === "-h" || arg === "--help") {
            output.help = true;
            continue;
        }

        if (arg === "--port") {
            const raw = argv[index + 1];
            if (!raw || raw.startsWith("-")) {
                throw new Error("--port requires a numeric value.");
            }
            const port = Number.parseInt(raw, 10);
            if (!Number.isFinite(port) || port < 1 || port > 65535) {
                throw new Error(`Invalid port number: ${raw}`);
            }
            output.port = port;
            index += 1;
            continue;
        }

        if (arg === "--host") {
            const value = String(argv[index + 1] || "").trim();
            if (!value || value.startsWith("-")) {
                throw new Error("--host requires a value.");
            }
            output.host = value;
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

async function runEditableMeshBypasser(argv) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (err) {
        console.error(`Error: ${err.message}`);
        console.log(HELP_TEXT);
        process.exit(1);
    }

    if (args.help) {
        console.log(HELP_TEXT);
        process.exit(0);
    }

    const { startServer } = require("../editable-mesh-bypasser/test");
    startServer({ port: args.port, host: args.host });
}

module.exports = { runEditableMeshBypasser };
