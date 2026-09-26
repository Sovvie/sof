"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fg = require("fast-glob");
const { readAutoTypesConfig } = require("../auto-types/config");
const {
  parseLuauModule,
  prewarmLanguageServerCacheMulti,
  toPascalCase,
} = require("../auto-types/parser");
const { generateTypeFile } = require("../auto-types/generator");

const CACHE_SCHEMA_VERSION = 2;
const DEFAULT_PARSE_CONCURRENCY = Math.max(2, Math.min(os.cpus().length || 4, 8));
// luau-lsp analyze is CPU + I/O heavy; limit concurrent spawns so the processes
// don't thrash the scheduler or interfere with sourcemap disk reads.
const DEFAULT_LSP_CONCURRENCY = Math.max(1, Math.min(Math.floor((os.cpus().length || 4) / 2), 4));

function hashBuffer(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

function resolveCachePath(configDirectory) {
  return path.join(configDirectory, ".sof-cache", "auto-types.json");
}

function readDiskCache(configDirectory) {
  const cachePath = resolveCachePath(configDirectory);
  if (!fs.existsSync(cachePath)) {
    return { schema: CACHE_SCHEMA_VERSION, files: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!parsed || parsed.schema !== CACHE_SCHEMA_VERSION || typeof parsed.files !== "object") {
      return { schema: CACHE_SCHEMA_VERSION, files: {} };
    }
    return parsed;
  } catch (_err) {
    return { schema: CACHE_SCHEMA_VERSION, files: {} };
  }
}

function writeDiskCache(configDirectory, cacheData) {
  const cachePath = resolveCachePath(configDirectory);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cacheData), "utf8");
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  const workers = [];
  for (let index = 0; index < limit; index += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

const HELP_TEXT = `
sof run auto-types - Compile Luau modules into a type file

USAGE:
  sof run auto-types [path/to/sof.toml]

ARGUMENTS:
  path/to/sof.toml          Optional config path (default: ./sof.toml)

OPTIONS:
  -w, --watch               Watch for Luau changes and recompile
  --stop-watch              Stop a running auto-types watcher
  -h, --help                Show this help message
`;

const WATCHER_LOCK_DIRECTORY = path.join(os.homedir(), ".sof");
const WATCHER_LOCK_PATH = path.join(WATCHER_LOCK_DIRECTORY, "auto-types-watcher.json");

function parseArgs(argv) {
  const output = { configPath: null, watch: false, stopWatch: false, help: false };
  const positional = [];

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "-w" || arg === "--watch") {
      output.watch = true;
      continue;
    }

    if (arg === "--stop-watch") {
      output.stopWatch = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("auto-types accepts at most one positional argument (the config path).");
  }

  output.configPath = positional[0] || null;
  return output;
}

