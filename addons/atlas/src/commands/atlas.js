"use strict";

const fs = require("fs");
const path = require("path");
const { resolveOutputDefault } = require("../output-config");

const HELP_TEXT = `
sof run atlas - Generate embedded Luau font modules

USAGE:
  sof run atlas generate <path/to/font.ttf> [output/dir] [options]

COMMANDS:
  generate
    sof run atlas generate <path/to/font.ttf> [output/dir] [options]
    Generate GlyphMetrics.luau with embedded glyph pixel buffers
    OPTIONS:
      --size <number>              Font size in pixels (default: 32)
      --line-height <number>       Line height in pixels (default: size * 1.2)
      --padding <number>           Pixel padding around each glyph (default: 2)
      --max-size <number>          Atlas page size in pixels (default: 1024)
      --charset <list>             Comma-separated charset presets (default: latin,latin-ext)
      --chars <text>               Extra literal characters to include
      --name <font-name>           Optional font name override
      -h, --help                   Show this help message

CHARSET PRESETS:
  latin
  latin-ext
  cjk-common
  arabic
  hebrew
  thai
  emoji-basic
`;

const CHARSET_RANGES = {
  latin: [
    [0x0020, 0x007e],
  ],
  "latin-ext": [
    [0x00a0, 0x024f],
  ],
  "cjk-common": [
    [0x3000, 0x303f], // CJK symbols and punctuation
    [0x3040, 0x309f], // Hiragana
    [0x30a0, 0x30ff], // Katakana
    [0x4e00, 0x9fff], // CJK unified ideographs
  ],
  arabic: [
    [0x0600, 0x06ff],
    [0x0750, 0x077f],
    [0x08a0, 0x08ff],
  ],
  hebrew: [
    [0x0590, 0x05ff],
  ],
  thai: [
    [0x0e00, 0x0e7f],
  ],
  "emoji-basic": [
    [0x1f300, 0x1f5ff],
    [0x1f600, 0x1f64f],
    [0x1f680, 0x1f6ff],
    [0x1f900, 0x1f9ff],
  ],
};

function formatNumber(value) {
  const rounded = Math.round(value * 1000) / 1000;
  if (Object.is(rounded, -0)) {
    return "0";
  }
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/\.?0+$/, "");
}

function ensureNumber(value, optionName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${optionName} must be a finite number. Received "${value}".`);
  }
  return parsed;
}

function parseGenerateArgs(argv) {
  const args = {
    fontPath: null,
    outputPath: null,
    size: 32,
    lineHeight: null,
    padding: 2,
    maxSize: 1024,
    charset: ["latin", "latin-ext"],
    chars: "",
    fontName: null,
    help: false,
  };

  const positional = [];
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      index += 1;
      continue;
    }

    if (arg === "--size" || arg === "--line-height" || arg === "--padding" || arg === "--max-size" || arg === "--charset" || arg === "--chars" || arg === "--name") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value.`);
      }

      if (arg === "--size") {
        args.size = ensureNumber(value, "--size");
      } else if (arg === "--line-height") {
        args.lineHeight = ensureNumber(value, "--line-height");
      } else if (arg === "--padding") {
        args.padding = ensureNumber(value, "--padding");
      } else if (arg === "--max-size") {
        args.maxSize = ensureNumber(value, "--max-size");
      } else if (arg === "--charset") {
        args.charset = value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      } else if (arg === "--chars") {
        args.chars = value;
      } else if (arg === "--name") {
        args.fontName = value.trim() || null;
      }

      index += 2;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
    index += 1;
  }

  if (positional.length > 2) {
    throw new Error("atlas generate accepts at most two positional arguments: <font> [output].");
  }

  args.fontPath = positional[0] || null;
  args.outputPath = positional[1] || null;

  if (args.lineHeight == null) {
    args.lineHeight = args.size * 1.2;
  }

  if (args.size <= 0) {
    throw new Error("--size must be greater than 0.");
  }

  if (args.padding < 0) {
    throw new Error("--padding cannot be negative.");
  }

  if (args.maxSize < 64) {
    throw new Error("--max-size must be at least 64.");
  }

  return args;
}

