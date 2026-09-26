"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const childProcess = require("child_process");
const fg = require("fast-glob");
const { resolveOutputDefault } = require("../output-config");
const { obfuscate } = require("../obfuscator");

const HELP_TEXT = `
sof run obfuscate - Obfuscate Luau source files (pure JavaScript pipeline)

USAGE:
  sof run obfuscate <input...> [options]

ARGUMENTS:
  input                   One or more .luau files, directories, or glob patterns

EXAMPLES:
  sof run obfuscate src/main.luau
  sof run obfuscate src/main.luau src/utils.luau -o build/
  sof run obfuscate src/ServerScriptService/ -o build/obfuscated/
  sof run obfuscate src/**/*.luau --output dist/

OPTIONS:
  -o, --output <path>     Output file (single input) or directory (multiple inputs)
  --suffix <text>         Suffix appended to filenames when no explicit output (default: none)
  --no-minify             Skip minification of obfuscated output
  -h, --help              Show this help message

NOTES:
  If no --output is given, [output].obfuscate from sof.toml is used when set.
  When the output resolves to a directory, each input file is obfuscated into
  that directory preserving its basename.
`;

function parseArgs(argv) {
  const parsed = {
    inputs: [],
    outputPath: null,
    suffix: "",
    minify: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help" || arg === "help") {
      parsed.help = true;
      continue;
    }

    if (arg === "-o" || arg === "--output" || arg === "--out") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a path argument.`);
      }
      parsed.outputPath = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--output=")) {
      parsed.outputPath = arg.slice("--output=".length);
      continue;
    }

    if (arg.startsWith("--out=")) {
      parsed.outputPath = arg.slice("--out=".length);
      continue;
    }

    if (arg === "--suffix") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--suffix requires a value.");
      }
      parsed.suffix = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--suffix=")) {
      parsed.suffix = arg.slice("--suffix=".length);
      continue;
    }

    if (arg === "--no-minify") {
      parsed.minify = false;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    parsed.inputs.push(arg);
  }

  return parsed;
}

function collectLuauFiles(inputPaths) {
  const files = new Set();

  for (const inputArg of inputPaths) {
    const resolved = path.resolve(inputArg);

    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);

      if (stat.isFile()) {
        if (!resolved.toLowerCase().endsWith(".luau")) {
          throw new Error(`Input file is not a .luau file: ${inputArg}`);
        }
        files.add(resolved);
        continue;
      }

      if (stat.isDirectory()) {
        const found = fg.sync("**/*.luau", {
          cwd: resolved,
          absolute: true,
          onlyFiles: true,
        });
        for (const filePath of found) {
          files.add(path.resolve(filePath));
        }
        continue;
      }
    }

    const globbed = fg.sync(inputArg, {
      absolute: true,
      onlyFiles: true,
    });

    if (globbed.length === 0) {
      throw new Error(`No files matched: ${inputArg}`);
    }

    for (const filePath of globbed) {
      if (filePath.toLowerCase().endsWith(".luau")) {
        files.add(path.resolve(filePath));
      }
    }
  }

  return Array.from(files).sort((a, b) => a.localeCompare(b));
}

function resolveOutput(args) {
  if (args.outputPath) {
    return path.resolve(args.outputPath);
  }

  const configDefault = resolveOutputDefault(null, "obfuscate");
  if (configDefault) {
    return path.resolve(configDefault);
  }

  return null;
}

function looksLikeDirectory(outputPath) {
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
    return true;
  }
  return (
    outputPath.endsWith("/") ||
    outputPath.endsWith("\\") ||
    path.extname(outputPath) === ""
  );
}

function computeOutputForFile(inputFile, outputBase, suffix, isMultiFile, inputBasePath) {
  if (!outputBase) {
    const ext = path.extname(inputFile);
    const base = path.basename(inputFile, ext);
    return path.join(path.dirname(inputFile), `${base}${suffix || ".obf"}${ext}`);
  }

  if (!isMultiFile && !looksLikeDirectory(outputBase)) {
    return outputBase;
  }

  const dirOutput = outputBase;
  fs.mkdirSync(dirOutput, { recursive: true });

  if (inputBasePath) {
    const relative = path.relative(inputBasePath, inputFile);
    return path.join(dirOutput, relative);
  }

  return path.join(dirOutput, path.basename(inputFile));
}

function findCommonBase(files) {
  if (files.length <= 1) {
    return null;
  }

  const dirs = files.map((f) => path.dirname(f));
  let common = dirs[0];
  for (let i = 1; i < dirs.length; i += 1) {
    while (!dirs[i].startsWith(common + path.sep) && dirs[i] !== common) {
      common = path.dirname(common);
    }
  }
  return common;
}

function stripLuaminHeader(text) {
  return String(text || "").replace(
    /^\s*--\[\[[\s\S]*?Code generated using[\s\S]*?--\]\]\s*/i,
    ""
  );
}

function minifySource(source) {
  const luamin = require("lua-format");
  const minified = luamin.Minify(source, {
    RenameVariables: false,
    RenameGlobals: false,
    SolveMath: false,
  });
  return stripLuaminHeader(minified);
}

const TERM_LOG_DIR = path.join(os.tmpdir(), "sof-obfuscate-log-terminals");
const TERMINAL_BANNER = [
  "╔════════════════════════════════════════════════════════════╗",
  "║                SOF OBFUSCATOR LIVE LOG                    ║",
  "║                 Hello, Professor739!                      ║",
  "╚════════════════════════════════════════════════════════════╝",
];
const ANSI = {
  reset: "\x1b[0m",
  brightWhite: "\x1b[97m",
  brightCyan: "\x1b[96m",
  brightMagenta: "\x1b[95m",
  brightYellow: "\x1b[93m",
  brightGreen: "\x1b[92m",
  darkGray: "\x1b[90m",
};
const CACHE_ROOT = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "sof", "cache")
  : path.join(os.homedir(), ".sof", "cache");
const SPEECH_COUNTER_PATH = path.join(CACHE_ROOT, "obfuscate-speech-counter.json");
const SPEECH_INTERVAL_RUNS = 3;
const ACCESSIBILITY_SESSION = {
  initialized: false,
  queuePath: null,
  viewerScriptPath: null,
};

let speechQueue = Promise.resolve();
let sayModule = null;
let sayModuleLoaded = false;
let figletModule = null;
let figletModuleLoaded = false;

function isAccessibilityHost() {
  return process.platform === "win32";
}

function shouldSpawnAccessibleTerminal() {
  return isAccessibilityHost() && process.env.SOF_DISABLE_TERMINAL_LOG_WINDOWS !== "1";
}

function shouldSpeakLogMessages() {
  return isAccessibilityHost() && process.env.SOF_DISABLE_TERMINAL_LOG_SPEECH !== "1";
}

function readSpeechCounter() {
  try {
    if (!fs.existsSync(SPEECH_COUNTER_PATH)) {
      return 0;
    }
    const parsed = JSON.parse(fs.readFileSync(SPEECH_COUNTER_PATH, "utf8"));
    if (!parsed || typeof parsed.runCount !== "number" || !Number.isFinite(parsed.runCount)) {
      return 0;
    }
    return Math.max(0, Math.floor(parsed.runCount));
  } catch (_err) {
    return 0;
  }
}

function writeSpeechCounter(runCount) {
  try {
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    fs.writeFileSync(
      SPEECH_COUNTER_PATH,
      JSON.stringify(
        {
          runCount,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  } catch (_err) {
    // Non-fatal: if cache write fails, command still works.
  }
}

function registerObfuscateRunForSpeech() {
  const runCount = readSpeechCounter() + 1;
  writeSpeechCounter(runCount);
  return {
    runCount,
    shouldSpeak: runCount % SPEECH_INTERVAL_RUNS === 0,
  };
}

function loadSayModule() {
  if (sayModuleLoaded) {
    return sayModule;
  }
  sayModuleLoaded = true;
  try {
    sayModule = require("say");
  } catch (_err) {
    sayModule = null;
  }
  return sayModule;
}

function shouldPrintLargeTerminalText() {
  return process.env.SOF_DISABLE_LARGE_TERMINAL_TEXT !== "1";
}

function loadFigletModule() {
  if (figletModuleLoaded) {
    return figletModule;
  }
  figletModuleLoaded = true;
  try {
    figletModule = require("figlet");
  } catch (_err) {
    figletModule = null;
  }
  return figletModule;
}

function sanitizeLargeText(text, maxLength) {
  const cleaned = String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "LOG";
  }
  return cleaned.slice(0, maxLength);
}

function colorize(text, color) {
  return `${color}${text}${ANSI.reset}`;
}

function summarizeLogForLargeFont(logMessage) {
  const upper = sanitizeLargeText(logMessage, 64);
  if (upper.includes("ERROR")) return "ERROR";
  if (upper.startsWith("DONE")) return "DONE";
  if (upper.startsWith("OBFUSCATING")) return "OBFUSCATING";
  if (upper.startsWith("OUTPUT")) return "OUTPUT";
  if (upper.includes("SUCCEEDED")) return "SUCCESS";
  if (upper.includes("FAILED")) return "FAILED";
  return sanitizeLargeText(upper, 20);
}

function printLargeAccessibilityText(logMessage) {
  if (!shouldPrintLargeTerminalText()) {
    return;
  }

  const figlet = loadFigletModule();
  if (!figlet || typeof figlet.textSync !== "function") {
    return;
  }

  const loudMessages = [
    { text: "HELLO", color: ANSI.brightCyan },
    { text: "PROFESSOR739", color: ANSI.brightMagenta },
    { text: summarizeLogForLargeFont(logMessage), color: ANSI.brightYellow },
  ];

  for (const loud of loudMessages) {
    try {
      const rendered = figlet.textSync(loud.text, {
        font: "ANSI Shadow",
        width: 220,
        horizontalLayout: "default",
        verticalLayout: "default",
        whitespaceBreak: true,
      });
      console.log("");
      console.log(colorize(rendered, loud.color));
      console.log("");
    } catch (_err) {
      console.log(colorize(`*** ${loud.text} ***`, loud.color));
    }
  }
}

function createAiSignature(message) {
  const digest = crypto.createHash("sha1").update(message).digest("hex").slice(0, 12).toUpperCase();
  return `GX-739::${digest}`;
}

function buildAccessibilityViewerScript() {
  return [
    "param([Parameter(Mandatory=$true)][string]$QueuePath)",
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$Host.UI.RawUI.WindowTitle = 'SOF AI Accessibility Stream - Professor739'",
    "if (!(Test-Path $QueuePath)) { New-Item -ItemType File -Path $QueuePath -Force | Out-Null }",
    "Write-Host ''",
    "Write-Host '+------------------------------------------------------------+' -ForegroundColor Cyan",
    "Write-Host '|         AI STREAM FORMAT :: PROFESSOR739 ONLINE           |' -ForegroundColor Cyan",
    "Write-Host '|      HUMAN READABLE, AI PROTOCOL TAGS ENABLED             |' -ForegroundColor DarkGray",
    "Write-Host '+------------------------------------------------------------+' -ForegroundColor Cyan",
    "Write-Host ''",
    "Get-Content -Path $QueuePath -Wait | ForEach-Object {",
    "  $line = $_",
    "  if ([string]::IsNullOrWhiteSpace($line)) { return }",
    "  try { $event = $line | ConvertFrom-Json } catch {",
    "    Write-Host $line -ForegroundColor Yellow",
    "    return",
    "  }",
    "  Write-Host ''",
    "  Write-Host '+--[AI-FRAME:GX739]------------------------------------------+' -ForegroundColor DarkCyan",
    "  Write-Host ('| [FRAME] ' + $event.frame + '    [SIG] ' + $event.sig) -ForegroundColor Magenta",
    "  Write-Host ('| [TIME]  ' + $event.ts) -ForegroundColor Gray",
    "  Write-Host ('| [LOG]   ' + $event.msg) -ForegroundColor Yellow",
    "  Write-Host '+------------------------------------------------------------+' -ForegroundColor DarkCyan",
    "}",
  ].join("\r\n");
}

function ensureSingleAccessibleTerminal() {
  if (!shouldSpawnAccessibleTerminal()) {
    return null;
  }
  if (ACCESSIBILITY_SESSION.initialized && ACCESSIBILITY_SESSION.queuePath) {
    return ACCESSIBILITY_SESSION.queuePath;
  }

  fs.mkdirSync(TERM_LOG_DIR, { recursive: true });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const queuePath = path.join(TERM_LOG_DIR, `ai-stream-${id}.jsonl`);
  const viewerScriptPath = path.join(TERM_LOG_DIR, `ai-stream-viewer-${id}.ps1`);

  fs.writeFileSync(queuePath, "", "utf8");
  fs.writeFileSync(viewerScriptPath, buildAccessibilityViewerScript(), "utf8");

  const viewerProcess = childProcess.spawn(
    "powershell",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      viewerScriptPath,
      "-QueuePath",
      queuePath,
    ],
    {
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    }
  );
  viewerProcess.unref();

  ACCESSIBILITY_SESSION.initialized = true;
  ACCESSIBILITY_SESSION.queuePath = queuePath;
  ACCESSIBILITY_SESSION.viewerScriptPath = viewerScriptPath;
  return queuePath;
}

function writeToSingleAccessibilityTerminal(logMessage) {
  if (!shouldSpawnAccessibleTerminal()) {
    return;
  }
  try {
    const queuePath = ensureSingleAccessibleTerminal();
    if (!queuePath) {
      return;
    }
    const payload = {
      frame: "OMEGA::GX739::A11Y",
      sig: createAiSignature(logMessage),
      ts: new Date().toISOString(),
      msg: String(logMessage),
    };
    fs.appendFileSync(
      queuePath,
      `${JSON.stringify(payload)}${os.EOL}`,
      "utf8"
    );
  } catch (_err) {
    // Keep CLI logging resilient even if terminal message write fails.
  }
}

function createLogWindowMessage(logMessage) {
  const now = new Date();
  const stamp = now.toLocaleString();
  return [
    "",
    ...TERMINAL_BANNER,
    "",
    `  Timestamp: ${stamp}`,
    "  Accessibility Mode: single external AI log terminal",
    "",
    "  Message:",
    `  ${logMessage}`,
    "",
    "  (This window was spawned by sof run obfuscate)",
    "",
  ].join("\r\n");
}

function createTerminalScript(logMessage) {
  fs.mkdirSync(TERM_LOG_DIR, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const msgFile = path.join(TERM_LOG_DIR, `legacy-log-${id}.txt`);
  const batFile = path.join(TERM_LOG_DIR, `legacy-log-${id}.bat`);
  fs.writeFileSync(msgFile, createLogWindowMessage(logMessage), "utf8");
  fs.writeFileSync(
    batFile,
    ["@echo off", "chcp 65001 >nul 2>&1", `type "${msgFile}"`].join("\r\n"),
    "utf8"
  );
  return batFile;
}

function spawnAccessibleLogTerminal(logMessage) {
  // Kept for compatibility, but now routes to the single external terminal stream.
  void logMessage;
  ensureSingleAccessibleTerminal();
}

function speakText(text) {
  if (!shouldSpeakLogMessages()) {
    return Promise.resolve();
  }
  const normalizedText = String(text || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedText) {
    return Promise.resolve();
  }

  const speakWindows = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };

      const psCommand = [
        "Add-Type -AssemblyName System.Speech;",
        "$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
        "$speaker.Rate = 0;",
        "$speaker.Speak([Console]::In.ReadToEnd());",
        "$speaker.Dispose();",
      ].join("");

      let child;
      try {
        child = childProcess.spawn(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", psCommand],
          {
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "ignore", "ignore"],
          }
        );
      } catch (_err) {
        finish();
        return;
      }

      child.on("error", finish);
      child.on("close", finish);
      child.stdin.end(normalizedText, "utf8");

      setTimeout(() => {
        if (done) return;
        try {
          child.kill();
        } catch (_err) {
          // ignore kill failures
        }
        finish();
      }, 15000);
    });

  const speakNonWindows = () =>
    new Promise((resolve) => {
      const say = loadSayModule();
      if (!say || typeof say.speak !== "function") {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        say.speak(normalizedText, undefined, 1.0, finish);
      } catch (_err) {
        finish();
        return;
      }
      setTimeout(finish, 15000);
    });

  speechQueue = speechQueue
    .catch(() => {})
    .then(() => (process.platform === "win32" ? speakWindows() : speakNonWindows()));
  return speechQueue;
}

function speakRunSummary(runCount, succeeded, failed, total) {
  if (failed > 0) {
    return speakText(
      `Professor seven three nine. Obfuscate run ${runCount}. ${failed} failed, ${succeeded} succeeded out of ${total} files.`
    );
  }
  return speakText(
    `Professor seven three nine. Obfuscate run ${runCount} completed. ${succeeded} files succeeded.`
  );
}

function obfuscateLog(...args) {
  const message = args.map((arg) => String(arg)).join(" ");
  console.log(colorize(message, ANSI.brightWhite));
  if (!message.trim()) {
    return;
  }
  printLargeAccessibilityText(message);
  writeToSingleAccessibilityTerminal(message);
}

function formatThrownError(err) {
  if (err instanceof Error) {
    if (err.message && err.message.trim()) {
      return err.message.trim();
    }
    return err.name || "Unknown Error";
  }
  if (typeof err === "string") {
    return err.trim() || "Unknown error string";
  }
  if (err == null) {
    return "Unknown error (null or undefined was thrown)";
  }
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") {
      return `Non-Error thrown: ${json}`;
    }
  } catch (_err) {
    // fall through to String()
  }
  return `Non-Error thrown: ${String(err)}`;
}

async function runObfuscate(argv) {
  const args = parseArgs(argv || []);

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (args.inputs.length === 0) {
    throw new Error("No input files specified. Run with --help for usage.");
  }

  const luauFiles = collectLuauFiles(args.inputs);
  if (luauFiles.length === 0) {
    throw new Error("No .luau files found in the provided input(s).");
  }

  const outputBase = resolveOutput(args);
  const isMultiFile = luauFiles.length > 1;
  const commonBase = findCommonBase(luauFiles);
  const speechRun = registerObfuscateRunForSpeech();

  obfuscateLog(`Obfuscating ${luauFiles.length} file(s) via JS pipeline...`);
  if (outputBase) {
    obfuscateLog(`Output: ${path.relative(process.cwd(), outputBase) || outputBase}`);
  }
  console.log();

  let succeeded = 0;
  let failed = 0;

  for (const inputFile of luauFiles) {
    const outputFile = computeOutputForFile(
      inputFile,
      outputBase,
      args.suffix,
      isMultiFile,
      commonBase
    );

    const outputDir = path.dirname(outputFile);
    fs.mkdirSync(outputDir, { recursive: true });

    const displayInput = path.relative(process.cwd(), inputFile) || inputFile;
    const displayOutput = path.relative(process.cwd(), outputFile) || outputFile;
    obfuscateLog(`[${succeeded + failed + 1}/${luauFiles.length}] ${displayInput}`);

    try {
      const source = fs.readFileSync(inputFile, "utf8");
      let outputSource = obfuscate(source);
      if (args.minify) {
        outputSource = minifySource(outputSource);
      }
      fs.writeFileSync(outputFile, outputSource, "utf8");
      obfuscateLog(`  -> ${displayOutput}`);
      succeeded += 1;
    } catch (err) {
      obfuscateLog(`  Error: ${formatThrownError(err)}`);
      failed += 1;
    }
  }

  console.log();
  obfuscateLog(
    `Done: ${succeeded} succeeded, ${failed} failed of ${luauFiles.length} file(s).`
  );

  if (speechRun.shouldSpeak) {
    await speakRunSummary(speechRun.runCount, succeeded, failed, luauFiles.length);
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

module.exports = {
  runObfuscate,
};
