"use strict";

const fs = require("fs");
const path = require("path");
const { loadUploaderEnv } = require("../uploader/env");
const { resolveOutputDefault } = require("../output-config");

const HELP_TEXT = `
sof run video - Build sprite sheets from video files and upload to Roblox

USAGE:
  sof run video <file...> [options]

ARGUMENTS:
  <file...>                  One or more video files (mp4, webm, gif, etc.)

OPTIONS:
  --output <dir>             Output directory for sheets and manifest (default: ./output)
  --scale <0-1>              Downscale factor for frames (default: 0.5)
  --auto                     Auto-detect the smallest acceptable scale
  --min-psnr <dB>            Quality floor for --auto in dB (default: 32)
  --no-upload                Skip uploading sheets to Roblox
  --creator-id <id>          Creator user/group ID for upload
  --group                    Treat creator ID as a group ID
  --api-key <key>            Override ROBLOX_API_KEY for upload
  -h, --help                 Show this help message

DESCRIPTION:
  Extracts every frame from each video file, downsamples them with a B-spline
  resampler, packs them into 1024x1024 atlas PNGs, uploads the PNGs to Roblox,
  and writes a manifest.luau with the resulting asset IDs filled in.

  Run "sof run uploader env" first to configure your Roblox credentials.

EXAMPLES:
  sof run video intro.mp4
  sof run video clip.mp4 --scale 0.4 --output ./sprites
  sof run video a.mp4 b.webm --auto --min-psnr 30
  sof run video intro.mp4 --no-upload
`;

function parseVideoArgs(argv) {
  const output = {
    help: false,
    outputDir: null,
    scale: 0.5,
    autoScale: false,
    minPsnr: 32,
    upload: true,
    creatorId: null,
    isGroup: false,
    apiKey: null,
    inputs: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help" || arg === "##help") {
      output.help = true;
      continue;
    }

    if (arg === "--output") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--output requires a directory path.");
      }
      output.outputDir = value;
      i += 1;
      continue;
    }

    if (arg === "--scale") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--scale requires a numeric value between 0 and 1.");
      }
      const scale = parseFloat(value);
      if (isNaN(scale) || scale <= 0 || scale > 1) {
        throw new Error(`Invalid scale: ${value} (must be between 0 and 1).`);
      }
      output.scale = scale;
      i += 1;
      continue;
    }

    if (arg === "--auto") {
      output.autoScale = true;
      continue;
    }

    if (arg === "--min-psnr") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--min-psnr requires a numeric value.");
      }
      const psnr = parseFloat(value);
      if (isNaN(psnr) || psnr <= 0) {
        throw new Error(`Invalid PSNR value: ${value}`);
      }
      output.minPsnr = psnr;
      i += 1;
      continue;
    }

    if (arg === "--no-upload") {
      output.upload = false;
      continue;
    }

    if (arg === "--creator-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--creator-id requires a numeric value.");
      }
      if (!/^\d+$/.test(value.trim())) {
        throw new Error(`Invalid creator ID: ${value}`);
      }
      output.creatorId = value.trim();
      i += 1;
      continue;
    }

    if (arg === "--group") {
      output.isGroup = true;
      continue;
    }

    if (arg === "--api-key") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--api-key requires a value.");
      }
      output.apiKey = value.trim();
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    output.inputs.push(arg);
  }

  return output;
}

function validateInputFiles(inputs) {
  const resolved = [];
  for (const input of inputs) {
    const full = path.resolve(input);
    if (!fs.existsSync(full)) {
      throw new Error(`File not found: ${input}`);
    }
    if (!fs.statSync(full).isFile()) {
      throw new Error(`Expected a file path: ${input}`);
    }
    resolved.push(full);
  }
  return resolved;
}

function extractSheetIndex(filePath) {
  const match = path.basename(filePath).match(/spritesheet_(\d+)\.png$/);
  return match ? parseInt(match[1], 10) : null;
}

async function uploadSheets(sheetPaths, options) {
  loadUploaderEnv();

  const {
    uploadImageFiles,
    resolveCreatorId,
  } = require("../uploader/asset-upload");

  let creatorId;
  try {
    creatorId = await resolveCreatorId({
      creatorID: options.creatorId,
      isGroup: options.isGroup,
    });
  } catch (err) {
    throw new Error(
      `${err.message}\n` +
        `Run "sof run uploader env" to save your credentials, or pass --creator-id.`
    );
  }

  if (!options.creatorId) {
    console.log(`[video] Auto-resolved creator ID: ${creatorId}`);
  }

  let lastMsg = "";
  const onProgress = (done, total, message) => {
    const out = `[upload] ${done}/${total} ${message}`;
    if (out !== lastMsg) { lastMsg = out; console.log(out); }
  };

  const report = await uploadImageFiles({
    filePaths: sheetPaths,
    creatorID: creatorId,
    isGroup: options.isGroup,
    apiKey: options.apiKey || undefined,
    onProgress,
  });

  return report;
}