function readWatcherLock() {
  if (!fs.existsSync(WATCHER_LOCK_PATH)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(WATCHER_LOCK_PATH, "utf8");
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function removeWatcherLock() {
  if (fs.existsSync(WATCHER_LOCK_PATH)) {
    fs.rmSync(WATCHER_LOCK_PATH);
  }
}

function writeWatcherLock(configPath) {
  fs.mkdirSync(WATCHER_LOCK_DIRECTORY, { recursive: true });
  const payload = {
    pid: process.pid,
    configPath: path.resolve(configPath),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };

  fs.writeFileSync(WATCHER_LOCK_PATH, JSON.stringify(payload, null, 2), "utf8");
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

function claimWatcherLock(configPath) {
  const existing = readWatcherLock();
  if (!existing || !Number.isInteger(existing.pid)) {
    removeWatcherLock();
    writeWatcherLock(configPath);
    return;
  }

  if (isProcessRunning(existing.pid)) {
    throw new Error(
      `An auto-types watcher is already running (PID ${existing.pid}). Use "sof run auto-types --stop-watch" first.`
    );
  }

  removeWatcherLock();
  writeWatcherLock(configPath);
}

function stopAutoTypesWatcher() {
  const existing = readWatcherLock();
  if (!existing || !Number.isInteger(existing.pid)) {
    removeWatcherLock();
    console.log("No running auto-types watcher was found.");
    return;
  }

  if (!isProcessRunning(existing.pid)) {
    removeWatcherLock();
    console.log(`Removed stale watcher lock for PID ${existing.pid}.`);
    return;
  }

  try {
    try {
      process.kill(existing.pid, "SIGINT");
    } catch (signalErr) {
      if (signalErr.code !== "ERR_UNKNOWN_SIGNAL") {
        throw signalErr;
      }

      process.kill(existing.pid);
    }

    removeWatcherLock();
    console.log(`Stopped auto-types watcher (PID ${existing.pid}).`);
  } catch (err) {
    if (err.code === "ESRCH") {
      removeWatcherLock();
      console.log(`Removed stale watcher lock for PID ${existing.pid}.`);
      return;
    }

    throw new Error(`Failed to stop watcher PID ${existing.pid}: ${err.message}`);
  }
}

function collectFromDirectory(directoryPath, recursive) {
  const pattern = recursive ? "**/*.luau" : "*.luau";
  return fg.sync(pattern, {
    cwd: directoryPath,
    absolute: true,
    onlyFiles: true,
  });
}

function collectFromGlob(includePattern, cwd) {
  return fg.sync(includePattern, {
    cwd,
    absolute: true,
    onlyFiles: true,
  });
}

function collectLuauFiles(group, configDirectory, outputPath) {
  const files = new Set();

  for (const includeEntry of group.include) {
    const resolved = path.resolve(configDirectory, includeEntry);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);

      if (stat.isDirectory()) {
        for (const filePath of collectFromDirectory(resolved, group.recursive)) {
          if (filePath.toLowerCase().endsWith(".luau")) {
            files.add(path.resolve(filePath));
          }
        }
        continue;
      }

      if (stat.isFile() && resolved.toLowerCase().endsWith(".luau")) {
        files.add(path.resolve(resolved));
        continue;
      }
    }

    for (const filePath of collectFromGlob(includeEntry, configDirectory)) {
      if (filePath.toLowerCase().endsWith(".luau")) {
        files.add(path.resolve(filePath));
      }
    }
  }

  files.delete(path.resolve(outputPath));

  return Array.from(files).sort((a, b) => a.localeCompare(b));
}

function normalizeForComparison(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeForGlobMatch(value) {
  const resolved = path.resolve(value);
  if (process.platform !== "win32") {
    return resolved;
  }

  return resolved.replace(/\\/g, "/").toLowerCase();
}

function normalizeWatchPattern(pattern) {
  if (process.platform !== "win32") {
    return pattern;
  }

  return pattern.replace(/\\/g, "/");
}

function isPathInside(parentPath, targetPath) {
  const relative = path.relative(parentPath, targetPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveWatchPatterns(group, configDirectory) {
  const patterns = new Set();

  for (const includeEntry of group.include) {
    const resolved = path.resolve(configDirectory, includeEntry);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);

      if (stat.isDirectory()) {
        patterns.add(normalizeWatchPattern(resolved));
        continue;
      }

      if (stat.isFile() && resolved.toLowerCase().endsWith(".luau")) {
        patterns.add(normalizeWatchPattern(path.resolve(resolved)));
        continue;
      }
    }

    const fallbackPattern = path.isAbsolute(includeEntry)
      ? includeEntry
      : path.resolve(configDirectory, includeEntry);

    patterns.add(normalizeWatchPattern(fallbackPattern));
  }

  return Array.from(patterns);
}

function doesGroupIncludeFile(group, configDirectory, filePath) {
  const absoluteFilePath = path.resolve(filePath);
  if (!absoluteFilePath.toLowerCase().endsWith(".luau")) {
    return false;
  }

  for (const includeEntry of group.include) {
    const resolved = path.resolve(configDirectory, includeEntry);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);

      if (stat.isDirectory()) {
        if (!isPathInside(resolved, absoluteFilePath)) {
          continue;
        }

        if (!group.recursive) {
          const relativePath = path.relative(resolved, absoluteFilePath);
          if (/[\\/]/.test(relativePath)) {
            continue;
          }
        }

        return true;
      }

      if (stat.isFile()) {
        if (normalizeForComparison(resolved) === normalizeForComparison(absoluteFilePath)) {
          return true;
        }
      }
    }

    const absolutePattern = path.isAbsolute(includeEntry)
      ? includeEntry
      : path.resolve(configDirectory, includeEntry);

    if (path.matchesGlob(normalizeForGlobMatch(absoluteFilePath), normalizeForGlobMatch(absolutePattern))) {
      return true;
    }
  }

  return false;
}