function resolveCodepoints(args) {
  const set = new Set();

  for (const charsetName of args.charset) {
    const ranges = CHARSET_RANGES[charsetName];
    if (!ranges) {
      const presets = Object.keys(CHARSET_RANGES).join(", ");
      throw new Error(`Unknown charset preset "${charsetName}". Available: ${presets}`);
    }

    for (const [start, stop] of ranges) {
      for (let codepoint = start; codepoint <= stop; codepoint += 1) {
        set.add(codepoint);
      }
    }
  }

  for (const char of Array.from(args.chars)) {
    const codepoint = char.codePointAt(0);
    if (codepoint != null) {
      set.add(codepoint);
    }
  }

  // Explicit control entries used by the runtime.
  set.add(0x0009); // tab
  set.add(0x0020); // space
  set.add(0x00ad); // soft hyphen
  set.add(0x200b); // zero-width space
  set.add(0x2060); // word-joiner
  set.add(0xfeff); // zero-width no-break space

  return Array.from(set).sort((a, b) => a - b);
}

function loadDependencies() {
  let opentype;
  let createCanvas;

  try {
    opentype = require("opentype.js");
  } catch (_err) {
    throw new Error('Missing dependency "opentype.js". Run: npm install opentype.js');
  }

  try {
    ({ createCanvas } = require("canvas"));
  } catch (_err) {
    throw new Error('Missing dependency "canvas". Run: npm install canvas');
  }

  return {
    opentype,
    createCanvas,
  };
}

function getGlyphMetrics(glyph, scale) {
  const metrics = typeof glyph.getMetrics === "function" ? glyph.getMetrics() : {};
  const xMinRaw = Number.isFinite(metrics.xMin) ? metrics.xMin : glyph.xMin;
  const yMinRaw = Number.isFinite(metrics.yMin) ? metrics.yMin : glyph.yMin;
  const xMaxRaw = Number.isFinite(metrics.xMax) ? metrics.xMax : glyph.xMax;
  const yMaxRaw = Number.isFinite(metrics.yMax) ? metrics.yMax : glyph.yMax;
  const advanceWidthRaw = Number.isFinite(glyph.advanceWidth) ? glyph.advanceWidth : metrics.advanceWidth;

  const xMin = Number.isFinite(xMinRaw) ? xMinRaw : 0;
  const yMin = Number.isFinite(yMinRaw) ? yMinRaw : 0;
  const xMax = Number.isFinite(xMaxRaw) ? xMaxRaw : 0;
  const yMax = Number.isFinite(yMaxRaw) ? yMaxRaw : 0;
  const advanceWidth = Number.isFinite(advanceWidthRaw) ? advanceWidthRaw : 0;

  const widthRaw = (xMax - xMin) * scale;
  const heightRaw = (yMax - yMin) * scale;
  const width = Number.isFinite(widthRaw) ? Math.max(0, widthRaw) : 0;
  const height = Number.isFinite(heightRaw) ? Math.max(0, heightRaw) : 0;
  const advance = Number.isFinite(advanceWidth * scale) ? advanceWidth * scale : 0;
  const bearingX = Number.isFinite(xMin * scale) ? xMin * scale : 0;
  const bearingY = Number.isFinite(yMax * scale) ? yMax * scale : 0;

  return {
    xMin,
    yMin,
    xMax,
    yMax,
    width,
    height,
    advance,
    bearingX,
    bearingY,
  };
}

