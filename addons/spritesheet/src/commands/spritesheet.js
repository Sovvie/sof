"use strict";

const fs = require("fs");
const path = require("path");
const fg = require("fast-glob");
const { createCanvas, loadImage } = require("canvas");
const { resolveOutputDefault } = require("../output-config");

const HELP_TEXT = `
sof run spritesheet - Pack images into sprite atlas sheets

USAGE:
  sof run spritesheet pack <inputDir> [outputDir] [options]

COMMANDS:
  pack
    sof run spritesheet pack <inputDir> [outputDir] [options]
    Pack images into one or more atlas pages and emit Luau metadata
    OPTIONS:
      --name <prefix>            Output file prefix (default: spritesheet)
      --max-size <number>        Max atlas side in pixels (default: 1024)
      --padding <number>         Padding between sprites (default: 2)
      --trim                     Trim transparent borders before packing
      -h, --help                 Show this help message
`;

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

function displayPath(value) {
  const relative = path.relative(process.cwd(), value);
  return relative || ".";
}

function parseIntegerOption(value, optionName, min = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${optionName} must be an integer >= ${min}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const output = {
    command: null,
    inputDir: null,
    outputDir: null,
    name: "spritesheet",
    maxSize: 1024,
    padding: 2,
    trim: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--trim") {
      output.trim = true;
      continue;
    }

    if (arg === "--name") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--name requires a value.");
      }
      output.name = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--max-size") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--max-size requires a value.");
      }
      output.maxSize = parseIntegerOption(value, "--max-size", 16);
      index += 1;
      continue;
    }

    if (arg === "--padding") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--padding requires a value.");
      }
      output.padding = parseIntegerOption(value, "--padding", 0);
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
  }
  if (positional.length > 1) {
    output.inputDir = positional[1];
  }
  if (positional.length > 2) {
    output.outputDir = positional[2];
  }
  if (positional.length > 3) {
    throw new Error("spritesheet pack accepts at most: <inputDir> [outputDir].");
  }

  return output;
}

function trimImageBounds(image) {
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;

  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = data[(y * image.width + x) * 4 + 3];
      if (alpha === 0) {
        continue;
      }
      if (x < minX) {
        minX = x;
      }
      if (y < minY) {
        minY = y;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (y > maxY) {
        maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
      offsetX: 0,
      offsetY: 0,
    };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    offsetX: minX,
    offsetY: minY,
  };
}

function toSafeLuaKey(name, index) {
  const base = name.replace(/[^A-Za-z0-9_]+/g, "_");
  const safe = /^[A-Za-z_]/.test(base) ? base : `sprite_${base}`;
  return safe || `sprite_${index}`;
}

function collectInputImages(inputDirectory) {
  const patterns = IMAGE_EXTENSIONS.map((ext) => `**/*${ext}`);
  const files = fg.sync(patterns, {
    cwd: inputDirectory,
    absolute: true,
    onlyFiles: true,
    caseSensitiveMatch: false,
  });

  return Array.from(new Set(files.map((value) => path.resolve(value)))).sort((a, b) =>
    a.localeCompare(b)
  );
}

function placeSprites(items, maxSize, padding) {
  const pages = [];
  let page = {
    width: 0,
    height: 0,
    items: [],
    cursorX: 0,
    cursorY: 0,
    rowHeight: 0,
  };

  function newPage() {
    page = {
      width: 0,
      height: 0,
      items: [],
      cursorX: 0,
      cursorY: 0,
      rowHeight: 0,
    };
    pages.push(page);
  }

  newPage();

  const sorted = items.slice().sort((a, b) => {
    if (b.bounds.height !== a.bounds.height) {
      return b.bounds.height - a.bounds.height;
    }
    return b.bounds.width - a.bounds.width;
  });

  for (const item of sorted) {
    const itemWidth = item.bounds.width;
    const itemHeight = item.bounds.height;
    if (itemWidth > maxSize || itemHeight > maxSize) {
      throw new Error(
        `Sprite "${item.name}" exceeds max atlas size (${itemWidth}x${itemHeight} > ${maxSize}).`
      );
    }

    if (page.cursorX + itemWidth > maxSize) {
      page.cursorX = 0;
      page.cursorY += page.rowHeight + padding;
      page.rowHeight = 0;
    }

    if (page.cursorY + itemHeight > maxSize) {
      newPage();
    }

    item.placement = {
      pageIndex: pages.length - 1,
      x: page.cursorX,
      y: page.cursorY,
      width: itemWidth,
      height: itemHeight,
    };

    page.items.push(item);
    page.width = Math.max(page.width, page.cursorX + itemWidth);
    page.height = Math.max(page.height, page.cursorY + itemHeight);
    page.rowHeight = Math.max(page.rowHeight, itemHeight);
    page.cursorX += itemWidth + padding;
  }

  return pages;
}