function ensureUniqueModuleNames(modules) {
  const nameCounts = new Map();
  const output = [];

  for (const moduleInfo of modules) {
    const baseName = toPascalCase(moduleInfo.moduleName);
    const count = nameCounts.get(baseName) || 0;
    const nextCount = count + 1;
    nameCounts.set(baseName, nextCount);

    const uniqueName = count === 0 ? baseName : `${baseName}${nextCount}`;
    if (count > 0) {
      const relPath = path.relative(process.cwd(), moduleInfo.filePath);
      console.warn(`  ! Duplicate module type name "${baseName}" from "${relPath}", using "${uniqueName}".`);
    }

    output.push({
      moduleName: uniqueName,
      typeName: uniqueName,
      moduleKind: moduleInfo.moduleKind,
      functionType: moduleInfo.functionType,
      properties: moduleInfo.properties || [],
      members: moduleInfo.members,
    });
  }

  return output;
}

function buildDatamodelPathMap(configDirectory) {
  const map = new Map();
  const sourcemapPath = path.resolve(configDirectory, "sourcemap.json");
  if (!fs.existsSync(sourcemapPath)) {
    return map;
  }

  let sourcemap = null;
  try {
    sourcemap = JSON.parse(fs.readFileSync(sourcemapPath, "utf8"));
  } catch (_err) {
    return map;
  }

  function visitNode(node, pathSegments) {
    if (!node || typeof node !== "object") {
      return;
    }

    const nodeName = typeof node.name === "string" ? node.name.trim() : "";
    const nodeClass = typeof node.className === "string" ? node.className : "";
    const nextSegments =
      nodeClass === "DataModel" || nodeName === ""
        ? pathSegments
        : [...pathSegments, nodeName];

    if (Array.isArray(node.filePaths) && nextSegments.length > 0) {
      for (const filePath of node.filePaths) {
        if (typeof filePath !== "string" || !filePath.toLowerCase().endsWith(".luau")) {
          continue;
        }

        const datamodelPath = nextSegments.join("/");
        if (!map.has(datamodelPath)) {
          map.set(datamodelPath, path.resolve(configDirectory, filePath));
        }
      }
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visitNode(child, nextSegments);
      }
    }
  }

  visitNode(sourcemap, []);
  return map;
}

function findLatestVersionDirectory(baseDirectory) {
  if (!fs.existsSync(baseDirectory)) {
    return "";
  }

  let entries = [];
  try {
    entries = fs.readdirSync(baseDirectory, { withFileTypes: true });
  } catch (_err) {
    return "";
  }

  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  if (versions.length === 0) {
    return "";
  }

  return path.join(baseDirectory, versions[0]);
}