function printUploadReport(report) {
  const results = report.results || [];
  const moderated = report.moderated || [];
  const failures = report.failures || [];

  console.log("");
  console.log(
    `Upload: ${results.length} succeeded, ` +
      `${moderated.length} moderated, ${failures.length} failed.`
  );

  for (const entry of results) {
    console.log(`  \u2713 ${path.basename(String(entry.oldId))} -> ${entry.newId}`);
  }
  for (const entry of moderated) {
    console.warn(`  ! ${path.basename(String(entry.oldId))} -> ${entry.newId} (${entry.state})`);
  }
  for (const entry of failures) {
    console.error(`  x ${path.basename(String(entry.assetId))} [${entry.stage}] ${entry.error}`);
  }
}

function buildAssetIdMap(report) {
  const map = {};

  for (const entry of (report.results || [])) {
    const idx = extractSheetIndex(String(entry.oldId));
    if (idx !== null) map[idx] = entry.newId;
  }

  for (const entry of (report.moderated || [])) {
    const idx = extractSheetIndex(String(entry.oldId));
    if (idx !== null) map[idx] = entry.newId;
  }

  return map;
}

async function runVideo(argv) {
  if (!argv[0] || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "##help") {
    console.log(HELP_TEXT);
    process.exit(argv[0] ? 0 : 1);
  }

  let args;
  try {
    args = parseVideoArgs(argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.log(HELP_TEXT);
    process.exit(1);
  }

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (args.inputs.length === 0) {
    console.error("Error: at least one video file is required.");
    console.log(HELP_TEXT);
    process.exit(1);
  }

  let filePaths;
  try {
    filePaths = validateInputFiles(args.inputs);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.log("\n\u2550\u2550\u2550 Sprite Sheet Packer (B-Spline) \u2550\u2550\u2550\n");

  const { extractFrames } = require("../video/extractFrames");

  let allFrames = [];
  for (const filePath of filePaths) {
    console.log(`Extracting: ${filePath}`);
    try {
      const frames = extractFrames(filePath);
      console.log(`  \u2192 ${frames.length} frame(s)  (${frames[0].width}\u00D7${frames[0].height})`);
      allFrames = allFrames.concat(frames);
    } catch (err) {
      console.error(`  \u2716  Failed: ${err.message}`);
    }
  }

  if (allFrames.length === 0) {
    console.error("\nNo frames extracted. Aborting.");
    process.exit(1);
  }

  const outDir = path.resolve(
    args.outputDir ?? resolveOutputDefault(null, "video") ?? "./output"
  );
  console.log(`\nTotal frames: ${allFrames.length}`);
  console.log(`Output:       ${outDir}\n`);

  const { buildSpriteSheets, writeManifest } = require("../video/spriteSheetBuilder");

  const result = buildSpriteSheets(allFrames, outDir, {
    scale:     args.scale,
    autoScale: args.autoScale,
    minPsnr:   args.minPsnr,
  });

  let sheetAssetIds = null;

  if (args.upload) {
    console.log("\nUploading sprite sheets to Roblox\u2026\n");
    try {
      const report = await uploadSheets(result.sheetPaths, {
        creatorId: args.creatorId,
        isGroup: args.isGroup,
        apiKey: args.apiKey,
      });

      printUploadReport(report);
      sheetAssetIds = buildAssetIdMap(report);

      const populated = Object.keys(sheetAssetIds).length;
      if (populated < result.sheetCount) {
        console.warn(
          `\nWarning: Only ${populated}/${result.sheetCount} sheet(s) received asset IDs. ` +
            `Failed sheets will have 0 in the manifest.`
        );
      }

      if (report.failures && report.failures.length > 0) {
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(`\nUpload failed: ${err.message}`);
      console.error("Writing manifest without asset IDs.");
      process.exitCode = 1;
    }
  } else {
    console.log("\nSkipping upload (--no-upload). Manifest will use placeholder values.");
  }

  writeManifest(outDir, result.placements, result.sheetCount, result.scale, sheetAssetIds, result.sheetSizes);

  console.log("");
}

module.exports = { runVideo };
