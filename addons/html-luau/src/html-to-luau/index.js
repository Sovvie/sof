"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parse } = require("node-html-parser");
const fetch = require("node-fetch");
const { uploadImageFiles, resolveCreatorId } = require("../uploader/asset-upload");

const IGNORED_TAGS = new Set([
  "style",
  "script",
  "head",
  "meta",
  "link",
  "title",
  "html",
  "body",
  "noscript",
  "template",
]);

const TAG_TO_CLASS = {
  div: "Frame",
  section: "Frame",
  article: "Frame",
  nav: "Frame",
  main: "Frame",
  aside: "Frame",
  form: "Frame",
  ul: "Frame",
  ol: "Frame",
  span: "TextLabel",
  p: "TextLabel",
  h1: "TextLabel",
  h2: "TextLabel",
  h3: "TextLabel",
  h4: "TextLabel",
  h5: "TextLabel",
  h6: "TextLabel",
  li: "TextLabel",
  label: "TextLabel",
  button: "TextButton",
  a: "TextButton",
  input: "TextBox",
  textarea: "TextBox",
  img: "ImageLabel",
  hr: "Frame",
};

const PROPERTY_ORDER = [
  "Name",
  "Size",
  "Position",
  "AnchorPoint",
  "AutomaticSize",
  "BackgroundColor3",
  "BackgroundTransparency",
  "BorderSizePixel",
  "ZIndex",
  "Text",
  "PlaceholderText",
  "TextColor3",
  "TextSize",
  "TextWrapped",
  "TextXAlignment",
  "TextYAlignment",
  "FontFace",
  "ClearTextOnFocus",
  "MultiLine",
  "Image",
  "ScaleType",
  "LayoutOrder",
];

const DEFAULT_FONT = 'Font.new("rbxasset://fonts/families/GothamSSm.json")';

const HTML_PARSE_OPTIONS = {
  lowerCaseTagName: true,
  comment: false,
  voidTag: {
    tags: [
      "area",
      "base",
      "br",
      "col",
      "embed",
      "hr",
      "img",
      "input",
      "link",
      "meta",
      "param",
      "source",
      "track",
      "wbr",
    ],
    closingSlash: true,
  },
};

const IMAGE_UPLOAD_CACHE_VERSION = 1;
const DEFAULT_IMAGE_UPLOAD_CACHE_PATH = path.join(os.homedir(), ".sof", "html-luau-image-cache.json");