function resolveLuauLspBinaryPath() {
  if (process.env.SOF_LUAU_LSP_BIN && fs.existsSync(process.env.SOF_LUAU_LSP_BIN)) {
    return path.resolve(process.env.SOF_LUAU_LSP_BIN);
  }

  const home = os.homedir();
  const executableName = process.platform === "win32" ? "luau-lsp.exe" : "luau-lsp";
  const candidateRoots = [
    path.join(home, ".rokit", "tool-storage", "johnnymorganz", "luau-lsp"),
    path.join(home, ".rokit", "bin"),
  ];

  for (const root of candidateRoots) {
    if (!fs.existsSync(root)) {
      continue;
    }

    const latestVersionDirectory = findLatestVersionDirectory(root);
    if (latestVersionDirectory) {
      const binaryPath = path.join(latestVersionDirectory, executableName);
      if (fs.existsSync(binaryPath)) {
        return binaryPath;
      }
    }

    const directBinaryPath = path.join(root, executableName);
    if (fs.existsSync(directBinaryPath)) {
      return directBinaryPath;
    }
  }

  return "";
}

function resolveLuauDefinitionsPath() {
  const appData = process.env.APPDATA || "";
  if (!appData) {
    return "";
  }

  const definitionsPath = path.join(
    appData,
    "Cursor",
    "User",
    "globalStorage",
    "johnnymorganz.luau-lsp",
    "globalTypes.PluginSecurity.d.luau"
  );
  if (!fs.existsSync(definitionsPath)) {
    return "";
  }

  return definitionsPath;
}

function buildParserContext(configDirectory) {
  return {
    configDirectory,
    sourcemapPath: path.resolve(configDirectory, "sourcemap.json"),
    datamodelPathMap: buildDatamodelPathMap(configDirectory),
    luauLspBinaryPath: resolveLuauLspBinaryPath(),
    luauDefinitionsPath: resolveLuauDefinitionsPath(),
  };
}

async function prepareGroupFileRecords(group, configDirectory, diskCache) {
  const outputPath = path.resolve(configDirectory, group.output);
  const luauFiles = collectLuauFiles(group, configDirectory, outputPath);

  const fileRecords = await mapWithConcurrency(
    luauFiles,
    DEFAULT_PARSE_CONCURRENCY,
    async (filePath) => {
      const source = await fs.promises.readFile(filePath, "utf8");
      const sourceHash = hashBuffer(source);
      const cacheKey = `${group.name}::${filePath}`;
      const cacheEntry = diskCache.files[cacheKey];
      const cacheValid =
        cacheEntry &&
        cacheEntry.sourceHash === sourceHash &&
        cacheEntry.excludePrivate === Boolean(group.excludePrivate);

      return {
        filePath,
        source,
        sourceHash,
        cacheKey,
        cacheValid,
        cachedResult: cacheValid ? cacheEntry.result : null,
      };
    }
  );

  return { outputPath, luauFiles, fileRecords };
}