function packGlyphs(glyphEntries, padding, pageSize) {
  const sortable = [];
  let maxCellWidth = 0;
  let maxCellHeight = 0;
  let packedPixels = 0;

  for (const entry of glyphEntries) {
    const paddedWidth = Math.max(1, Math.ceil(entry.metrics.width + padding * 2));
    const paddedHeight = Math.max(1, Math.ceil(entry.metrics.height + padding * 2));
    if (paddedWidth > pageSize || paddedHeight > pageSize) {
      const codepointHex = entry.codepoint.toString(16).toUpperCase().padStart(4, "0");
      throw new Error(
        `Glyph U+${codepointHex} with padded size ${paddedWidth}x${paddedHeight} ` +
        `does not fit in atlas page ${pageSize}x${pageSize}.`
      );
    }

    if (paddedWidth > maxCellWidth) {
      maxCellWidth = paddedWidth;
    }
    if (paddedHeight > maxCellHeight) {
      maxCellHeight = paddedHeight;
    }
    packedPixels += paddedWidth * paddedHeight;

    sortable.push({
      entry,
      paddedWidth,
      paddedHeight,
    });
  }

  sortable.sort((left, right) => {
    if (right.paddedHeight !== left.paddedHeight) {
      return right.paddedHeight - left.paddedHeight;
    }
    if (right.paddedWidth !== left.paddedWidth) {
      return right.paddedWidth - left.paddedWidth;
    }
    return left.entry.codepoint - right.entry.codepoint;
  });

  const pages = [
    {
      shelves: [],
      usedHeight: 0,
    },
  ];

  for (const item of sortable) {
    let placed = false;

    for (let pageIndex = 0; pageIndex < pages.length && !placed; pageIndex += 1) {
      const page = pages[pageIndex];

      for (const shelf of page.shelves) {
        if (item.paddedHeight > shelf.height) {
          continue;
        }
        if (shelf.x + item.paddedWidth > pageSize) {
          continue;
        }

        item.entry.atlasPage = pageIndex + 1;
        item.entry.atlasX = shelf.x;
        item.entry.atlasY = shelf.y;
        shelf.x += item.paddedWidth;
        placed = true;
        break;
      }

      if (placed) {
        continue;
      }

      if (page.usedHeight + item.paddedHeight > pageSize) {
        continue;
      }

      const shelf = {
        y: page.usedHeight,
        height: item.paddedHeight,
        x: item.paddedWidth,
      };
      page.shelves.push(shelf);
      page.usedHeight += item.paddedHeight;

      item.entry.atlasPage = pageIndex + 1;
      item.entry.atlasX = 0;
      item.entry.atlasY = shelf.y;
      placed = true;
    }

    if (placed) {
      continue;
    }

    pages.push({
      shelves: [
        {
          y: 0,
          height: item.paddedHeight,
          x: item.paddedWidth,
        },
      ],
      usedHeight: item.paddedHeight,
    });

    item.entry.atlasPage = pages.length;
    item.entry.atlasX = 0;
    item.entry.atlasY = 0;
  }

  return {
    pageCount: pages.length,
    maxCellWidth: Math.max(1, maxCellWidth),
    maxCellHeight: Math.max(1, maxCellHeight),
    packedPixels,
  };
}

function rasterizeAtlasPages(glyphEntries, pageCount, pageSize, fontSize, padding, createCanvas) {
  const contexts = [];

  for (let index = 0; index < pageCount; index += 1) {
    const canvas = createCanvas(pageSize, pageSize);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, pageSize, pageSize);
    ctx.fillStyle = "white";
    contexts.push(ctx);
  }

  for (const entry of glyphEntries) {
    const ctx = contexts[entry.atlasPage - 1];
    const drawX = entry.atlasX + padding - entry.metrics.xMin * entry.scale;
    const drawY = entry.atlasY + padding + entry.metrics.yMax * entry.scale;
    entry.glyph.draw(ctx, drawX, drawY, fontSize);
  }

  return contexts;
}

function collectEmbeddedGlyphPixels(glyphEntries, contexts, padding) {
  const glyphPixels = {};

  for (const entry of glyphEntries) {
    const width = Math.max(0, Math.floor(entry.metrics.width + 0.5));
    const height = Math.max(0, Math.floor(entry.metrics.height + 0.5));
    let base64 = "";

    if (width > 0 && height > 0) {
      const ctx = contexts[entry.atlasPage - 1];
      if (!ctx || typeof ctx.getImageData !== "function") {
        throw new Error(`Unable to read rasterized glyph pixels for codepoint ${entry.codepoint}.`);
      }

      // Glyphs are drawn inset by padding inside each packed cell.
      const sampleX = Math.max(0, Math.floor(entry.atlasX + padding + 0.5));
      const sampleY = Math.max(0, Math.floor(entry.atlasY + padding + 0.5));
      const imageData = ctx.getImageData(sampleX, sampleY, width, height);
      base64 = Buffer.from(imageData.data).toString("base64");
    }

    glyphPixels[entry.codepoint] = {
      width,
      height,
      base64,
    };
  }

  return glyphPixels;
}

