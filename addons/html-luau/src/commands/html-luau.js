"use strict";

const fs = require("fs");
const path = require("path");
const { compile, compileWithImageUpload } = require("../html-to-luau");
const { resolveOutputDefault } = require("../output-config");

const HELP_TEXT = `
sof run html-luau - Compile HTML files into Luau runtime UI files

USAGE:
  sof run html-luau <path> [output]

ARGUMENTS:
  path                  HTML file or directory to compile
  output                Output file or directory
                        (default: same location with .luau extension)

OPTIONS:
  -w, --watch           Watch for changes and recompile
  --upload-images       Upload <img src> files/URLs via sof uploader
  --image-cache <path>  Image upload cache file (default: ~/.sof/html-luau-image-cache.json)
  --api-key <key>       Roblox Open Cloud API key (optional if configured in uploader env)
  --creator-id <id>     Roblox creator ID (optional if configured in uploader env)
  --group               Treat creator ID as a group ID for uploads
  --no-strict           Omit --!strict pragma
  --optimize <n>        Optimization level (default: 2, use 'none' to omit)
  -v, --verbose         Verbose logging
  -h, --help            Show this help message
`;

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    watch: false,
    uploadImages: false,
    imageCachePath: null,
    apiKey: null,
    creatorId: null,
    isGroup: false,
    strict: true,
    optimize: 2,
    verbose: false,
    help: false,
  };

  const positional = [];
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];

    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-w":
      case "--watch":
        args.watch = true;
        break;
      case "--upload-images":
        args.uploadImages = true;
        break;
      case "--image-cache": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new Error("--image-cache requires a value.");
        }
        args.imageCachePath = value;
        index += 1;
        break;
      }
      case "--api-key": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new Error("--api-key requires a value.");
        }
        args.apiKey = value;
        index += 1;
        break;
      }
      case "--creator-id": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new Error("--creator-id requires a value.");
        }
        args.creatorId = value;
        index += 1;
        break;
      }
      case "--group":
        args.isGroup = true;
        break;
      case "--no-strict":
        args.strict = false;
        break;
      case "--optimize": {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new Error("--optimize requires a value.");
        }

        args.optimize = value === "none" ? null : parseInt(value, 10);
        if (value !== "none" && Number.isNaN(args.optimize)) {
          throw new Error(`Invalid --optimize value: ${value}`);
        }

        index += 1;
        break;
      }
      case "-v":
      case "--verbose":
        args.verbose = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positional.push(arg);
        break;
    }

    index += 1;
  }

  args.input = positional[0] || null;
  args.output = positional[1] || null;
  if (positional.length > 2) {
    throw new Error("html-luau accepts at most two positional arguments: <path> [output].");
  }

  return args;
}

async function compileFile(inputPath, outputPath, options) {
  const htmlContent = fs.readFileSync(inputPath, "utf8");
  const sourceFile = path.basename(inputPath);

  const compileOptions = {
    strict: options.strict,
    optimize: options.optimize,
    sourceFile,
  };

  const luauCode = options.uploadImages
    ? await compileWithImageUpload(htmlContent, {
        ...compileOptions,
        basePath: path.dirname(inputPath),
        apiKey: options.apiKey || undefined,
        creatorID: options.creatorId || undefined,
        isGroup: options.isGroup === true,
        imageCachePath: options.imageCachePath || undefined,
      })
    : compile(htmlContent, compileOptions);

  const outputDirectory = path.dirname(outputPath);
  if (!fs.existsSync(outputDirectory)) {
    fs.mkdirSync(outputDirectory, { recursive: true });
  }

  fs.writeFileSync(outputPath, luauCode, "utf8");

  if (options.verbose) {
    console.log(`  ${inputPath} -> ${outputPath}`);
  }

  return {
    input: inputPath,
    output: outputPath,
    size: luauCode.length,
  };
}

function collectHtmlFiles(directoryPath) {
  const files = [];

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.html?$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  walk(directoryPath);
  return files;
}

