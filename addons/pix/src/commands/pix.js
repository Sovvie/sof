"use strict";

const path = require("path");
const { resolveOutputDefault } = require("../output-config");
const { pixelateImage } = require("../pix/engine");

const HELP_TEXT = `
sof run pix - Convert images to pixel-art

USAGE:
  sof run pix <input> <width> <height> [palette] [options]

EXAMPLES:
  sof run pix ./assets/image.png 64 64
  sof run pix ./assets/image.png 64 64 12 --scale 6 --output ./assets/image_pix.png

OPTIONS:
  --iter <n>                      Max iteration count
  -o, --out, --output <path>      Output file path
  --scale <n>                     Integer output upscale multiplier
  --bg <hex>                      Background color used for alpha compositing
  --no-alpha                      Strip alpha channel
  --no-converge                   Force all iterations
  --tolerance <f>                 Split tolerance
  -h, --help                      Show this help message

NOTES:
  If no output option is passed, [output].pix from sof.toml is used when set.
`;

function isOption(value) {
  return typeof value === "string" && value.startsWith("-");
}

function parseInteger(name, value) {
  const parsed = parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer. Received: ${value}`);
  }
  return parsed;
}

function parseFloatValue(name, value) {
  const parsed = parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number. Received: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const parsed = {
    input: null,
    width: 0,
    height: 0,
    palette: 8,
    iterations: 75,
    outputPath: null,
    scale: 1,
    background: "ffffff",
    keepAlpha: true,
    forceIterations: false,
    tolerance: 1.0,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help" || arg === "help") {
      parsed.help = true;
      continue;
    }

    if (arg === "-o" || arg === "--out" || arg === "--output") {
      const value = argv[index + 1];
      if (!value || isOption(value)) {
        throw new Error(`${arg} requires an output path.`);
      }
      parsed.outputPath = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--out=")) {
      parsed.outputPath = arg.slice("--out=".length);
      continue;
    }

    if (arg.startsWith("--output=")) {
      parsed.outputPath = arg.slice("--output=".length);
      continue;
    }

    if (arg === "--iter") {
      const value = argv[index + 1];
      if (!value || isOption(value)) {
        throw new Error("--iter requires a numeric value.");
      }
      parsed.iterations = parseInteger("--iter", value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--iter=")) {
      parsed.iterations = parseInteger("--iter", arg.slice("--iter=".length));
      continue;
    }

    if (arg === "--scale") {
      const value = argv[index + 1];
      if (!value || isOption(value)) {
        throw new Error("--scale requires a numeric value.");
      }
      parsed.scale = parseInteger("--scale", value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--scale=")) {
      parsed.scale = parseInteger("--scale", arg.slice("--scale=".length));
      continue;
    }

    if (arg === "--bg") {
      const value = argv[index + 1];
      if (!value || isOption(value)) {
        throw new Error("--bg requires a hex value.");
      }
      parsed.background = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--bg=")) {
      parsed.background = arg.slice("--bg=".length);
      continue;
    }

    if (arg === "--tolerance") {
      const value = argv[index + 1];
      if (!value || isOption(value)) {
        throw new Error("--tolerance requires a numeric value.");
      }
      parsed.tolerance = parseFloatValue("--tolerance", value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--tolerance=")) {
      parsed.tolerance = parseFloatValue("--tolerance", arg.slice("--tolerance=".length));
      continue;
    }

    if (arg === "--no-alpha") {
      parsed.keepAlpha = false;
      continue;
    }

    if (arg === "--no-converge") {
      parsed.forceIterations = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (parsed.help) {
    return parsed;
  }

  if (positional.length < 3 || positional.length > 4) {
    throw new Error("pix requires: <input> <width> <height> [palette]");
  }

  parsed.input = positional[0];
  parsed.width = parseInteger("width", positional[1]);
  parsed.height = parseInteger("height", positional[2]);
  if (positional[3] !== undefined) {
    parsed.palette = parseInteger("palette", positional[3]);
  }

  if (parsed.width <= 0) {
    throw new Error("width must be greater than 0.");
  }
  if (parsed.height <= 0) {
    throw new Error("height must be greater than 0.");
  }
  if (parsed.palette <= 0) {
    throw new Error("palette must be greater than 0.");
  }
  if (parsed.iterations <= 0) {
    throw new Error("--iter must be greater than 0.");
  }
  if (parsed.scale <= 0) {
    throw new Error("--scale must be greater than 0.");
  }
  if (parsed.tolerance <= 0) {
    throw new Error("--tolerance must be greater than 0.");
  }

  return parsed;
}

function resolveDefaultOutputPath(inputPathArg, outputDefault) {
  const inputPath = path.resolve(inputPathArg);
  const extension = path.extname(inputPath);
  const baseName = path.basename(inputPath, extension);

  const defaultLooksLikeDirectory =
    outputDefault.endsWith("/") ||
    outputDefault.endsWith("\\") ||
    path.extname(outputDefault) === "";

  if (defaultLooksLikeDirectory) {
    return path.join(outputDefault, `${baseName}_pix${extension || ".png"}`);
  }

  return outputDefault;
}

function computeOutputPath(args) {
  const resolvedInput = path.resolve(args.input);
  if (args.outputPath) {
    return path.resolve(args.outputPath);
  }

  const configuredDefault = resolveOutputDefault(null, "pix");
  if (configuredDefault) {
    return path.resolve(resolveDefaultOutputPath(args.input, configuredDefault));
  }

  const extension = path.extname(resolvedInput);
  return path.join(
    path.dirname(resolvedInput),
    `${path.basename(resolvedInput, extension)}_pix${extension || ".png"}`
  );
}

async function runPix(argv) {
  const args = parseArgs(argv || []);
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const inputPath = path.resolve(args.input);
  const outputPath = computeOutputPath(args);

  console.log(
    `Pixelating ${inputPath} -> ${outputPath} (${args.width}x${args.height}, palette=${args.palette})`
  );

  const result = await pixelateImage({
    inputPath,
    outputPath,
    outputWidth: args.width,
    outputHeight: args.height,
    paletteSize: args.palette,
    maxIterations: args.iterations,
    scale: args.scale,
    backgroundHex: args.background,
    keepAlpha: args.keepAlpha,
    forceIterations: args.forceIterations,
    tolerance: args.tolerance,
  });

  console.log(
    `Done: ${result.outputWidth}x${result.outputHeight}, colors=${result.effectiveColors}, iterations=${result.iterations}${result.converged ? " (converged)" : ""}`
  );
  console.log(`Saved: ${result.outputPath}`);
}

module.exports = {
  runPix,
};
