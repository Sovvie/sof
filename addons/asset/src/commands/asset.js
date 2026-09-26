"use strict";

const fs = require("fs");
const path = require("path");
const fg = require("fast-glob");

const HELP_TEXT = `
sof run asset - Asset ID inventory utilities

USAGE:
  sof run asset <audit|list|replace> [arguments] [options]

COMMANDS:
  audit
    sof run asset audit [options]
    Scan and report referenced rbxassetid:// IDs
    OPTIONS:
      --path <dir>                Root path to scan (default: ./src)
      --validate                  Validate IDs against asset delivery endpoint
      --json                      Output JSON
      -h, --help                  Show audit command help

  list
    sof run asset list [options]
    List unique asset IDs and usage counts
    OPTIONS:
      --path <dir>                Root path to scan (default: ./src)
      --json                      Output JSON
      -h, --help                  Show list command help

  replace
    sof run asset replace <old> <new> [options]
    Replace one asset ID with another
    OPTIONS:
      --path <dir>                Root path to scan (default: ./src)
      --dry-run                   Preview replacements without writing files
      --json                      Output JSON
      -h, --help                  Show replace command help
`;

const SUPPORTED_FILE_GLOBS = [
  "**/*.luau",
  "**/*.lua",
  "**/*.json",
  "**/*.toml",
];

const ASSET_PATTERN = /rbxassetid:\/\/(\d+)/g;

function displayPath(value) {
  const relative = path.relative(process.cwd(), value);
  return relative || ".";
}

function parseArgs(argv) {
  const output = {
    command: null,
    commandArgs: [],
    rootPath: "src",
    validate: false,
    dryRun: false,
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
    if (arg === "--validate") {
      output.validate = true;
      continue;
    }
    if (arg === "--dry-run") {
      output.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      output.json = true;
      continue;
    }
    if (arg === "--path") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--path requires a value.");
      }
      output.rootPath = value.trim();
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

function collectFiles(rootPathArg) {
  const rootPath = path.resolve(rootPathArg);
  if (!fs.existsSync(rootPath)) {
    throw new Error(`Scan path does not exist: ${rootPath}`);
  }
  const stat = fs.statSync(rootPath);
  if (!stat.isDirectory()) {
    throw new Error(`Scan path must be a directory: ${rootPath}`);
  }

  return fg.sync(SUPPORTED_FILE_GLOBS, {
    cwd: rootPath,
    absolute: true,
    onlyFiles: true,
  });
}

function getLineAtIndex(content, index) {
  let line = 1;
  let lastLineStart = 0;
  for (let cursor = 0; cursor < content.length && cursor < index; cursor += 1) {
    if (content[cursor] === "\n") {
      line += 1;
      lastLineStart = cursor + 1;
    }
  }
  const lineEnd = content.indexOf("\n", lastLineStart);
  const snippet = content.slice(lastLineStart, lineEnd < 0 ? undefined : lineEnd).trim();
  return { line, snippet };
}

function scanAssetReferences(rootPathArg) {
  const files = collectFiles(rootPathArg);
  const occurrences = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    ASSET_PATTERN.lastIndex = 0;
    let match = ASSET_PATTERN.exec(content);
    while (match) {
      const id = match[1];
      const lineInfo = getLineAtIndex(content, match.index);
      occurrences.push({
        id,
        filePath: path.resolve(filePath),
        line: lineInfo.line,
        snippet: lineInfo.snippet,
      });
      match = ASSET_PATTERN.exec(content);
    }
  }

  return occurrences;
}

function toUniqueAssetList(occurrences) {
  const byId = new Map();
  for (const occurrence of occurrences) {
    const existing = byId.get(occurrence.id);
    if (existing) {
      existing.count += 1;
      continue;
    }

    byId.set(occurrence.id, {
      id: occurrence.id,
      count: 1,
      firstSeenIn: displayPath(occurrence.filePath),
    });
  }

  return Array.from(byId.values()).sort((a, b) => Number(a.id) - Number(b.id));
}

async function validateAssetId(id) {
  const url = `https://assetdelivery.roblox.com/v1/asset/?id=${encodeURIComponent(id)}`;
  try {
    const response = await fetch(url, { method: "GET" });
    return {
      id,
      ok: response.ok,
      status: response.status,
    };
  } catch (err) {
    return {
      id,
      ok: false,
      status: 0,
      error: err.message,
    };
  }
}