function finalizeGroup(group, outputPath, fileRecords, diskCache, sharedContext) {
  const parsedModules = [];
  for (const record of fileRecords) {
    let parsed = record.cachedResult;

    if (!parsed) {
      parsed = parseLuauModule(record.source, record.filePath, {
        excludePrivate: group.excludePrivate,
        parserContext: sharedContext,
        prewarmLanguageServer: false,
      });
      diskCache.files[record.cacheKey] = {
        sourceHash: record.sourceHash,
        excludePrivate: Boolean(group.excludePrivate),
        result: {
          moduleName: parsed.moduleName,
          typeName: parsed.typeName,
          tableName: parsed.tableName,
          moduleKind: parsed.moduleKind,
          functionType: parsed.functionType,
          properties: parsed.properties,
          members: parsed.members,
        },
      };
    }

    const hasTableMembers = parsed.members && parsed.members.length > 0;
    const hasTableProperties = parsed.properties && parsed.properties.length > 0;
    const hasFunctionType = parsed.moduleKind === "function" && parsed.functionType;

    if (!hasTableMembers && !hasTableProperties && !hasFunctionType) {
      continue;
    }

    parsedModules.push({
      ...parsed,
      filePath: record.filePath,
    });
  }

  const uniqueModules = ensureUniqueModuleNames(parsedModules);
  const outputText = generateTypeFile({
    groupName: group.name,
    modules: uniqueModules,
  });

  const outputDirectory = path.dirname(outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(outputPath, outputText, "utf8");

  return {
    outputPath,
    fileCount: fileRecords.length,
    moduleCount: uniqueModules.length,
  };
}

async function compileGroup(group, configDirectory, parserContext, cacheData) {
  const diskCache = cacheData && typeof cacheData === "object" ? cacheData : { files: {} };
  diskCache.files = diskCache.files || {};
  const sharedContext = parserContext || {};

  const { outputPath, fileRecords } = await prepareGroupFileRecords(
    group,
    configDirectory,
    diskCache
  );

  const needReparse = fileRecords.filter((record) => !record.cacheValid);
  if (needReparse.length > 0 && sharedContext.luauLspBinaryPath) {
    try {
      await prewarmLanguageServerCacheMulti(
        needReparse.map((record) => ({ source: record.source, filePath: record.filePath })),
        sharedContext
      );
    } catch (_err) {
      // Fall back to per-file sync prewarm during parse.
    }
  }

  return finalizeGroup(group, outputPath, fileRecords, diskCache, sharedContext);
}

async function compileGroupsInParallel(groups, configDirectory, parserContext, cacheData) {
  const diskCache = cacheData && typeof cacheData === "object" ? cacheData : { files: {} };
  diskCache.files = diskCache.files || {};
  const sharedContext = parserContext || {};

  const prepared = await Promise.all(
    groups.map((group) => prepareGroupFileRecords(group, configDirectory, diskCache))
  );

  // One luau-lsp spawn for every file across every group: a single sourcemap
  // load amortized across the entire run.
  const combinedPending = [];
  for (const { fileRecords } of prepared) {
    for (const record of fileRecords) {
      if (!record.cacheValid) {
        combinedPending.push({ source: record.source, filePath: record.filePath });
      }
    }
  }

  if (combinedPending.length > 0 && sharedContext.luauLspBinaryPath) {
    try {
      await prewarmLanguageServerCacheMulti(combinedPending, sharedContext);
    } catch (_err) {
      // Per-file fallback still runs during parse.
    }
  }

  return groups.map((group, index) =>
    finalizeGroup(
      group,
      prepared[index].outputPath,
      prepared[index].fileRecords,
      diskCache,
      sharedContext
    )
  );
}

function startWatcher(config) {
  let chokidar;
  try {
    chokidar = require("chokidar");
  } catch (_err) {
    console.error("Watch mode requires chokidar. Run: npm install chokidar");
    process.exit(1);
  }

  const groupEntries = config.groups.map((group) => ({
    group,
    outputPath: path.resolve(config.configDirectory, group.output),
    watchPatterns: resolveWatchPatterns(group, config.configDirectory),
  }));
  const parserContext = buildParserContext(config.configDirectory);

  const watchPatterns = Array.from(new Set(groupEntries.flatMap((entry) => entry.watchPatterns)));
  if (watchPatterns.length === 0) {
    console.warn("No watch patterns were resolved from config includes.");
    return;
  }

  claimWatcherLock(config.configPath);

  const ignoredOutputPaths = new Set(
    groupEntries.map((entry) => normalizeForComparison(entry.outputPath))
  );

  console.log("\nWatching for changes...");
  const watcher = chokidar.watch(watchPatterns, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200 },
    ignored: (candidatePath) => ignoredOutputPaths.has(normalizeForComparison(candidatePath)),
  });

  let isClosing = false;

  function shutdownWatcher(exitCode, message) {
    if (isClosing) {
      return;
    }
    isClosing = true;

    if (message) {
      console.log(message);
    }

    try {
      watcher.close();
    } catch (_err) {
      // Ignore close failures during shutdown.
    }

    removeWatcherLock();
    process.exit(exitCode);
  }

  async function recompileForEvent(eventName, filePath) {
    const absoluteFilePath = path.resolve(filePath);
    if (!absoluteFilePath.toLowerCase().endsWith(".luau")) {
      return;
    }

    const affectedEntries = groupEntries.filter((entry) =>
      doesGroupIncludeFile(entry.group, config.configDirectory, absoluteFilePath)
    );

    if (affectedEntries.length === 0) {
      return;
    }

    const relativeFilePath = path.relative(process.cwd(), absoluteFilePath);
    console.log(`\nDetected ${eventName}: ${relativeFilePath}`);

    const watcherCache = readDiskCache(config.configDirectory);
    for (const entry of affectedEntries) {
      try {
        const result = await compileGroup(
          entry.group,
          config.configDirectory,
          parserContext,
          watcherCache
        );
        const relativeOutputPath = path.relative(process.cwd(), result.outputPath);
        console.log(
          `  ✓ ${entry.group.name}: ${relativeOutputPath} (${result.moduleCount} module types from ${result.fileCount} file(s)) [updated]`
        );
      } catch (err) {
        console.error(`  ✗ ${entry.group.name}: ${err.message}`);
      }
    }

    try {
      writeDiskCache(config.configDirectory, watcherCache);
    } catch (err) {
      console.warn(`  ! Failed to persist auto-types cache: ${err.message}`);
    }
  }

  watcher.on("change", (filePath) => {
    recompileForEvent("change", filePath).catch((err) =>
      console.error(`Watcher change handler error: ${err.message}`)
    );
  });
  watcher.on("add", (filePath) => {
    recompileForEvent("add", filePath).catch((err) =>
      console.error(`Watcher add handler error: ${err.message}`)
    );
  });
  watcher.on("unlink", (filePath) => {
    recompileForEvent("unlink", filePath).catch((err) =>
      console.error(`Watcher unlink handler error: ${err.message}`)
    );
  });
  watcher.on("error", (err) => {
    console.error(`Watcher error: ${err.message}`);
  });

  process.on("SIGINT", () => shutdownWatcher(0, "\nStopping watcher..."));
  process.on("SIGTERM", () => shutdownWatcher(0, "\nStopping watcher..."));
  process.on("exit", () => {
    removeWatcherLock();
  });
}