function buildKerningTable(font, glyphEntries, scale) {
  const kerning = {};
  const glyphIndexToCodepoint = new Map();

  for (const entry of glyphEntries) {
    if (!glyphIndexToCodepoint.has(entry.glyph.index)) {
      glyphIndexToCodepoint.set(entry.glyph.index, entry.codepoint);
    }
  }

  if (!font.kerningPairs || typeof font.kerningPairs !== "object") {
    return kerning;
  }

  for (const [pairKey, unitsValue] of Object.entries(font.kerningPairs)) {
    const commaIndex = pairKey.indexOf(",");
    if (commaIndex < 0) {
      continue;
    }

    const leftGlyphIndex = Number(pairKey.slice(0, commaIndex));
    const rightGlyphIndex = Number(pairKey.slice(commaIndex + 1));
    if (!Number.isFinite(leftGlyphIndex) || !Number.isFinite(rightGlyphIndex)) {
      continue;
    }

    const leftCodepoint = glyphIndexToCodepoint.get(leftGlyphIndex);
    const rightCodepoint = glyphIndexToCodepoint.get(rightGlyphIndex);
    if (leftCodepoint == null || rightCodepoint == null) {
      continue;
    }

    const value = Number(unitsValue) * scale;
    if (!value) {
      continue;
    }

    kerning[`${leftCodepoint}:${rightCodepoint}`] = value;
  }

  return kerning;
}

function buildMetricsModule({
  fontName,
  sourceFile,
  fontSize,
  lineHeight,
  pageSize,
  pageFiles,
  cellWidth,
  cellHeight,
  padding,
  glyphEntries,
  kerning,
  glyphPixels,
}) {
  const lines = [];
  lines.push("--!strict");
  lines.push("");
  lines.push("local GlyphMetrics = {");
  lines.push("\tfont = {");
  lines.push(`\t\tname = ${JSON.stringify(fontName)},`);
  lines.push(`\t\tsource = ${JSON.stringify(sourceFile)},`);
  lines.push(`\t\tsize = ${formatNumber(fontSize)},`);
  lines.push(`\t\tlineHeight = ${formatNumber(lineHeight)},`);
  lines.push("\t},");
  lines.push("\tatlas = {");
  lines.push(`\t\tpageWidth = ${pageSize},`);
  lines.push(`\t\tpageHeight = ${pageSize},`);
  lines.push(`\t\tcellWidth = ${cellWidth},`);
  lines.push(`\t\tcellHeight = ${cellHeight},`);
  lines.push(`\t\tpadding = ${formatNumber(padding)},`);
  lines.push("\t\tpages = {");
  for (const pageFile of pageFiles) {
    lines.push(`\t\t\t${JSON.stringify(pageFile)},`);
  }
  lines.push("\t\t},");
  lines.push("\t},");
  lines.push("\tglyphs = {");

  for (const entry of glyphEntries) {
    lines.push(`\t\t[${entry.codepoint}] = {`);
    lines.push(`\t\t\tadvance = ${formatNumber(entry.metrics.advance)},`);
    lines.push(`\t\t\tbearingX = ${formatNumber(entry.metrics.bearingX)},`);
    lines.push(`\t\t\tbearingY = ${formatNumber(entry.metrics.bearingY)},`);
    lines.push(`\t\t\twidth = ${formatNumber(entry.metrics.width)},`);
    lines.push(`\t\t\theight = ${formatNumber(entry.metrics.height)},`);
    lines.push(`\t\t\tatlasPage = ${entry.atlasPage},`);
    lines.push(`\t\t\tatlasX = ${entry.atlasX},`);
    lines.push(`\t\t\tatlasY = ${entry.atlasY},`);
    lines.push(`\t\t\tglyphIndex = ${entry.glyph.index},`);
    lines.push("\t\t},");
  }

  lines.push("\t},");
  lines.push("\tkerning = {");
  const kerningKeys = Object.keys(kerning).sort();
  for (const key of kerningKeys) {
    lines.push(`\t\t[${JSON.stringify(key)}] = ${formatNumber(kerning[key])},`);
  }
  lines.push("\t},");
  lines.push("\tglyphPixels = {");
  for (const entry of glyphEntries) {
    const pixels = glyphPixels[entry.codepoint];
    lines.push(`\t\t[${entry.codepoint}] = {`);
    lines.push(`\t\t\twidth = ${pixels.width},`);
    lines.push(`\t\t\theight = ${pixels.height},`);
    lines.push(`\t\t\tbase64 = ${JSON.stringify(pixels.base64)},`);
    lines.push("\t\t},");
  }
  lines.push("\t},");
  lines.push("}");
  lines.push("");
  lines.push("return GlyphMetrics");
  lines.push("");

  return lines.join("\n");
}

