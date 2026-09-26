"use strict";

const HELP_TEXT = `
sof run mesh-service - Start mesh extraction/reupload service

USAGE:
  sof run mesh-service [options]

OPTIONS:
  --port <port>            HTTP port to listen on (default: 5000)
  --host <host>            Host interface to bind (default: 0.0.0.0)
  -h, --help               Show this help message
`;

function parseArgs(argv) {
    const output = {
        help: false,
        port: 5000,
        host: "0.0.0.0"
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

async function runMeshService(argv) {
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

    const { startMeshService } = require("../mesh/service");
    startMeshService({ port: args.port, host: args.host });
}

module.exports = { runMeshService };
