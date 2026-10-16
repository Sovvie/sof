"use strict";

const FORMATS = ["png", "jpeg", "webp", "avif"];
const FITS = ["inside", "cover", "contain", "fill"];

const HELP_TEXT = `
sof run img - Batch image optimize, resize and convert

USAGE:
  sof run img <input...> [options]

Inputs are files, folders or globs. Folders are walked for
png, jpg, jpeg, webp, avif, gif and tiff files.

EXAMPLES:
  sof run img assets/ --out dist/assets --format webp
  sof run img "art/**/*.png" --width 512 --in-place
  sof run img photo.jpg --quality 70 --dry-run

OPTIONS:
  --out <dir>             Write results into this folder (mirrors the layout).
                          Default: next to each input with a ".min" suffix.
  --in-place              Overwrite the sources (kept only if smaller; with a
                          changed extension the source is left alone)
  --delete-source         With --in-place and --format: remove the source after
                          a successful conversion
  --format <fmt>          png | jpeg | webp | avif
  --quality <1-100>       Encoder quality (default 80)
  --width <px>            Resize width
  --height <px>           Resize height (aspect ratio kept if only one is set)
  --fit <mode>            inside | cover | contain | fill (default inside)
  --enlarge               Allow upscaling (default: never upscale; --no-enlarge)
  --strip                 Drop metadata (default)
  --keep-metadata         Keep metadata
  --lossless              Lossless webp/png/avif
  --recursive             Walk folders deeply (default for folders)
  --no-recursive          Only look at the top level of folders
  --dry-run               Show what would happen without writing
  --json                  Machine-readable report
  -h, --help              Show this help message

CONFIG:
  An optional [img] table in the nearest sof.toml sets defaults for
  format, quality, width, height and out. Command line flags win.
`;

function fail(message) {
  throw new Error(message);
}

function parseIntOption(name, value, min, max) {
  if (value === undefined || value === null || !/^\d+$/.test(String(value).trim())) {
    fail(`${name} must be a whole number. Received: ${value === undefined ? "nothing" : value}`);
  }
  const n = parseInt(value, 10);
  if (n < min || (max !== undefined && n > max)) {
    fail(`${name} must be ${max === undefined ? `at least ${min}` : `between ${min} and ${max}`}.`);
  }
  return n;
}

function normalizeFormat(value, name = "--format") {
  const v = String(value).toLowerCase();
  const f = v === "jpg" ? "jpeg" : v;
  if (!FORMATS.includes(f)) fail(`${name} must be one of: png, jpeg, webp, avif. Received: ${value}`);
  return f;
}

/**
 * Parse argv. Values that were not given stay undefined so config defaults can fill them.
 */
function parseArgs(argv) {
  const o = {
    inputs: [],
    help: false,
    out: undefined,
    inPlace: false,
    deleteSource: false,
    format: undefined,
    quality: undefined,
    width: undefined,
    height: undefined,
    fit: undefined,
    enlarge: false,
    keepMetadata: false,
    lossless: false,
    recursive: true,
    dryRun: false,
    json: false,
  };

  const valued = new Set(["--out", "--format", "--quality", "--width", "--height", "--fit"]);

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    if (arg === "-h" || arg === "--help" || arg === "help") {
      o.help = true;
      continue;
    }
    if (arg === "--") {
      o.inputs.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      let name = arg;
      let inline;
      const eq = arg.indexOf("=");
      if (eq > 0) {
        name = arg.slice(0, eq);
        inline = arg.slice(eq + 1);
      }
      if (valued.has(name)) {
        let value = inline;
        if (value === undefined) {
          value = argv[i + 1];
          if (value === undefined || (value.startsWith("-") && !/^-?\d/.test(value))) {
            fail(`${name} requires a value.`);
          }
          i += 1;
        }
        switch (name) {
          case "--out":
            o.out = value;
            break;
          case "--format":
            o.format = normalizeFormat(value);
            break;
          case "--quality":
            o.quality = parseIntOption("--quality", value, 1, 100);
            break;
          case "--width":
            o.width = parseIntOption("--width", value, 1);
            break;
          case "--height":
            o.height = parseIntOption("--height", value, 1);
            break;
          case "--fit":
            if (!FITS.includes(value)) fail(`--fit must be one of: ${FITS.join(", ")}. Received: ${value}`);
            o.fit = value;
            break;
          default:
            break;
        }
        continue;
      }
      if (inline !== undefined) fail(`${name} does not take a value.`);
      switch (name) {
        case "--in-place":
          o.inPlace = true;
          break;
        case "--delete-source":
          o.deleteSource = true;
          break;
        case "--enlarge":
          o.enlarge = true;
          break;
        case "--no-enlarge":
          o.enlarge = false;
          break;
        case "--strip":
          o.keepMetadata = false;
          break;
        case "--keep-metadata":
          o.keepMetadata = true;
          break;
        case "--lossless":
          o.lossless = true;
          break;
        case "--recursive":
          o.recursive = true;
          break;
        case "--no-recursive":
          o.recursive = false;
          break;
        case "--dry-run":
          o.dryRun = true;
          break;
        case "--json":
          o.json = true;
          break;
        default:
          fail(`Unknown option: ${arg}`);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) fail(`Unknown option: ${arg}`);
    o.inputs.push(arg);
  }

  if (o.help) return o;
  if (o.inputs.length === 0) fail("img requires at least one input (file, folder or glob). Try: sof run img --help");
  if (o.out !== undefined && o.inPlace) fail("--out and --in-place cannot be used together.");
  if (o.deleteSource && !o.inPlace) fail("--delete-source requires --in-place.");
  return o;
}

/** Fill unset options from an [img] config table (already validated by readImgConfig). */
function applyDefaults(options, config) {
  const merged = { ...options };
  for (const key of ["format", "quality", "width", "height"]) {
    if (merged[key] === undefined && config[key] !== undefined) merged[key] = config[key];
  }
  if (merged.out === undefined && config.out !== undefined && !merged.inPlace) merged.out = config.out;
  if (merged.quality === undefined) merged.quality = 80;
  if (merged.fit === undefined) merged.fit = "inside";
  return merged;
}

module.exports = { FORMATS, FITS, HELP_TEXT, parseArgs, applyDefaults, normalizeFormat, parseIntOption };