function runGenerate(argv) {
  const args = parseGenerateArgs(argv);
  if (args.help || !args.fontPath) {
    console.log(HELP_TEXT);
    process.exit(args.help ? 0 : 1);
  }

  const { opentype, createCanvas } = loadDependencies();

  const sourceFontPath = path.resolve(args.fontPath);
  if (!fs.existsSync(sourceFontPath)) {
    throw new Error(`Font file does not exist: ${sourceFontPath}`);
  }

  const outputDirectory = path.resolve(
    args.outputPath ?? resolveOutputDefault(null, "atlas") ?? path.dirname(sourceFontPath)
  );
  fs.mkdirSync(outputDirectory, { recursive: true });

  const font = opentype.loadSync(sourceFontPath);
  const unitsPerEm = Number(font.unitsPerEm || (font.tables && font.tables.head && font.tables.head.unitsPerEm));
  if (!Number.isFinite(unitsPerEm) || unitsPerEm <= 0) {
    throw new Error(
      `Unable to read a valid unitsPerEm from "${path.basename(sourceFontPath)}". ` +
      "This font may be malformed or unsupported by opentype.js."
    );
  }
  const scale = args.size / unitsPerEm;
  const codepoints = resolveCodepoints(args);
  const glyphEntries = [];

  for (const codepoint of codepoints) {
    const char = String.fromCodePoint(codepoint);
    const glyph = font.charToGlyph(char);
    if (!glyph) {
      continue;
    }

    glyphEntries.push({
      codepoint,
      glyph,
      scale,
      metrics: getGlyphMetrics(glyph, scale),
      atlasPage: 0,
      atlasX: 0,
      atlasY: 0,
    });
  }

  if (glyphEntries.length === 0) {
    throw new Error("No glyphs were resolved from the selected charset.");
  }

  const { pageCount, maxCellWidth, maxCellHeight, packedPixels } = packGlyphs(glyphEntries, args.padding, args.maxSize);
  const pageContexts = rasterizeAtlasPages(
    glyphEntries,
    pageCount,
    args.maxSize,
    args.size,
    args.padding,
    createCanvas
  );
  const glyphPixels = collectEmbeddedGlyphPixels(glyphEntries, pageContexts, args.padding);

  const kerning = buildKerningTable(font, glyphEntries, scale);
  const moduleText = buildMetricsModule({
    fontName: args.fontName || font.names.fullName.en || path.basename(sourceFontPath, path.extname(sourceFontPath)),
    sourceFile: path.basename(sourceFontPath),
    fontSize: args.size,
    lineHeight: args.lineHeight,
    pageSize: args.maxSize,
    pageFiles: [],
    cellWidth: maxCellWidth,
    cellHeight: maxCellHeight,
    padding: args.padding,
    glyphEntries,
    kerning,
    glyphPixels,
  });

  const metricsPath = path.join(outputDirectory, "GlyphMetrics.luau");
  fs.writeFileSync(metricsPath, moduleText, "utf8");

  const totalPixels = pageCount * args.maxSize * args.maxSize;
  const wastedPixels = Math.max(0, totalPixels - packedPixels);
  const usedPercent = totalPixels > 0 ? (packedPixels / totalPixels) * 100 : 0;
  const wastedPercent = totalPixels > 0 ? (wastedPixels / totalPixels) * 100 : 0;

  console.log(`Generated embedded Luau font for ${glyphEntries.length} glyphs.`);
  console.log(`  Font: ${path.relative(process.cwd(), sourceFontPath)}`);
  console.log(`  Packed pages: ${pageCount} (${args.maxSize}x${args.maxSize})`);
  console.log(
    `  Packing: ${formatNumber(usedPercent)}% used (${packedPixels}/${totalPixels} px, wasted ${formatNumber(wastedPercent)}%)`
  );
  console.log(`  Cell: ${maxCellWidth}x${maxCellHeight} (padding=${args.padding})`);
  console.log(`  Embedded glyph pixels: ${Object.keys(glyphPixels).length}`);
  console.log(`  Module: ${path.relative(process.cwd(), metricsPath)}`);
}

function runAtlas(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "-h" || command === "--help") {
    console.log(HELP_TEXT);
    process.exit(command ? 0 : 1);
  }

  if (command === "generate") {
    runGenerate(rest);
    return;
  }

  throw new Error(`Unknown atlas command: ${command}`);
}

module.exports = {
  runAtlas,
};