function sanitizeVarName(name) {
  let sanitized = String(name || "")
    .replace(/^["']|["']$/g, "")
    .replace(/[^A-Za-z0-9_]/g, "_");
  if (!sanitized) {
    sanitized = "_node";
  }
  if (/^\d/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  return sanitized;
}

function parseInlineStyle(styleText) {
  const output = {};
  if (!styleText) {
    return output;
  }

  const declarations = String(styleText).split(";");
  for (const declaration of declarations) {
    const splitIndex = declaration.indexOf(":");
    if (splitIndex < 0) {
      continue;
    }
    const key = declaration.slice(0, splitIndex).trim().toLowerCase();
    const value = declaration.slice(splitIndex + 1).trim();
    if (key && value) {
      output[key] = value;
    }
  }

  return output;
}

function parseBoxSpacingShorthand(value) {
  const tokens = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  let top;
  let right;
  let bottom;
  let left;

  if (tokens.length === 1) {
    [top] = tokens;
    right = top;
    bottom = top;
    left = top;
  } else if (tokens.length === 2) {
    [top, right] = tokens;
    bottom = top;
    left = right;
  } else if (tokens.length === 3) {
    [top, right, bottom] = tokens;
    left = right;
  } else {
    [top, right, bottom, left] = tokens;
  }

  return { top, right, bottom, left };
}

function expandMarginStyle(style) {
  const output = { ...style };
  if (!output.margin) {
    return output;
  }

  const expanded = parseBoxSpacingShorthand(output.margin);
  if (!expanded) {
    return output;
  }

  if (!output["margin-top"]) {
    output["margin-top"] = expanded.top;
  }
  if (!output["margin-right"]) {
    output["margin-right"] = expanded.right;
  }
  if (!output["margin-bottom"]) {
    output["margin-bottom"] = expanded.bottom;
  }
  if (!output["margin-left"]) {
    output["margin-left"] = expanded.left;
  }

  return output;
}

function normalizeCssSource(cssText) {
  return String(cssText || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@charset[^;]*;/gi, "");
}

function parseSimpleCssSelector(selectorText) {
  const selector = String(selectorText || "").trim();
  if (!selector) {
    return null;
  }

  if (/\s|[>+~:\[\]\*]/.test(selector)) {
    return null;
  }

  let remaining = selector;
  let tagName = null;
  let id = null;
  const classNames = [];

  const tagMatch = remaining.match(/^[A-Za-z][A-Za-z0-9-]*/);
  if (tagMatch) {
    tagName = tagMatch[0].toLowerCase();
    remaining = remaining.slice(tagMatch[0].length);
  }

  while (remaining.length > 0) {
    if (remaining.startsWith(".")) {
      const classMatch = remaining.match(/^\.[A-Za-z0-9_-]+/);
      if (!classMatch) {
        return null;
      }
      classNames.push(classMatch[0].slice(1));
      remaining = remaining.slice(classMatch[0].length);
      continue;
    }

    if (remaining.startsWith("#")) {
      if (id) {
        return null;
      }
      const idMatch = remaining.match(/^#[A-Za-z0-9_-]+/);
      if (!idMatch) {
        return null;
      }
      id = idMatch[0].slice(1);
      remaining = remaining.slice(idMatch[0].length);
      continue;
    }

    return null;
  }

  if (!tagName && !id && classNames.length === 0) {
    return null;
  }

  return { tagName, id, classNames };
}

function parseStyleSheetRules(cssText) {
  const rules = [];
  const source = normalizeCssSource(cssText);
  const blockRegex = /([^{}]+)\{([^{}]*)\}/g;
  let match;

  while ((match = blockRegex.exec(source))) {
    const declarationBlock = parseInlineStyle(match[2]);
    if (Object.keys(declarationBlock).length === 0) {
      continue;
    }

    const selectors = String(match[1] || "")
      .split(",")
      .map(parseSimpleCssSelector)
      .filter(Boolean);
    if (selectors.length === 0) {
      continue;
    }

    rules.push({
      selectors,
      declarationBlock,
    });
  }

  return rules;
}

function collectStyleSheetRules(parsedDocument) {
  const styleNodes = parsedDocument.querySelectorAll("style");
  const rules = [];

  for (const styleNode of styleNodes) {
    const styleText = styleNode.innerText || styleNode.textContent || styleNode.rawText || "";
    rules.push(...parseStyleSheetRules(styleText));
  }

  return rules;
}

function elementMatchesStyleSelector(element, selector) {
  const tagName = element.tagName ? String(element.tagName).toLowerCase() : "";
  if (selector.tagName && tagName !== selector.tagName) {
    return false;
  }

  if (selector.id) {
    const elementId = String(element.getAttribute("id") || "").trim();
    if (elementId !== selector.id) {
      return false;
    }
  }

  if (selector.classNames.length > 0) {
    const classSet = new Set((element.getAttribute("class") || "").split(/\s+/).filter(Boolean));
    for (const className of selector.classNames) {
      if (!classSet.has(className)) {
        return false;
      }
    }
  }

  return true;
}

function resolveStyleForElement(element, styleSheetRules) {
  if (!styleSheetRules || styleSheetRules.length === 0) {
    return {};
  }

  const resolved = {};
  for (const rule of styleSheetRules) {
    let matched = false;
    for (const selector of rule.selectors) {
      if (elementMatchesStyleSelector(element, selector)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      Object.assign(resolved, rule.declarationBlock);
    }
  }

  return resolved;
}

function parseLength(value) {
  if (!value) {
    return null;
  }

  const trimmed = String(value).trim();
  if (trimmed === "auto") {
    return { type: "auto" };
  }

  const percent = trimmed.match(/^(-?[\d.]+)%$/);
  if (percent) {
    return { type: "scale", value: parseFloat(percent[1]) / 100 };
  }

  const pixels = trimmed.match(/^(-?[\d.]+)px$/);
  if (pixels) {
    return { type: "offset", value: Math.round(parseFloat(pixels[1])) };
  }

  const numeric = trimmed.match(/^(-?[\d.]+)$/);
  if (numeric) {
    return { type: "offset", value: Math.round(parseFloat(numeric[1])) };
  }

  return null;
}

function lengthToOffset(lengthValue) {
  if (!lengthValue || lengthValue.type !== "offset") {
    return 0;
  }
  return lengthValue.value;
}

function mergeLengthValues(primary, secondary) {
  const output = { scale: 0, offset: 0 };

  const apply = (value) => {
    if (!value || value.type === "auto") {
      return;
    }
    if (value.type === "scale") {
      output.scale += value.value;
      return;
    }
    if (value.type === "offset") {
      output.offset += value.value;
    }
  };

  apply(primary);
  apply(secondary);

  return output;
}

function parseColor(value) {
  if (!value) {
    return null;
  }

  const input = String(value).trim().toLowerCase();
  if (input === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0, transparent: true };
  }

  const hex = input.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full =
      raw.length === 3
        ? `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
        : raw;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgb = input.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(",").map((part) => part.trim());
    if (parts.length >= 3) {
      const r = parseInt(parts[0], 10);
      const g = parseInt(parts[1], 10);
      const b = parseInt(parts[2], 10);
      const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
      if ([r, g, b].every((valuePart) => Number.isFinite(valuePart))) {
        return { r, g, b, a: Number.isFinite(a) ? a : 1 };
      }
    }
  }

  return null;
}

function colorToLuau(color) {
  if (!color || color.transparent) {
    return null;
  }
  return `Color3.fromRGB(${color.r}, ${color.g}, ${color.b})`;
}

function parseBackgroundColor(value) {
  const directColor = parseColor(value);
  if (directColor) {
    return directColor;
  }

  const input = String(value || "");
  const hexMatch = input.match(/#(?:[0-9a-f]{3}|[0-9a-f]{6})/i);
  if (hexMatch) {
    return parseColor(hexMatch[0]);
  }

  const rgbMatch = input.match(/rgba?\([^)]+\)/i);
  if (rgbMatch) {
    return parseColor(rgbMatch[0]);
  }

  if (/\btransparent\b/i.test(input)) {
    return parseColor("transparent");
  }

  return null;
}

function extractImageUrlsFromCssValue(value) {
  const urls = [];
  if (!value) {
    return urls;
  }

  const source = String(value);
  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match;
  while ((match = urlRegex.exec(source))) {
    const candidate = String(match[2] || "").trim();
    if (candidate) {
      urls.push(candidate);
    }
  }

  return urls;
}

function parseTextAlignment(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "left") {
    return "Enum.TextXAlignment.Left";
  }
  if (normalized === "center") {
    return "Enum.TextXAlignment.Center";
  }
  if (normalized === "right") {
    return "Enum.TextXAlignment.Right";
  }
  return null;
}

function parseVerticalAlignment(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "top") {
    return "Enum.TextYAlignment.Top";
  }
  if (normalized === "middle" || normalized === "center") {
    return "Enum.TextYAlignment.Center";
  }
  if (normalized === "bottom") {
    return "Enum.TextYAlignment.Bottom";
  }
  return null;
}

function parseZIndex(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return null;
  }

  if (!/^-?\d+$/.test(normalized)) {
    return null;
  }

  const parsed = parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, parsed);
}

function isPositionedForStacking(style, hasDirectPosition, isOutOfFlow) {
  const positionMode = String(style.position || "").trim().toLowerCase();
  return isOutOfFlow || hasDirectPosition || positionMode === "sticky";
}

function assignAutoZIndexForPositionedChildren(children, parentZIndexValue) {
  const positionedChildren = children.filter((childNode) => childNode?._meta?.isPositionedForStacking);
  if (positionedChildren.length <= 1) {
    return;
  }

  const hasExplicitZIndex = positionedChildren.some((childNode) => childNode?._meta?.hasExplicitZIndex);
  if (hasExplicitZIndex) {
    return;
  }

  const parentZIndex = Number.parseInt(String(parentZIndexValue || "0"), 10);
  let autoZIndex = Number.isFinite(parentZIndex) ? Math.max(1, parentZIndex + 1) : 1;
  for (const childNode of positionedChildren) {
    if (childNode.properties && childNode.properties.ZIndex === undefined) {
      childNode.properties.ZIndex = String(autoZIndex);
    }
    autoZIndex += 1;
  }
}

function parseUDim2Offsets(value) {
  const match = String(value || "")
    .trim()
    .match(
      /^UDim2\.new\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/
    );
  if (!match) {
    return null;
  }

  return {
    xScale: parseFloat(match[1]),
    xOffset: Math.round(parseFloat(match[2])),
    yScale: parseFloat(match[3]),
    yOffset: Math.round(parseFloat(match[4])),
  };
}

function resolveFlowNodeHeightOffset(node) {
  const explicitOffset = node?._meta?.flowHeightOffset;
  if (Number.isFinite(explicitOffset)) {
    return explicitOffset;
  }

  const parsedSize = parseUDim2Offsets(node?.properties?.Size);
  if (parsedSize && parsedSize.yScale === 0) {
    return parsedSize.yOffset;
  }

  return 0;
}

function applyFlowLayoutToChildren(children) {
  let cursorY = 0;

  for (const childNode of children) {
    const meta = childNode?._meta || {};
    if (meta.isOutOfFlow) {
      continue;
    }

    const marginTopOffset = Number.isFinite(meta.flowMarginTopOffset) ? meta.flowMarginTopOffset : 0;
    const marginBottomOffset = Number.isFinite(meta.flowMarginBottomOffset) ? meta.flowMarginBottomOffset : 0;
    const marginLeftOffset = Number.isFinite(meta.flowMarginLeftOffset) ? meta.flowMarginLeftOffset : 0;
    const yOffset = cursorY + marginTopOffset;

    const existingPosition = parseUDim2Offsets(childNode.properties.Position);
    if (existingPosition) {
      childNode.properties.Position = `UDim2.new(${existingPosition.xScale}, ${
        existingPosition.xOffset + marginLeftOffset
      }, ${existingPosition.yScale}, ${existingPosition.yOffset + yOffset})`;
    } else {
      childNode.properties.Position = `UDim2.new(0, ${marginLeftOffset}, 0, ${yOffset})`;
    }

    cursorY = yOffset + resolveFlowNodeHeightOffset(childNode) + marginBottomOffset;
  }
}

function isTextClass(className) {
  return className === "TextLabel" || className === "TextButton" || className === "TextBox";
}

function isLuauLiteral(value) {
  if (typeof value !== "string") {
    return false;
  }
  if (value === "true" || value === "false" || value === "nil") {
    return true;
  }
  if (/^-?[\d.]+$/.test(value)) {
    return true;
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    return true;
  }
  if (
    value.startsWith("UDim2.") ||
    value.startsWith("Vector2.") ||
    value.startsWith("Enum.") ||
    value.startsWith("Color3.") ||
    value.startsWith("Font.new")
  ) {
    return true;
  }
  return false;
}

function formatValue(value) {
  return isLuauLiteral(value) ? value : JSON.stringify(value);
}

function formatPropertyKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `["${key}"]`;
}

function sortProperties(properties) {
  return Object.entries(properties).sort(([left], [right]) => {
    const leftIndex = PROPERTY_ORDER.indexOf(left);
    const rightIndex = PROPERTY_ORDER.indexOf(right);
    const l = leftIndex >= 0 ? leftIndex : PROPERTY_ORDER.length;
    const r = rightIndex >= 0 ? rightIndex : PROPERTY_ORDER.length;
    return l - r;
  });
}

function buildPropertyLines(properties, indentLevel) {
  const indent = "\t".repeat(indentLevel);
  const innerIndent = "\t".repeat(indentLevel + 1);
  const entries = sortProperties(properties);
  if (entries.length === 0) {
    return [`${indent}{}`];
  }

  const lines = [`${indent}{`];
  for (const [key, value] of entries) {
    lines.push(`${innerIndent}${formatPropertyKey(key)} = ${formatValue(value)},`);
  }
  lines.push(`${indent}}`);
  return lines;
}

function basePropertiesForClass(className) {
  if (className === "Frame") {
    return {
      BackgroundTransparency: "1",
      BorderSizePixel: "0",
      Size: "UDim2.new(1, 0, 0, 0)",
      AutomaticSize: "Enum.AutomaticSize.Y",
    };
  }

  if (className === "ImageLabel") {
    return {
      BackgroundTransparency: "1",
      BorderSizePixel: "0",
      Size: "UDim2.new(0, 100, 0, 100)",
      ScaleType: "Enum.ScaleType.Fit",
    };
  }

  if (className === "TextBox") {
    return {
      BackgroundTransparency: "0",
      BorderSizePixel: "0",
      Size: "UDim2.new(1, 0, 0, 36)",
      TextSize: "14",
      TextColor3: "Color3.fromRGB(0, 0, 0)",
      FontFace: DEFAULT_FONT,
      ClearTextOnFocus: "false",
    };
  }

  if (className === "TextButton") {
    return {
      BackgroundTransparency: "0",
      BorderSizePixel: "0",
      AutomaticSize: "Enum.AutomaticSize.XY",
      TextSize: "14",
      TextColor3: "Color3.fromRGB(255, 255, 255)",
      BackgroundColor3: "Color3.fromRGB(59, 130, 246)",
      FontFace: DEFAULT_FONT,
    };
  }

  if (className === "TextLabel") {
    return {
      BackgroundTransparency: "1",
      BorderSizePixel: "0",
      AutomaticSize: "Enum.AutomaticSize.XY",
      TextSize: "14",
      TextColor3: "Color3.fromRGB(0, 0, 0)",
      FontFace: DEFAULT_FONT,
    };
  }

  return {
    BackgroundTransparency: "1",
    BorderSizePixel: "0",
  };
}

function parseHtmlDocument(htmlString) {
  return parse(htmlString, HTML_PARSE_OPTIONS);
}

function collectImageSources(htmlString) {
  const parsed = parseHtmlDocument(htmlString);
  const body = parsed.querySelector("body") || parsed;
  const sources = new Set();
  const styleSheetRules = collectStyleSheetRules(parsed);

  for (const image of body.querySelectorAll("img")) {
    const source = String(image.getAttribute("src") || "").trim();
    if (source) {
      sources.add(source);
    }
  }

  for (const rule of styleSheetRules) {
    for (const source of extractImageUrlsFromCssValue(rule.declarationBlock["background-image"])) {
      sources.add(source);
    }
    for (const source of extractImageUrlsFromCssValue(rule.declarationBlock.background)) {
      sources.add(source);
    }
  }

  for (const node of body.querySelectorAll("*")) {
    const inlineStyle = parseInlineStyle(node.getAttribute("style"));
    for (const source of extractImageUrlsFromCssValue(inlineStyle["background-image"])) {
      sources.add(source);
    }
    for (const source of extractImageUrlsFromCssValue(inlineStyle.background)) {
      sources.add(source);
    }
  }

  return [...sources];
}

function normalizeUploadedAssetId(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }
  const match = rawValue.match(/\d+/);
  if (!match) {
    return "";
  }
  return `rbxassetid://${match[0]}`;
}

function getImageUploadCachePath(options = {}) {
  const customPath = String(options.imageCachePath || "").trim();
  if (customPath) {
    return path.resolve(customPath);
  }
  return DEFAULT_IMAGE_UPLOAD_CACHE_PATH;
}

function readImageUploadCache(cachePath) {
  if (!fs.existsSync(cachePath)) {
    return { version: IMAGE_UPLOAD_CACHE_VERSION, entries: {} };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const inputEntries = raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object" ? raw.entries : {};
    const entries = {};

    for (const [cacheKey, cacheEntry] of Object.entries(inputEntries)) {
      if (!cacheEntry || typeof cacheEntry !== "object") {
        continue;
      }
      const assetId = normalizeUploadedAssetId(cacheEntry.assetId);
      if (!assetId) {
        continue;
      }
      entries[cacheKey] = {
        assetId,
        cachedAt: cacheEntry.cachedAt || null,
      };
    }

    return {
      version: IMAGE_UPLOAD_CACHE_VERSION,
      entries,
    };
  } catch (_err) {
    return { version: IMAGE_UPLOAD_CACHE_VERSION, entries: {} };
  }
}

function writeImageUploadCache(cachePath, cacheData) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify(
      {
        version: IMAGE_UPLOAD_CACHE_VERSION,
        entries: cacheData.entries || {},
      },
      null,
      2
    ),
    "utf8"
  );
}

function localImageCacheKey(sourcePath, stat) {
  const resolvedPath = path.resolve(sourcePath);
  const mtime = Number.isFinite(stat.mtimeMs) ? Math.floor(stat.mtimeMs) : 0;
  const size = Number.isFinite(stat.size) ? stat.size : 0;
  return `local:${resolvedPath}:${size}:${mtime}`;
}

function remoteImageCacheKey(source) {
  return `remote:${source}`;
}

function isRemoteImageSource(source) {
  return /^https?:\/\//i.test(source);
}

function extensionFromContentType(contentType) {
  const normalized = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const knownTypes = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/avif": ".avif",
    "image/heif": ".heif",
    "image/heic": ".heic",
  };
  return knownTypes[normalized] || "";
}

async function downloadRemoteImageToTemp(source, tempDir, index) {
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Download failed (status ${response.status})`);
  }

  const bytes = await response.buffer();
  if (!bytes.length) {
    throw new Error("Downloaded image is empty.");
  }

  let extension = "";
  try {
    extension = path.extname(new URL(source).pathname || "").toLowerCase();
  } catch (_err) {
    extension = "";
  }

  if (!/^\.[a-z0-9]+$/.test(extension) || extension.length > 6) {
    extension = extensionFromContentType(response.headers.get("content-type"));
  }
  if (!extension) {
    extension = ".png";
  }

  const filePath = path.join(tempDir, `remote_image_${index}${extension}`);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

async function resolveAndUploadImages(sources, options = {}) {
  const uniqueSources = [...new Set((sources || []).map((source) => String(source || "").trim()))].filter(
    Boolean
  );
  if (uniqueSources.length === 0) {
    return {};
  }

  const basePath = options.basePath ? path.resolve(options.basePath) : process.cwd();
  const cachePath = getImageUploadCachePath(options);
  const cacheExistsAtStart = fs.existsSync(cachePath);
  const cacheData = readImageUploadCache(cachePath);
  let cacheDirty = false;
  const imageMap = {};

  const pendingEntries = [];
  const pendingEntryByKey = new Map();
  const pendingByFilePath = new Map();
  let tempDir = null;

  function getCachedAsset(cacheKey) {
    const entry = cacheData.entries[cacheKey];
    if (!entry) {
      return "";
    }
    return normalizeUploadedAssetId(entry.assetId);
  }

  function addPendingEntry(cacheKey, source, filePath) {
    const existing = pendingEntryByKey.get(cacheKey);
    if (existing) {
      existing.sources.push(source);
      return;
    }

    const entry = {
      cacheKey,
      filePath,
      sources: [source],
    };
    pendingEntryByKey.set(cacheKey, entry);
    pendingByFilePath.set(filePath, entry);
    pendingEntries.push(entry);
  }

  try {
    for (let index = 0; index < uniqueSources.length; index += 1) {
      const source = uniqueSources[index];
      if (/^data:/i.test(source)) {
        console.warn("[html-luau] Skipping inline data URI image source.");
        continue;
      }

      if (isRemoteImageSource(source)) {
        const cacheKey = remoteImageCacheKey(source);
        const cachedAsset = getCachedAsset(cacheKey);
        if (cachedAsset) {
          imageMap[source] = cachedAsset;
          continue;
        }

        try {
          if (!tempDir) {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sof-html-luau-images-"));
          }

          const downloadedPath = await downloadRemoteImageToTemp(source, tempDir, index + 1);
          addPendingEntry(cacheKey, source, downloadedPath);
        } catch (err) {
          console.warn(`[html-luau] Failed to download image "${source}": ${err.message}`);
        }
        continue;
      }

      const resolvedPath = path.resolve(basePath, source);
      if (!fs.existsSync(resolvedPath)) {
        console.warn(`[html-luau] Image file not found: ${resolvedPath}`);
        continue;
      }

      const stats = fs.statSync(resolvedPath);
      if (!stats.isFile()) {
        console.warn(`[html-luau] Image path is not a file: ${resolvedPath}`);
        continue;
      }

      const cacheKey = localImageCacheKey(resolvedPath, stats);
      const cachedAsset = getCachedAsset(cacheKey);
      if (cachedAsset) {
        imageMap[source] = cachedAsset;
        continue;
      }

      addPendingEntry(cacheKey, source, resolvedPath);
    }

    if (pendingEntries.length === 0) {
      if (!cacheExistsAtStart) {
        writeImageUploadCache(cachePath, cacheData);
      }
      return imageMap;
    }

    const creatorID = await resolveCreatorId({
      creatorID: options.creatorID,
      isGroup: options.isGroup === true,
    });

    const filePaths = pendingEntries.map((entry) => entry.filePath);
    const report = await uploadImageFiles({
      filePaths,
      creatorID,
      isGroup: options.isGroup === true,
      apiKey: options.apiKey,
      onProgress: options.onProgress,
    });

    const uploadedAssetByPath = new Map();

    for (const entry of report.results || []) {
      const normalizedAssetId = normalizeUploadedAssetId(entry.newId);
      if (!normalizedAssetId) {
        continue;
      }
      uploadedAssetByPath.set(entry.oldId, normalizedAssetId);
    }

    for (const entry of report.moderated || []) {
      const normalizedAssetId = normalizeUploadedAssetId(entry.newId);
      if (!normalizedAssetId) {
        continue;
      }
      uploadedAssetByPath.set(entry.oldId, normalizedAssetId);
      console.warn(
        `[html-luau] Image "${entry.oldId}" is not fully approved yet (state: ${entry.state || "unknown"}).`
      );
    }

    for (const pendingEntry of pendingEntries) {
      const normalizedAssetId = uploadedAssetByPath.get(pendingEntry.filePath);
      if (!normalizedAssetId) {
        continue;
      }

      for (const source of pendingEntry.sources) {
        imageMap[source] = normalizedAssetId;
      }

      cacheData.entries[pendingEntry.cacheKey] = {
        assetId: normalizedAssetId,
        cachedAt: new Date().toISOString(),
      };
      cacheDirty = true;
    }

    for (const entry of report.failures || []) {
      const pendingEntry = pendingByFilePath.get(entry.assetId);
      const source = pendingEntry ? pendingEntry.sources[0] : entry.assetId;
      console.warn(`[html-luau] Failed to upload image "${source}": ${entry.error}`);
    }

    if (cacheDirty || !cacheExistsAtStart) {
      writeImageUploadCache(cachePath, cacheData);
    }

    return imageMap;
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function flattenNodes(rootNode) {
  const entries = [];

  function visit(node, parentId) {
    const id = entries.length + 1;
    entries.push({ id, parentId, node });
    for (const child of node.children) {
      visit(child, id);
    }
    return id;
  }

  const rootId = visit(rootNode, null);
  return { entries, rootId };
}

function generateLuau(rootNode, options) {
  const strict = options.strict !== false;
  const optimize = options.optimize !== undefined ? options.optimize : 2;
  const sourceFile = options.sourceFile || null;
  const rootType = rootNode.className;
  const flattened = flattenNodes(rootNode);

  const lines = [];
  if (strict) {
    lines.push("--!strict");
  }
  if (optimize !== null && optimize !== false) {
    lines.push(`--!optimize ${optimize}`);
  }
  lines.push("");

  if (sourceFile) {
    lines.push("-- Auto-generated by sof run html-luau");
    lines.push(`-- Source: ${sourceFile}`);
    lines.push("");
  }

  lines.push(
    "local function createNode(className: string, parentInstance: Instance?, properties: { [string]: any }): Instance"
  );
  lines.push('\tlocal instance = Instance.new(className)');
  lines.push("");
  lines.push("\tfor propertyName: string, propertyValue: any in properties do");
  lines.push("\t\t(instance :: any)[propertyName] = propertyValue");
  lines.push("\tend");
  lines.push("");
  lines.push("\tif parentInstance then");
  lines.push("\t\tinstance.Parent = parentInstance");
  lines.push("\tend");
  lines.push("");
  lines.push("\treturn instance");
  lines.push("end");
  lines.push("");

  lines.push(`local function create(parent: Instance): ${rootType}`);
  lines.push("\tlocal nodes: { [number]: Instance } = {}");
  lines.push("");

  for (const entry of flattened.entries) {
    const parentExpr = entry.parentId ? `nodes[${entry.parentId}]` : "parent";
    lines.push(`\tnodes[${entry.id}] = createNode(`);
    lines.push(`\t\t"${entry.node.className}",`);
    lines.push(`\t\t${parentExpr},`);
    lines.push(...buildPropertyLines(entry.node.properties, 2));
    lines.push("\t)");
    lines.push("");
  }

  lines.push(`\treturn nodes[${flattened.rootId}] :: ${rootType}`);
  lines.push("end");
  lines.push("");
  lines.push("return create");
  lines.push("");

  return lines.join("\n");
}

async function compileWithImageUpload(htmlString, options = {}) {
  const imageSources = collectImageSources(htmlString);
  if (imageSources.length === 0) {
    return compile(htmlString, options);
  }

  const imageMap = await resolveAndUploadImages(imageSources, options);
  return compile(htmlString, { ...options, imageMap });
}

function compile(htmlString, options) {
  const compileOptions = options || {};
  const imageMap = compileOptions.imageMap || null;
  const parsed = parseHtmlDocument(htmlString);
  const styleSheetRules = collectStyleSheetRules(parsed);

  const body = parsed.querySelector("body") || parsed;
  const usedNames = new Set();

  function uniqueVarName(baseName) {
    const base = sanitizeVarName(baseName);
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }

    let counter = 2;
    while (usedNames.has(`${base}${counter}`)) {
      counter += 1;
    }
    const unique = `${base}${counter}`;
    usedNames.add(unique);
    return unique;
  }

  function nodeNameFromElement(element, className) {
    const id = element.getAttribute("id");
    if (id) {
      return uniqueVarName(id);
    }
    const classes = (element.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    if (classes.length > 0) {
      return uniqueVarName(classes[0]);
    }
    return uniqueVarName(className);
  }

  function transformElement(element) {
    const tag = element.tagName ? String(element.tagName).toLowerCase() : null;
    if (!tag || IGNORED_TAGS.has(tag)) {
      return null;
    }

    const style = expandMarginStyle({
      ...resolveStyleForElement(element, styleSheetRules),
      ...parseInlineStyle(element.getAttribute("style")),
    });
    if (style.display && style.display.trim().toLowerCase() === "none") {
      return null;
    }

    const backgroundImageCandidates = [
      ...extractImageUrlsFromCssValue(style["background-image"]),
      ...extractImageUrlsFromCssValue(style.background),
    ];
    const backgroundImageSource = backgroundImageCandidates.length > 0 ? backgroundImageCandidates[0] : null;

    let className = TAG_TO_CLASS[tag] || "Frame";
    if (className === "Frame" && backgroundImageSource) {
      className = "ImageLabel";
    }
    const varName = nodeNameFromElement(element, className);
    const properties = { ...basePropertiesForClass(className) };
    properties.Name = JSON.stringify(varName);
    const zIndex = parseZIndex(style["z-index"]);
    const hasExplicitZIndex = zIndex !== null;
    if (zIndex !== null) {
      properties.ZIndex = String(zIndex);
    }

    const positionMode = String(style.position || "").trim().toLowerCase();
    const isOutOfFlow = positionMode === "absolute" || positionMode === "fixed";

    const width = parseLength(style.width || element.getAttribute("width"));
    const height = parseLength(style.height || element.getAttribute("height"));
    const flowHeightOffset = height && height.type === "offset" ? height.value : null;
    if (width || height) {
      let xScale = 1;
      let xOffset = 0;
      let yScale = 0;
      let yOffset = 0;

      if (width) {
        if (width.type === "auto") {
          properties.AutomaticSize =
            properties.AutomaticSize === "Enum.AutomaticSize.Y"
              ? "Enum.AutomaticSize.XY"
              : "Enum.AutomaticSize.X";
          xScale = 0;
          xOffset = 0;
        } else if (width.type === "scale") {
          xScale = width.value;
          xOffset = 0;
        } else {
          xScale = 0;
          xOffset = width.value;
        }
      }

      if (height) {
        if (height.type === "auto") {
          properties.AutomaticSize =
            properties.AutomaticSize === "Enum.AutomaticSize.X"
              ? "Enum.AutomaticSize.XY"
              : "Enum.AutomaticSize.Y";
          yScale = 0;
          yOffset = 0;
        } else if (height.type === "scale") {
          yScale = height.value;
          yOffset = 0;
        } else {
          yScale = 0;
          yOffset = height.value;
        }
      }

      properties.Size = `UDim2.new(${xScale}, ${xOffset}, ${yScale}, ${yOffset})`;
    }

    const left = parseLength(style.left);
    const top = parseLength(style.top);
    const marginLeft = parseLength(style["margin-left"]);
    const marginTop = parseLength(style["margin-top"]);
    const marginBottom = parseLength(style["margin-bottom"]);
    const hasDirectPosition = isOutOfFlow && Boolean(left || top || marginLeft || marginTop);
    if (hasDirectPosition) {
      const x = mergeLengthValues(left, marginLeft);
      const y = mergeLengthValues(top, marginTop);
      properties.Position = `UDim2.new(${x.scale}, ${x.offset}, ${y.scale}, ${y.offset})`;
    }

    const backgroundColor = parseBackgroundColor(style["background-color"] || style.background);
    if (backgroundColor) {
      if (backgroundColor.transparent) {
        properties.BackgroundTransparency = "1";
      } else {
        const luauColor = colorToLuau(backgroundColor);
        if (luauColor) {
          properties.BackgroundColor3 = luauColor;
        }
        properties.BackgroundTransparency =
          backgroundColor.a !== undefined && backgroundColor.a < 1
            ? String(Math.round((1 - backgroundColor.a) * 1000) / 1000)
            : "0";
      }
    }

    if (isTextClass(className)) {
      const textColor = parseColor(style.color);
      if (textColor && !textColor.transparent) {
        const luauColor = colorToLuau(textColor);
        if (luauColor) {
          properties.TextColor3 = luauColor;
        }
      }

      const fontSize = parseLength(style["font-size"]);
      if (fontSize && fontSize.type === "offset") {
        properties.TextSize = String(Math.max(1, fontSize.value));
      }

      const textAlign = parseTextAlignment(style["text-align"]);
      if (textAlign) {
        properties.TextXAlignment = textAlign;
      }

      const verticalAlign = parseVerticalAlignment(style["vertical-align"]);
      if (verticalAlign) {
        properties.TextYAlignment = verticalAlign;
      }
    }

    if (tag === "img") {
      const src = element.getAttribute("src");
      if (src) {
        const srcKey = String(src).trim();
        const resolvedSource = imageMap ? imageMap[src] || imageMap[srcKey] : null;
        properties.Image = JSON.stringify(resolvedSource || src);
      }
    } else if (backgroundImageSource && className === "ImageLabel") {
      const sourceKey = String(backgroundImageSource).trim();
      const resolvedSource = imageMap
        ? imageMap[backgroundImageSource] || imageMap[sourceKey]
        : null;
      properties.Image = JSON.stringify(resolvedSource || backgroundImageSource);

      const backgroundSize = String(style["background-size"] || "").trim().toLowerCase();
      if (backgroundSize.includes("cover")) {
        properties.ScaleType = "Enum.ScaleType.Crop";
      } else if (backgroundSize.includes("contain")) {
        properties.ScaleType = "Enum.ScaleType.Fit";
      } else {
        properties.ScaleType = "Enum.ScaleType.Stretch";
      }
    }

    if (className === "TextBox") {
      const placeholder = element.getAttribute("placeholder");
      if (placeholder) {
        properties.PlaceholderText = JSON.stringify(placeholder);
      }
      const value = element.getAttribute("value");
      if (value) {
        properties.Text = JSON.stringify(value);
      }
      if (tag === "textarea") {
        properties.MultiLine = "true";
        properties.TextWrapped = "true";
        properties.TextYAlignment = "Enum.TextYAlignment.Top";
        properties.TextXAlignment = "Enum.TextXAlignment.Left";
      }
    }

    if (isTextClass(className) && !properties.Text) {
      const textValue = element.textContent ? element.textContent.replace(/\s+/g, " ").trim() : "";
      properties.Text = JSON.stringify(textValue);
    }

    const children = [];
    for (const child of element.childNodes || []) {
      if (child.nodeType === 1) {
        const childNode = transformElement(child);
        if (childNode) {
          childNode.properties.LayoutOrder = String(children.length);
          children.push(childNode);
        }
      }
    }
    applyFlowLayoutToChildren(children);
    assignAutoZIndexForPositionedChildren(children, properties.ZIndex);

    return {
      className,
      varName,
      properties,
      children,
      _meta: {
        hasExplicitZIndex,
        isPositionedForStacking: isPositionedForStacking(style, hasDirectPosition, isOutOfFlow),
        isOutOfFlow,
        flowMarginTopOffset: lengthToOffset(marginTop),
        flowMarginBottomOffset: lengthToOffset(marginBottom),
        flowMarginLeftOffset: lengthToOffset(marginLeft),
        flowHeightOffset,
      },
    };
  }

  const rootChildren = [];
  for (const child of body.childNodes || []) {
    if (child.nodeType === 1) {
      const transformed = transformElement(child);
      if (transformed) {
        transformed.properties.LayoutOrder = String(rootChildren.length);
        rootChildren.push(transformed);
      }
    }
  }
  applyFlowLayoutToChildren(rootChildren);
  assignAutoZIndexForPositionedChildren(rootChildren, null);

  let rootNode;
  if (rootChildren.length === 0) {
    rootNode = {
      className: "Frame",
      varName: "Root",
      properties: {
        Name: '"Root"',
        Size: "UDim2.new(1, 0, 1, 0)",
        BackgroundTransparency: "1",
        BorderSizePixel: "0",
      },
      children: [],
    };
  } else if (rootChildren.length === 1) {
    rootNode = rootChildren[0];
  } else {
    rootNode = {
      className: "Frame",
      varName: "Root",
      properties: {
        Name: '"Root"',
        Size: "UDim2.new(1, 0, 1, 0)",
        BackgroundTransparency: "1",
        BorderSizePixel: "0",
      },
      children: rootChildren,
    };
  }

  return generateLuau(rootNode, compileOptions);
}

module.exports = { compile, compileWithImageUpload };