function resolveOutputPath(inputFilePath, outputArg, isInputDirectory, inputBasePath) {
  if (!outputArg) {
    return inputFilePath.replace(/\.html?$/i, ".luau");
  }

  if (isInputDirectory) {
    const relative = path.relative(inputBasePath, inputFilePath);
    const luauName = relative.replace(/\.html?$/i, ".luau");
    return path.join(outputArg, luauName);
  }

  if (
    outputArg.endsWith("/") ||
    outputArg.endsWith("\\") ||
    (fs.existsSync(outputArg) && fs.statSync(outputArg).isDirectory())
  ) {
    const luauName = path.basename(inputFilePath).replace(/\.html?$/i, ".luau");
    return path.join(outputArg, luauName);
  }

  return outputArg;
}

function startWatcher(inputPath, isInputDirectory, options) {
  let chokidar;
  try {
    chokidar = require("chokidar");
  } catch (_err) {
    console.error("Watch mode requires chokidar. Run: npm install chokidar");
    process.exit(1);
  }

  const pattern = isInputDirectory ? path.join(inputPath, "**/*.{html,htm}") : inputPath;
  console.log("\nWatching for changes...");

  const watcher = chokidar.watch(pattern, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200 },
  });

  watcher.on("change", async (filePath) => {
    const outputPath = resolveOutputPath(filePath, options.output, isInputDirectory, inputPath);
    try {
      const result = await compileFile(filePath, outputPath, options);
      const rel = path.relative(process.cwd(), result.output);
      console.log(`  ✓ ${rel} (${result.size} bytes) [updated]`);
    } catch (err) {
      console.error(`  ✗ ${path.basename(filePath)}: ${err.message}`);
    }
  });

  watcher.on("add", async (filePath) => {
    const outputPath = resolveOutputPath(filePath, options.output, isInputDirectory, inputPath);
    try {
      const result = await compileFile(filePath, outputPath, options);
      const rel = path.relative(process.cwd(), result.output);
      console.log(`  ✓ ${rel} (${result.size} bytes) [new]`);
    } catch (err) {
      console.error(`  ✗ ${path.basename(filePath)}: ${err.message}`);
    }
  });

  process.on("SIGINT", () => {
    console.log("\nStopping watcher...");
    watcher.close();
    process.exit(0);
  });
}

async function runHtmlLuau(argv) {
  const args = parseArgs(argv);

  if (args.help || !args.input) {
    console.log(HELP_TEXT);
    process.exit(args.help ? 0 : 1);
  }

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input path does not exist: ${inputPath}`);
  }

  const effectiveOutput = args.output ?? resolveOutputDefault(null, "html-luau") ?? null;

  const inputStat = fs.statSync(inputPath);
  const isInputDirectory = inputStat.isDirectory();
  const htmlFiles = isInputDirectory ? collectHtmlFiles(inputPath) : [inputPath];

  if (htmlFiles.length === 0) {
    throw new Error("No HTML files found.");
  }

  console.log(`Compiling ${htmlFiles.length} file(s)...`);

  let success = 0;
  let failed = 0;
  for (const filePath of htmlFiles) {
    const outputPath = resolveOutputPath(filePath, effectiveOutput, isInputDirectory, inputPath);

    try {
      const result = await compileFile(filePath, outputPath, args);
      success += 1;

      if (!args.verbose) {
        const rel = path.relative(process.cwd(), result.output);
        console.log(`  ✓ ${rel} (${result.size} bytes)`);
      }
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${path.basename(filePath)}: ${err.message}`);
      if (args.verbose) {
        console.error(err.stack);
      }
    }
  }

  console.log(`\nDone: ${success} compiled, ${failed} failed.`);

  if (args.watch) {
    startWatcher(inputPath, isInputDirectory, { ...args, output: effectiveOutput });
  }
}

module.exports = {
  runHtmlLuau,
};