function renderPages(pages, outputDirectory, namePrefix) {
  const writtenPages = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const canvas = createCanvas(Math.max(page.width, 1), Math.max(page.height, 1));
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);

    for (const item of page.items) {
      const crop = item.bounds;
      const placement = item.placement;
      context.drawImage(
        item.image,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        placement.x,
        placement.y,
        placement.width,
        placement.height
      );
    }

    const fileName = pages.length === 1 ? `${namePrefix}.png` : `${namePrefix}_${pageIndex + 1}.png`;
    const outputPath = path.join(outputDirectory, fileName);
    fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));
    writtenPages.push({
      fileName,
      outputPath,
    });
  }

  return writtenPages;
}

function buildSpriteLua(items, pages, outputPrefix) {
  const lines = [];
  lines.push("--!strict");
  lines.push(`-- Auto-generated by "sof run spritesheet pack"`);
  lines.push("");
  lines.push("return {");
  lines.push("    pages = {");
  for (let index = 0; index < pages.length; index += 1) {
    const pageFileName = pages[index].fileName.replace(/\\/g, "/");
    lines.push(`        [${index + 1}] = "${pageFileName}",`);
  }
  lines.push("    },");
  lines.push("    sprites = {");

  const usedKeys = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const baseKey = toSafeLuaKey(item.name, index + 1);
    const count = usedKeys.get(baseKey) || 0;
    usedKeys.set(baseKey, count + 1);
    const key = count === 0 ? baseKey : `${baseKey}_${count + 1}`;

    const placement = item.placement;
    lines.push(`        ${key} = {`);
    lines.push(`            page = ${placement.pageIndex + 1},`);
    lines.push(`            x = ${placement.x},`);
    lines.push(`            y = ${placement.y},`);
    lines.push(`            width = ${placement.width},`);
    lines.push(`            height = ${placement.height},`);
    lines.push(`            sourceWidth = ${item.image.width},`);
    lines.push(`            sourceHeight = ${item.image.height},`);
    lines.push(`            offsetX = ${item.bounds.offsetX},`);
    lines.push(`            offsetY = ${item.bounds.offsetY},`);
    lines.push("        },");
  }

  lines.push("    },");
  lines.push("    name = " + `"${outputPrefix}"` + ",");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

async function runPack(args) {
  if (!args.inputDir) {
    throw new Error("spritesheet pack requires <inputDir>.");
  }

  const inputDirectory = path.resolve(args.inputDir);
  if (!fs.existsSync(inputDirectory) || !fs.statSync(inputDirectory).isDirectory()) {
    throw new Error(`Input directory does not exist: ${inputDirectory}`);
  }

  const outputDirectory = path.resolve(
    args.outputDir ?? resolveOutputDefault(null, "spritesheet") ?? inputDirectory
  );
  fs.mkdirSync(outputDirectory, { recursive: true });

  const files = collectInputImages(inputDirectory);
  if (files.length === 0) {
    throw new Error(`No images found in ${displayPath(inputDirectory)}.`);
  }

  const items = [];
  for (const filePath of files) {
    const image = await loadImage(filePath);
    const bounds = args.trim
      ? trimImageBounds(image)
      : {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
          offsetX: 0,
          offsetY: 0,
        };

    items.push({
      filePath,
      name: path.basename(filePath, path.extname(filePath)),
      image,
      bounds,
      placement: null,
    });
  }

  const pages = placeSprites(items, args.maxSize, args.padding);
  const writtenPages = renderPages(pages, outputDirectory, args.name);
  const metadataPath = path.join(outputDirectory, `${args.name}_data.luau`);
  fs.writeFileSync(metadataPath, buildSpriteLua(items, writtenPages, args.name), "utf8");

  console.log(`Packed ${items.length} sprite(s) into ${writtenPages.length} page(s).`);
  for (const page of writtenPages) {
    console.log(`  ✓ ${displayPath(page.outputPath)}`);
  }
  console.log(`  ✓ ${displayPath(metadataPath)}`);
}

function runSpritesheet(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.command) {
    console.log(HELP_TEXT);
    process.exit(args.help ? 0 : 1);
  }

  if (args.command !== "pack") {
    throw new Error(`Unknown spritesheet command: ${args.command}`);
  }

  return runPack(args);
}

module.exports = {
  runSpritesheet,
};