async function runAutoTypes(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (args.watch && args.stopWatch) {
    throw new Error("Cannot use --watch and --stop-watch together.");
  }

  if (args.stopWatch) {
    stopAutoTypesWatcher();
    return;
  }

  const config = readAutoTypesConfig(args.configPath);
  const parserContext = buildParserContext(config.configDirectory);
  const cacheData = readDiskCache(config.configDirectory);
  console.log(`Using config: ${path.relative(process.cwd(), config.configPath)}`);
  console.log(`Compiling ${config.groups.length} auto-types group(s)...`);

  const groupResults = await compileGroupsInParallel(
    config.groups,
    config.configDirectory,
    parserContext,
    cacheData
  );

  let totalModules = 0;
  for (let index = 0; index < config.groups.length; index += 1) {
    const group = config.groups[index];
    const result = groupResults[index];
    totalModules += result.moduleCount;
    const relativeOutputPath = path.relative(process.cwd(), result.outputPath);
    console.log(
      `  ✓ ${group.name}: ${relativeOutputPath} (${result.moduleCount} module types from ${result.fileCount} file(s))`
    );
  }

  try {
    writeDiskCache(config.configDirectory, cacheData);
  } catch (err) {
    console.warn(`  ! Failed to persist auto-types cache: ${err.message}`);
  }

  console.log(`\nDone: ${config.groups.length} group(s), ${totalModules} total module type(s).`);

  if (args.watch) {
    startWatcher(config);
  }
}

module.exports = {
  runAutoTypes,
};