function runList(args) {
  const occurrences = scanAssetReferences(args.rootPath);
  const assets = toUniqueAssetList(occurrences);

  if (args.json) {
    console.log(JSON.stringify({
      rootPath: displayPath(path.resolve(args.rootPath)),
      totalOccurrences: occurrences.length,
      uniqueAssets: assets,
    }, null, 2));
    return;
  }

  console.log(`Scanned ${displayPath(path.resolve(args.rootPath))}`);
  console.log(`Found ${occurrences.length} asset reference(s), ${assets.length} unique.`);
  for (const asset of assets) {
    console.log(`  ${asset.id} (${asset.count}) - ${asset.firstSeenIn}`);
  }
}

async function runAudit(args) {
  const occurrences = scanAssetReferences(args.rootPath);
  const assets = toUniqueAssetList(occurrences);
  let validations = [];

  if (args.validate) {
    for (const asset of assets) {
      // Keep this sequential to avoid hammering Roblox endpoints.
      // The list can be large and this keeps behavior predictable.
      // eslint-disable-next-line no-await-in-loop
      validations.push(await validateAssetId(asset.id));
    }
  }

  const byId = new Map(validations.map((item) => [item.id, item]));
  const report = {
    rootPath: displayPath(path.resolve(args.rootPath)),
    totalOccurrences: occurrences.length,
    uniqueAssets: assets.length,
    assets: assets.map((asset) => ({
      ...asset,
      validation: byId.get(asset.id) || null,
    })),
    occurrences: occurrences.map((occurrence) => ({
      id: occurrence.id,
      file: displayPath(occurrence.filePath),
      line: occurrence.line,
      snippet: occurrence.snippet,
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Scanned ${report.rootPath}`);
  console.log(`Found ${report.totalOccurrences} asset reference(s), ${report.uniqueAssets} unique.`);
  for (const asset of report.assets) {
    if (asset.validation) {
      const status = asset.validation.ok ? "ok" : `status ${asset.validation.status}`;
      console.log(`  ${asset.id} (${asset.count}) - ${status}`);
    } else {
      console.log(`  ${asset.id} (${asset.count})`);
    }
  }
}

function runReplace(args) {
  const oldId = args.commandArgs[0];
  const newId = args.commandArgs[1];
  if (!oldId || !newId) {
    throw new Error('asset replace requires two arguments: <old-id> <new-id>.');
  }

  if (!/^\d+$/.test(oldId) || !/^\d+$/.test(newId)) {
    throw new Error("asset replace IDs must be numeric (without rbxassetid:// prefix).");
  }

  const files = collectFiles(args.rootPath);
  const oldToken = `rbxassetid://${oldId}`;
  const newToken = `rbxassetid://${newId}`;

  const changedFiles = [];
  let totalReplacements = 0;

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.includes(oldToken)) {
      continue;
    }
    const replaced = content.split(oldToken).join(newToken);
    if (replaced === content) {
      continue;
    }
    const replacementsInFile = content.split(oldToken).length - 1;
    totalReplacements += replacementsInFile;
    changedFiles.push({
      filePath: path.resolve(filePath),
      replacements: replacementsInFile,
    });
    if (!args.dryRun) {
      fs.writeFileSync(filePath, replaced, "utf8");
    }
  }

  if (args.json) {
    console.log(JSON.stringify({
      oldId,
      newId,
      dryRun: args.dryRun,
      totalReplacements,
      changedFiles: changedFiles.map((item) => ({
        file: displayPath(item.filePath),
        replacements: item.replacements,
      })),
    }, null, 2));
    return;
  }

  if (changedFiles.length === 0) {
    console.log(`No references to ${oldToken} were found under ${displayPath(path.resolve(args.rootPath))}.`);
    return;
  }

  console.log(
    `${args.dryRun ? "Would replace" : "Replaced"} ${totalReplacements} occurrence(s) across ${changedFiles.length} file(s).`
  );
  for (const item of changedFiles) {
    console.log(`  ${displayPath(item.filePath)} (${item.replacements})`);
  }
}

async function runAsset(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.command) {
    console.log(HELP_TEXT);
    process.exit(args.help ? 0 : 1);
  }

  if (args.command === "list") {
    runList(args);
    return;
  }

  if (args.command === "audit") {
    await runAudit(args);
    return;
  }

  if (args.command === "replace") {
    runReplace(args);
    return;
  }

  throw new Error(`Unknown asset command: ${args.command}`);
}

module.exports = {
  runAsset,
};
