"use strict";

const readline = require("readline");
const {
  createServer,
  DEFAULT_PORT,
  DEFAULT_SEND_TIMEOUT_MS,
} = require("../remote-exec/server");

const HELP_TEXT = `
sof run remote-exec - Bidirectional localhost execution bridge for Roblox Studio

USAGE:
  sof run remote-exec [options]

OPTIONS:
  --port <port>            WebSocket port to listen on (default: ${DEFAULT_PORT})
  --timeout <ms>           send() timeout in milliseconds (default: ${DEFAULT_SEND_TIMEOUT_MS})
  --multi                  Start REPL in multi-line mode
  -h, --help               Show this help message

REPL COMMANDS:
  .help                    Show REPL help
  .status                  Show plugin connection state
  .cancel                  Clear buffered block (--multi mode only)
  .exit                    Close server and exit
  <lua code>               Execute Luau script (or append line in --multi mode)
`;

function parsePort(valueRaw) {
  const value = Number.parseInt(String(valueRaw || "").trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid port "${valueRaw}".`);
  }
  return value;
}

function parseTimeout(valueRaw) {
  const value = Number.parseInt(String(valueRaw || "").trim(), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid timeout "${valueRaw}".`);
  }
  return value;
}

function parseArgs(argv) {
  const output = {
    help: false,
    port: DEFAULT_PORT,
    timeout: DEFAULT_SEND_TIMEOUT_MS,
    multiLine: false,
  };

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

    if (arg === "--timeout") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--timeout requires a value.");
      }
      output.timeout = parseTimeout(value);
      index += 1;
      continue;
    }

    if (arg === "--multi") {
      output.multiLine = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return output;
}

function formatResult(value) {
  if (value === null || value === undefined) {
    return "nil";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

async function runRepl(server, timeoutMs, multiLine) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("remote-exec REPL requires an interactive terminal.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 500,
  });

  let isExecuting = false;
  let shuttingDown = false;
  let multiLineBuffer = multiLine ? [] : null;

  const exitRepl = () =>
    new Promise((resolve) => {
      if (shuttingDown) {
        resolve();
        return;
      }
      shuttingDown = true;
      rl.close();
      resolve();
    });

  rl.on("SIGINT", () => {
    rl.write("\n");
    void exitRepl();
  });

  console.log("REPL ready. Type Luau code and press Enter.");
  if (multiLine) {
    console.log('Multi-line mode enabled: Enter a blank line to submit. Use ".cancel" to clear.');
  }
  console.log('Use ".help" for commands.');
  rl.setPrompt(multiLine ? "luau>> " : "luau> ");
  rl.prompt();

  const printHelp = () => {
    if (multiLine) {
      console.log("Commands: .help, .status, .cancel, .exit");
      return;
    }
    console.log("Commands: .help, .status, .exit");
  };

  const executeScript = async (scriptSource) => {
    isExecuting = true;
    try {
      const result = await server.send(scriptSource, { timeout: timeoutMs });
      console.log(`=> ${formatResult(result)}`);
    } catch (error) {
      console.error(`x ${error.message}`);
    } finally {
      isExecuting = false;
      if (!shuttingDown) {
        rl.prompt();
      }
    }
  };

  rl.on("line", async (line) => {
    const source = String(line || "");
    const input = source.trim();

    if (input === ".help") {
      printHelp();
      rl.prompt();
      return;
    }

    if (input === ".status") {
      console.log(server.connected ? "Connected" : "Waiting for plugin connection...");
      rl.prompt();
      return;
    }

    if (input === ".exit" || input === ".quit") {
      await exitRepl();
      return;
    }

    if (multiLine && input === ".cancel") {
      multiLineBuffer = [];
      console.log("Cleared buffered multi-line input.");
      rl.prompt();
      return;
    }

    if (isExecuting) {
      console.log("A script is already running. Wait for the current request to finish.");
      rl.prompt();
      return;
    }

    if (multiLine) {
      if (!input) {
        if (!multiLineBuffer || multiLineBuffer.length === 0) {
          rl.prompt();
          return;
        }
        const scriptSource = multiLineBuffer.join("\n");
        multiLineBuffer = [];
        await executeScript(scriptSource);
        return;
      }

      multiLineBuffer.push(source);
      if (!shuttingDown) {
        rl.prompt();
      }
      return;
    }

    if (!input) {
      rl.prompt();
      return;
    }

    await executeScript(source);
  });

  await new Promise((resolve) => {
    rl.on("close", resolve);
  });
}

async function runRemoteExec(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.log(HELP_TEXT);
    process.exit(1);
  }

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const server = await createServer({
    port: args.port,
    defaultTimeout: args.timeout,
  });

  let didClose = false;
  const closeServer = async () => {
    if (didClose) {
      return;
    }
    didClose = true;
    await server.close();
  };

  server.on("connected", () => {
    console.log("[remote-exec] Plugin connected.");
  });

  server.on("disconnected", () => {
    console.log("[remote-exec] Plugin disconnected.");
  });

  server.on("error", (error) => {
    console.error(`[remote-exec] ${error.message}`);
  });

  const handleSignal = async () => {
    await closeServer();
    process.exit(0);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    console.log(`[remote-exec] Listening on ws://127.0.0.1:${args.port}`);
    console.log("[remote-exec] Start the Roblox plugin to connect.");
    await runRepl(server, args.timeout, args.multiLine);
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    await closeServer();
  }
}

module.exports = {
  runRemoteExec,
};
