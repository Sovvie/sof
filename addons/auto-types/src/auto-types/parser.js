"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const crypto = require("crypto");

const KNOWN_NAME_SUFFIXES = [".server", ".client", ".local", ".legacy", ".plugin"];

// Factory-style fluent returns we can infer the module table from.
const FLUENT_FACTORY_METHOD_NAMES = [
  "from",
  "new",
  "wrap",
  "create",
  "of",
  "with",
  "build",
  "make",
  "register",
  "install",
];

function hashString(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function getBlockDepthEvents(source, parserContext) {
  const context = parserContext || {};
  const cache = context.__blockDepthEventsCache instanceof Map
    ? context.__blockDepthEventsCache
    : null;

  if (!cache) {
    if (context && typeof context === "object") {
      context.__blockDepthEventsCache = new Map();
      const freshCache = context.__blockDepthEventsCache;
      if (freshCache.has(source)) {
        return freshCache.get(source);
      }
      const computed = createBlockDepthEvents(source);
      freshCache.set(source, computed);
      return computed;
    }
    return createBlockDepthEvents(source);
  }

  if (cache.has(source)) {
    return cache.get(source);
  }

  const events = createBlockDepthEvents(source);
  cache.set(source, events);
  return events;
}

function toPascalCase(value) {
  const parts = String(value)
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return "Module";
  }

  let output = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  if (!/^[A-Za-z_]/.test(output)) {
    output = `M${output}`;
  }

  return output;
}

function stripKnownSuffixes(name) {
  let output = name;
  let changed = true;

  while (changed) {
    changed = false;
    for (const suffix of KNOWN_NAME_SUFFIXES) {
      if (output.toLowerCase().endsWith(suffix)) {
        output = output.slice(0, -suffix.length);
        changed = true;
      }
    }
  }

  return output;
}

function deriveModuleTypeName(filePath) {
  const parsed = path.parse(filePath);
  let baseName = parsed.name;

  if (baseName.toLowerCase() === "init") {
    baseName = path.basename(parsed.dir);
  }

  baseName = stripKnownSuffixes(baseName);
  return toPascalCase(baseName);
}

function detectModuleTableName(source, parserContext) {
  const blockDepthEvents = getBlockDepthEvents(source, parserContext);
  let eventIndex = 0;
  let currentDepth = 0;

  // Pass 1: top-level `return Identifier` or `return Identifier :: Type`.
  let lastReturnName = null;
  const returnIdentifierPattern = /^\s*return\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*::\s*[^\n]+)?\s*(?:--.*)?$/gm;
  let returnMatch = returnIdentifierPattern.exec(source);
  while (returnMatch) {
    while (eventIndex < blockDepthEvents.length && blockDepthEvents[eventIndex].index < returnMatch.index) {
      currentDepth += blockDepthEvents[eventIndex].delta;
      if (currentDepth < 0) {
        currentDepth = 0;
      }
      eventIndex += 1;
    }

    if (currentDepth === 0) {
      lastReturnName = returnMatch[1];
    }

    returnMatch = returnIdentifierPattern.exec(source);
  }

  if (lastReturnName) {
    return lastReturnName;
  }

  // Collect all top-level return offsets for subsequent shape-specific scans.
  const returnOffsets = [];
  eventIndex = 0;
  currentDepth = 0;
  const returnOffsetPattern = /^\s*return\b/gm;
  let returnOffsetMatch = returnOffsetPattern.exec(source);
  while (returnOffsetMatch) {
    while (eventIndex < blockDepthEvents.length && blockDepthEvents[eventIndex].index < returnOffsetMatch.index) {
      currentDepth += blockDepthEvents[eventIndex].delta;
      if (currentDepth < 0) {
        currentDepth = 0;
      }
      eventIndex += 1;
    }

    if (currentDepth === 0) {
      returnOffsets.push(returnOffsetMatch.index);
    }

    returnOffsetMatch = returnOffsetPattern.exec(source);
  }

  // Pass 2: fluent factory builders, e.g.
  //   return Game.client.from(module):onInit(...):onStart(...)
  //   return Framework.new(module):configure():build()
  //   return setmetatable(module, metatable)
  //   return table.freeze(module)
  const fluentFactoryPattern = new RegExp(
    `\\.(?:${FLUENT_FACTORY_METHOD_NAMES.join("|")})\\(\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*[),]`
  );
  const setmetatablePattern = /\bsetmetatable\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/;
  const tableFreezePattern = /\btable\.freeze\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/;

  for (let index = returnOffsets.length - 1; index >= 0; index -= 1) {
    const startOffset = returnOffsets[index];
    const snippet = source.slice(startOffset, Math.min(source.length, startOffset + 2048));

    const fluentMatch = fluentFactoryPattern.exec(snippet);
    if (fluentMatch) {
      return fluentMatch[1];
    }

    const setmetatableMatch = setmetatablePattern.exec(snippet);
    if (setmetatableMatch) {
      return setmetatableMatch[1];
    }

    const tableFreezeMatch = tableFreezePattern.exec(snippet);
    if (tableFreezeMatch) {
      return tableFreezeMatch[1];
    }
  }

  // Pass 3: first plausible local-table declaration at any depth.
  const localPattern = /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:\{|\w+\(|table\.freeze\(\{|setmetatable\()/gm;
  const localMatch = localPattern.exec(source);
  if (localMatch) {
    return localMatch[1];
  }

  return null;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeReturnType(text) {
  if (!text) {
    return "";
  }

  return normalizeWhitespace(text.replace(/\s*--.*$/g, "").trim());
}

function extractTypeReferenceBaseName(typeText) {
  const normalized = normalizeReturnType(typeText);
  if (!normalized) {
    return "";
  }

  let candidate = normalized;
  while (candidate.startsWith("(") && candidate.endsWith(")")) {
    let depth = 0;
    let wrapsWholeExpression = true;
    for (let index = 0; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0 && index < candidate.length - 1) {
          wrapsWholeExpression = false;
          break;
        }
      }
    }

    if (!wrapsWholeExpression || depth !== 0) {
      break;
    }

    candidate = normalizeReturnType(candidate.slice(1, -1));
  }

  candidate = candidate.replace(/\?$/, "").trim();
  const match = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[\s\S]+>)?$/.exec(
    candidate
  );
  if (!match) {
    return "";
  }

  return match[1];
}

function needsParenthesesForEmbeddedType(typeText) {
  const normalizedType = normalizeReturnType(typeText);
  if (!normalizedType) {
    return false;
  }

  if (normalizedType.startsWith("(") && normalizedType.endsWith(")")) {
    return false;
  }

  return (
    normalizedType.includes("|") ||
    normalizedType.includes("&") ||
    normalizedType.includes("->")
  );
}

function embedTypeExpression(typeText, isWholeExpression) {
  const normalizedType = normalizeReturnType(typeText);
  if (!normalizedType) {
    return "";
  }

  if (isWholeExpression || !needsParenthesesForEmbeddedType(normalizedType)) {
    return normalizedType;
  }

  return `(${normalizedType})`;
}

function parseTypeParameterList(typeParamsText) {
  const normalizedParamsText = normalizeWhitespace(typeParamsText || "");
  if (!normalizedParamsText) {
    return [];
  }

  return splitTopLevel(normalizedParamsText, ",")
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean)
    .map((segment) => {
      const parameterMatch = /^([A-Za-z_][A-Za-z0-9_]*)(\.\.\.)?/.exec(segment);
      if (!parameterMatch) {
        return null;
      }

      return {
        name: parameterMatch[1],
        isPack: parameterMatch[2] === "...",
      };
    })
    .filter(Boolean);
}

function readExportedTypeExpression(source, startIndex) {
  let cursor = startIndex;
  while (cursor < source.length && /\s/.test(source[cursor])) {
    cursor += 1;
  }

  const expressionStart = cursor;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  let quote = null;

  for (; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    const next = source[cursor + 1];

    if (quote) {
      if (char === "\\" && next !== undefined) {
        cursor += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(parenDepth - 1, 0);
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(braceDepth - 1, 0);
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(bracketDepth - 1, 0);
      continue;
    }
    if (char === "<") {
      angleDepth += 1;
      continue;
    }
    if (char === ">") {
      angleDepth = Math.max(angleDepth - 1, 0);
      continue;
    }

    if (char === "\n" || char === "\r") {
      if (parenDepth !== 0 || braceDepth !== 0 || bracketDepth !== 0 || angleDepth !== 0) {
        continue;
      }

      let lookahead = cursor + 1;
      while (lookahead < source.length && (source[lookahead] === " " || source[lookahead] === "\t")) {
        lookahead += 1;
      }

      if (source[lookahead] === "|" || source[lookahead] === "&") {
        continue;
      }

      break;
    }
  }

  return {
    expression: normalizeReturnType(source.slice(expressionStart, cursor)),
    endIndex: cursor,
  };
}

function collectExportedTypeDefinitions(source) {
  const output = new Map();
  const exportTypePattern =
    /\bexport\s+type\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*<([^>\n]+)>)?\s*=/g;

  let match = exportTypePattern.exec(source);
  while (match) {
    const typeName = match[1];
    const typeParamsText = match[2] || "";
    const expressionInfo = readExportedTypeExpression(source, exportTypePattern.lastIndex);
    if (expressionInfo.expression) {
      output.set(typeName, {
        name: typeName,
        params: parseTypeParameterList(typeParamsText),
        expression: expressionInfo.expression,
      });
    }
    exportTypePattern.lastIndex = expressionInfo.endIndex;
    match = exportTypePattern.exec(source);
  }

  return output;
}

function parseTypeArgumentList(typeArgsText) {
  const normalizedTypeArgsText = normalizeWhitespace(typeArgsText || "");
  if (!normalizedTypeArgsText) {
    return [];
  }

  return splitTopLevel(normalizedTypeArgsText, ",")
    .map((segment) => normalizeReturnType(segment))
    .filter(Boolean);
}

function applyTypeParameterSubstitutions(expression, typeDefinition, typeArguments) {
  const definition = typeDefinition || {};
  const params = Array.isArray(definition.params) ? definition.params : [];
  if (params.length === 0) {
    return normalizeReturnType(expression);
  }

  let output = normalizeReturnType(expression || "");
  for (let index = 0; index < params.length; index += 1) {
    const parameter = params[index];
    if (!parameter || !parameter.name) {
      continue;
    }

    const replacement = normalizeReturnType(typeArguments[index] || "any");
    if (!replacement) {
      continue;
    }

    if (parameter.isPack) {
      output = output.replace(
        new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(parameter.name)}\\.\\.\\.(?=$|[^A-Za-z0-9_])`, "g"),
        (fullMatch, prefix) => `${prefix}${replacement}`
      );
      continue;
    }

    output = output.replace(
      new RegExp(`\\b${escapeRegExp(parameter.name)}\\b`, "g"),
      embedTypeExpression(replacement, false)
    );
  }

  return normalizeReturnType(
    output
      .replace(/\bany\s*<[^>\n]+>/g, "any")
      .replace(/\.{4,}/g, "...")
  );
}

function isPrimitiveTypeName(typeName) {
  return (
    typeName === "any" ||
    typeName === "boolean" ||
    typeName === "buffer" ||
    typeName === "false" ||
    typeName === "never" ||
    typeName === "nil" ||
    typeName === "number" ||
    typeName === "string" ||
    typeName === "thread" ||
    typeName === "true" ||
    typeName === "unknown"
  );
}

function expandLocalTypeReferences(typeText, typeDefinitionMap, options) {
  const normalizedTypeText = normalizeReturnType(typeText);
  if (!normalizedTypeText || !(typeDefinitionMap instanceof Map) || typeDefinitionMap.size === 0) {
    return normalizedTypeText;
  }

  const settings = options || {};
  const skipAlias = settings.skipAlias || "";
  const maxPasses = Math.max(typeDefinitionMap.size + 2, 3);
  let output = normalizedTypeText;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;

    output = output.replace(
      /(^|[^A-Za-z0-9_\.])([A-Za-z_][A-Za-z0-9_]*)(?:<([^>\n]+)>)?/g,
      (match, prefix, typeName, typeArgsText, offset, fullText) => {
        if (!typeName || isPrimitiveTypeName(typeName) || typeName === skipAlias) {
          return match;
        }

        const typeDefinition = typeDefinitionMap.get(typeName);
        if (!typeDefinition) {
          return match;
        }

        const typeArguments = parseTypeArgumentList(typeArgsText || "");
        if (typeDefinition.params.length > 0 && typeArguments.length === 0) {
          return match;
        }

        const selfReferencePattern = new RegExp(
          `\\b${escapeRegExp(typeName)}(?:\\s*<[^>]+>)?\\b`,
          "g"
        );
        const safeTypeDefinition = selfReferencePattern.test(typeDefinition.expression)
          ? {
              ...typeDefinition,
              expression: normalizeReturnType(typeDefinition.expression.replace(selfReferencePattern, "any")),
            }
          : typeDefinition;

        const instantiatedType = applyTypeParameterSubstitutions(
          safeTypeDefinition.expression,
          safeTypeDefinition,
          typeArguments
        );
        if (!instantiatedType) {
          return match;
        }

        const fullReferenceText = String(typeArgsText || "").trim()
          ? `${typeName}<${typeArgsText}>`
          : typeName;
        const isWholeExpression = normalizeWhitespace(fullText) === normalizeWhitespace(fullReferenceText);
        const replacement = embedTypeExpression(instantiatedType, isWholeExpression);
        const outputText = `${prefix}${replacement}`;
        if (outputText !== match) {
          changed = true;
        }
        return outputText;
      }
    );

    if (!changed) {
      break;
    }
  }

  return normalizeReturnType(output);
}

function collectGameServiceAliases(source) {
  const output = new Map();
  const getServicePattern =
    /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*game:GetService\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)\s*(?:--.*)?$/gm;

  let match = getServicePattern.exec(source);
  while (match) {
    output.set(match[1], match[2]);
    match = getServicePattern.exec(source);
  }

  return output;
}

function resolveDatamodelRequirePath(requireExpression, source, context) {
  const normalizedExpression = normalizeWhitespace(requireExpression || "");
  const parserContext = context || {};
  const datamodelPathMap = parserContext.datamodelPathMap instanceof Map ? parserContext.datamodelPathMap : null;
  if (!datamodelPathMap || datamodelPathMap.size === 0) {
    return null;
  }

  const expressionMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_\.]*))?$/.exec(
    normalizedExpression
  );
  if (!expressionMatch) {
    return null;
  }

  const rootIdentifier = expressionMatch[1];
  const suffix = expressionMatch[2] ? expressionMatch[2].split(".").filter(Boolean) : [];
  const serviceAliases = collectGameServiceAliases(source);
  const rootServiceName = serviceAliases.get(rootIdentifier);
  if (!rootServiceName) {
    return null;
  }

  const datamodelPath = [rootServiceName, ...suffix].join("/");
  return datamodelPathMap.get(datamodelPath) || null;
}

function resolveScriptRequirePath(filePath, requireExpression) {
  const normalizedExpression = normalizeWhitespace(requireExpression || "");
  if (!/^script(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(normalizedExpression)) {
    return null;
  }

  const segments = normalizedExpression.split(".");
  let resolvedPath = path.dirname(path.resolve(filePath));

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "Parent") {
      resolvedPath = path.dirname(resolvedPath);
      continue;
    }
    resolvedPath = path.join(resolvedPath, segment);
  }

  const candidates = resolvedPath.toLowerCase().endsWith(".luau")
    ? [resolvedPath]
    : [`${resolvedPath}.luau`, path.join(resolvedPath, "init.luau")];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.resolve(candidate);
    }
  }

  return null;
}

function resolveRequirePath(requireExpression, source, filePath, context) {
  const fromScript = resolveScriptRequirePath(filePath, requireExpression);
  if (fromScript) {
    return fromScript;
  }

  const fromDatamodel = resolveDatamodelRequirePath(requireExpression, source, context);
  if (fromDatamodel) {
    return path.resolve(fromDatamodel);
  }

  return null;
}

function collectRequireAliasPathMap(source, filePath, context) {
  const output = new Map();
  const requirePattern =
    /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\(([^)\n\r]+)\)\s*(?:--.*)?$/gm;

  let match = requirePattern.exec(source);
  while (match) {
    const alias = match[1];
    const requireExpression = match[2];
    const resolvedModulePath = resolveRequirePath(requireExpression, source, filePath, context);
    if (resolvedModulePath) {
      output.set(alias, resolvedModulePath);
    }
    match = requirePattern.exec(source);
  }

  return output;
}

function expandTypeAliases(typeText, typeAliasMap, options) {
  const normalizedTypeText = normalizeReturnType(typeText);
  if (!normalizedTypeText || !(typeAliasMap instanceof Map) || typeAliasMap.size === 0) {
    return normalizedTypeText;
  }

  const skipAlias = options && options.skipAlias ? options.skipAlias : "";
  let output = normalizedTypeText;
  const aliases = Array.from(typeAliasMap.entries())
    .filter(([aliasName, aliasType]) => aliasName && aliasType && aliasName !== skipAlias)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [aliasName, aliasType] of aliases) {
    const aliasPattern = new RegExp(
      `(^|[^A-Za-z0-9_\\.])(${escapeRegExp(aliasName)})(?=$|[^A-Za-z0-9_])`,
      "g"
    );
    output = output.replace(
      aliasPattern,
      (fullMatch, prefix, matchedAlias, _offset, fullText) => {
        const isWholeExpression = normalizeWhitespace(fullText) === matchedAlias;
        const replacement = embedTypeExpression(aliasType, isWholeExpression);
        return `${prefix}${replacement}`;
      }
    );
  }

  return normalizeReturnType(output);
}

function buildLanguageServerArgs(parserContext, tempFilePath) {
  const args = ["analyze", "--annotate"];
  if (parserContext.sourcemapPath) {
    args.push("--sourcemap", parserContext.sourcemapPath);
  }
  if (parserContext.luauDefinitionsPath) {
    args.push("--definitions", `@roblox=${parserContext.luauDefinitionsPath}`);
  }
  args.push(tempFilePath);
  return args;
}

function languageServerCacheKey(filePath, probeVariableName, expression) {
  return `${path.resolve(filePath)}::${probeVariableName}::${normalizeWhitespace(expression)}`;
}

function ensureLanguageServerCache(parserContext) {
  if (!parserContext.__languageServerTypeCache) {
    parserContext.__languageServerTypeCache = new Map();
  }
  return parserContext.__languageServerTypeCache;
}

function parseAnnotatedProbes(output) {
  const inferredTypes = new Map();
  if (!output) {
    return inferredTypes;
  }

  const probePattern = /local\s+(__SOF_PROBE_(?:LSP|MODULE|BATCH)_[A-Za-z0-9_]+)\s*:\s*([^=\n]+?)\s*=/g;
  let match = probePattern.exec(output);
  while (match) {
    inferredTypes.set(match[1], normalizeReturnType(match[2]));
    match = probePattern.exec(output);
  }
  return inferredTypes;
}

function inferExpressionTypeWithLanguageServer(expression, inferenceContext) {
  const context = inferenceContext || {};
  const parserContext = context.parserContext || {};
  const luauLspBinaryPath = parserContext.luauLspBinaryPath;
  const sourceText = context.sourceText || "";
  const filePath = context.filePath || "";
  const probeVariableName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(context.probeVariableName || "")
    ? context.probeVariableName
    : "__SOF_LSP_PROBE";
  if (!luauLspBinaryPath || !sourceText || !filePath) {
    return "";
  }

  const cache = ensureLanguageServerCache(parserContext);
  const cacheKey = languageServerCacheKey(filePath, probeVariableName, expression);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) || "";
  }

  // Fall back to a single-expression spawn only when batch prewarm missed this cast
  // (e.g. inference re-entered the LSP for a dynamically constructed expression).
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sof-lsp-probe-"));
  const tempFilePath = path.join(tempDirectory, "probe.luau");
  // Normalize the variable prefix so parseAnnotatedProbes picks it up.
  const normalizedProbeName = `__SOF_PROBE_LSP_${hashString(probeVariableName + "::" + expression).slice(0, 12)}`;
  const probeSource = `${sourceText}\n\nlocal ${normalizedProbeName} = ${expression}\n`;
  fs.writeFileSync(tempFilePath, probeSource, "utf8");

  let inferredType = "";
  try {
    const result = childProcess.spawnSync(luauLspBinaryPath, buildLanguageServerArgs(parserContext, tempFilePath), {
      cwd: parserContext.configDirectory || path.dirname(path.resolve(filePath)),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const probes = parseAnnotatedProbes(output);
    if (probes.has(normalizedProbeName)) {
      inferredType = probes.get(normalizedProbeName);
    }
  } catch (_err) {
    inferredType = "";
  } finally {
    try {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    } catch (_err) {
      // Ignore cleanup failures for temporary probe files.
    }
  }

  cache.set(cacheKey, inferredType || "");
  return inferredType;
}

function collectLanguageServerProbeExpressions(source, moduleTableName) {
  const expressions = new Map();

  const addProbe = (probeVariableName, rawExpression) => {
    const expression = normalizeWhitespace((rawExpression || "").replace(/\s*--.*$/g, "").trim());
    if (!expression) {
      return;
    }
    if (!expression.includes("::") && probeVariableName !== "__SOF_MODULE_PROBE") {
      return;
    }
    const key = `${probeVariableName}::${expression}`;
    if (expressions.has(key)) {
      return;
    }
    expressions.set(key, { probeVariableName, expression });
  };

  const localPattern = /(^|\n)\s*local\s+[A-Za-z_][A-Za-z0-9_]*\s*(?::\s*[^=\n\r]+)?\s*=\s*([^\n\r]+)/g;
  let localMatch = localPattern.exec(source);
  while (localMatch) {
    addProbe("__SOF_LSP_PROBE", localMatch[2]);
    localMatch = localPattern.exec(source);
  }

  const tableAssignPattern = /(^|\n)\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\s*=\s*([^\n\r]+)/g;
  let tableMatch = tableAssignPattern.exec(source);
  while (tableMatch) {
    addProbe("__SOF_LSP_PROBE", tableMatch[2]);
    tableMatch = tableAssignPattern.exec(source);
  }

  if (moduleTableName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleTableName)) {
    addProbe("__SOF_MODULE_PROBE", moduleTableName);
  }

  return Array.from(expressions.values());
}

function prewarmLanguageServerCache(source, filePath, parserContext, moduleTableName) {
  const context = parserContext || {};
  const luauLspBinaryPath = context.luauLspBinaryPath;
  if (!luauLspBinaryPath || !source || !filePath) {
    return;
  }

  const probes = collectLanguageServerProbeExpressions(source, moduleTableName);
  if (probes.length === 0) {
    return;
  }

  const cache = ensureLanguageServerCache(context);
  const pendingProbes = [];
  const probeNameByKey = new Map();

  for (const probe of probes) {
    const cacheKey = languageServerCacheKey(filePath, probe.probeVariableName, probe.expression);
    if (cache.has(cacheKey)) {
      continue;
    }
    const probeName = `__SOF_PROBE_BATCH_${hashString(cacheKey).slice(0, 14)}`;
    pendingProbes.push({ ...probe, cacheKey, probeName });
    probeNameByKey.set(probeName, cacheKey);
  }

  if (pendingProbes.length === 0) {
    return;
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sof-lsp-batch-"));
  const tempFilePath = path.join(tempDirectory, "probe.luau");
  const declarations = pendingProbes
    .map((probe) => `local ${probe.probeName} = ${probe.expression}`)
    .join("\n");
  const probeSource = `${source}\n\n-- SOF auto-types batch probes\n${declarations}\n`;
  fs.writeFileSync(tempFilePath, probeSource, "utf8");

  try {
    const result = childProcess.spawnSync(
      luauLspBinaryPath,
      buildLanguageServerArgs(context, tempFilePath),
      {
        cwd: context.configDirectory || path.dirname(path.resolve(filePath)),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const probes = parseAnnotatedProbes(output);
    for (const probe of pendingProbes) {
      const inferredType = probes.get(probe.probeName) || "";
      cache.set(probe.cacheKey, inferredType);
    }
  } catch (_err) {
    // Leave cache entries unset so the fallback per-probe path can attempt them later.
  } finally {
    try {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    } catch (_err) {
      // Ignore cleanup failures for temporary probe files.
    }
  }
}

async function prewarmLanguageServerCacheAsync(source, filePath, parserContext, moduleTableName) {
  return prewarmLanguageServerCacheMulti(
    [{ source, filePath, moduleTableName }],
    parserContext
  );
}

async function prewarmLanguageServerCacheMulti(files, parserContext) {
  const context = parserContext || {};
  const luauLspBinaryPath = context.luauLspBinaryPath;
  if (!luauLspBinaryPath || !Array.isArray(files) || files.length === 0) {
    return;
  }

  const cache = ensureLanguageServerCache(context);
  const perFileProbes = [];
  const tempFilesToRemove = [];
  const spawnTargets = [];

  for (const entry of files) {
    if (!entry || !entry.source || !entry.filePath) {
      continue;
    }
    const moduleTableName =
      entry.moduleTableName || detectModuleTableName(entry.source, context);
    const probes = collectLanguageServerProbeExpressions(entry.source, moduleTableName);
    if (probes.length === 0) {
      continue;
    }

    const pendingProbes = [];
    for (const probe of probes) {
      const cacheKey = languageServerCacheKey(entry.filePath, probe.probeVariableName, probe.expression);
      if (cache.has(cacheKey)) {
        continue;
      }
      // Probe names must stay unique across ALL files for the combined spawn.
      const probeName = `__SOF_PROBE_BATCH_${hashString(cacheKey).slice(0, 14)}`;
      pendingProbes.push({ ...probe, cacheKey, probeName });
    }

    if (pendingProbes.length === 0) {
      continue;
    }

    const declarations = pendingProbes
      .map((probe) => `local ${probe.probeName} = ${probe.expression}`)
      .join("\n");
    const probeSource = `${entry.source}\n\n-- SOF auto-types batch probes\n${declarations}\n`;

    // Co-locate next to original so relative `require(script.Parent.*)` stays resolvable.
    const originalDirectory = path.dirname(path.resolve(entry.filePath));
    const probeFileName = `__sof_probe_${hashString(entry.filePath).slice(0, 12)}.luau`;
    const probeFilePath = path.join(originalDirectory, probeFileName);

    try {
      await fs.promises.writeFile(probeFilePath, probeSource, "utf8");
    } catch (_err) {
      continue;
    }

    perFileProbes.push({ filePath: entry.filePath, probeFilePath, pendingProbes });
    tempFilesToRemove.push(probeFilePath);
    spawnTargets.push(probeFilePath);
  }

  if (spawnTargets.length === 0) {
    return;
  }

  const args = ["analyze", "--annotate"];
  if (context.sourcemapPath) {
    args.push("--sourcemap", context.sourcemapPath);
  }
  if (context.luauDefinitionsPath) {
    args.push("--definitions", `@roblox=${context.luauDefinitionsPath}`);
  }
  for (const target of spawnTargets) {
    args.push(target);
  }

  const workingDirectory = context.configDirectory || process.cwd();

  const output = await new Promise((resolve) => {
    try {
      const child = childProcess.spawn(luauLspBinaryPath, args, {
        cwd: workingDirectory,
        windowsHide: true,
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      let settled = false;

      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
      child.on("error", () => settle(""));
      child.on("close", () => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        settle(`${stdout}\n${stderr}`);
      });
    } catch (_err) {
      resolve("");
    }
  });

  const probeResults = parseAnnotatedProbes(output);
  for (const fileEntry of perFileProbes) {
    for (const probe of fileEntry.pendingProbes) {
      const inferredType = probeResults.get(probe.probeName) || "";
      cache.set(probe.cacheKey, inferredType);
    }
  }

  await Promise.all(
    tempFilesToRemove.map((tempPath) =>
      fs.promises.rm(tempPath, { force: true }).catch(() => {})
    )
  );
}

function buildResolvedAliasMapFromDefinitions(typeDefinitionMap) {
  const output = new Map();
  for (const [typeName, definition] of typeDefinitionMap.entries()) {
    if (
      definition &&
      Array.isArray(definition.params) &&
      definition.params.length === 0 &&
      typeof definition.expression === "string"
    ) {
      output.set(typeName, definition.expression);
    }
  }
  return output;
}

function findMatchingGenericClose(text, openIndex) {
  if (typeof text !== "string" || openIndex < 0 || openIndex >= text.length || text[openIndex] !== "<") {
    return -1;
  }

  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "<") {
      depth += 1;
      continue;
    }

    if (char === ">") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function resolveExportedTypeMap(filePath, exportTypeCache, activeFileSet, context) {
  const absoluteFilePath = path.resolve(filePath);
  if (exportTypeCache.has(absoluteFilePath)) {
    return exportTypeCache.get(absoluteFilePath);
  }

  if (activeFileSet.has(absoluteFilePath)) {
    return new Map();
  }

  activeFileSet.add(absoluteFilePath);

  let source = "";
  try {
    source = fs.readFileSync(absoluteFilePath, "utf8");
  } catch (_err) {
    activeFileSet.delete(absoluteFilePath);
    const empty = new Map();
    exportTypeCache.set(absoluteFilePath, empty);
    return empty;
  }

  const rawExportedTypes = collectExportedTypeDefinitions(source);
  const requireAliasPathMap = collectRequireAliasPathMap(source, absoluteFilePath, context);
  const resolvedTypeDefinitions = new Map();

  for (const [typeName, typeDefinition] of rawExportedTypes.entries()) {
    const expandedTypeExpression = expandNamespacedTypeReferences(
      typeDefinition.expression,
      requireAliasPathMap,
      exportTypeCache,
      activeFileSet,
      context
    );
    resolvedTypeDefinitions.set(typeName, {
      ...typeDefinition,
      expression: expandedTypeExpression || typeDefinition.expression,
    });
  }

  const maxPasses = Math.max(resolvedTypeDefinitions.size + 1, 1);
  let changed = true;
  let pass = 0;
  while (changed && pass < maxPasses) {
    changed = false;
    pass += 1;
    const resolvedAliasMap = buildResolvedAliasMapFromDefinitions(resolvedTypeDefinitions);

    for (const [typeName, typeDefinition] of Array.from(resolvedTypeDefinitions.entries())) {
      let expandedExpression = expandLocalTypeReferences(typeDefinition.expression, resolvedTypeDefinitions, {
        skipAlias: typeName,
      });
      expandedExpression = expandTypeAliases(expandedExpression, resolvedAliasMap, {
        skipAlias: typeName,
      });

      if (expandedExpression && expandedExpression !== typeDefinition.expression) {
        resolvedTypeDefinitions.set(typeName, {
          ...typeDefinition,
          expression: expandedExpression,
        });
        changed = true;
      }
    }
  }

  activeFileSet.delete(absoluteFilePath);
  exportTypeCache.set(absoluteFilePath, resolvedTypeDefinitions);
  return resolvedTypeDefinitions;
}

function expandNamespacedTypeReferences(
  typeText,
  requireAliasPathMap,
  exportTypeCache,
  activeFileSet,
  context
) {
  const normalizedTypeText = normalizeReturnType(typeText);
  if (!normalizedTypeText || requireAliasPathMap.size === 0) {
    return normalizedTypeText;
  }

  let output = "";
  let cursor = 0;
  const referencePattern = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let match = referencePattern.exec(normalizedTypeText);

  while (match) {
    const [referenceText, namespaceIdentifier, typeName] = match;
    const referenceStart = match.index;
    let referenceEnd = referenceStart + referenceText.length;
    let typeArgs = [];

    if (normalizedTypeText[referenceEnd] === "<") {
      const genericClose = findMatchingGenericClose(normalizedTypeText, referenceEnd);
      if (genericClose > referenceEnd) {
        const typeArgsText = normalizedTypeText.slice(referenceEnd + 1, genericClose);
        typeArgs = parseTypeArgumentList(typeArgsText).map((arg) =>
          expandNamespacedTypeReferences(
            arg,
            requireAliasPathMap,
            exportTypeCache,
            activeFileSet,
            context
          )
        );
        referenceEnd = genericClose + 1;
      }
    }

    output += normalizedTypeText.slice(cursor, referenceStart);
    const fullReferenceText = normalizedTypeText.slice(referenceStart, referenceEnd);

    const requiredModulePath = requireAliasPathMap.get(namespaceIdentifier);
    if (!requiredModulePath) {
      output += fullReferenceText;
      cursor = referenceEnd;
      match = referencePattern.exec(normalizedTypeText);
      continue;
    }

    const exportedTypeMap = resolveExportedTypeMap(
      requiredModulePath,
      exportTypeCache,
      activeFileSet,
      context
    );
    const typeDefinition = exportedTypeMap.get(typeName);
    if (!typeDefinition || !typeDefinition.expression) {
      output += fullReferenceText;
      cursor = referenceEnd;
      match = referencePattern.exec(normalizedTypeText);
      continue;
    }

    if (typeDefinition.params.length > 0 && typeArgs.length === 0) {
      output += fullReferenceText;
      cursor = referenceEnd;
      match = referencePattern.exec(normalizedTypeText);
      continue;
    }

    const substitutedType = applyTypeParameterSubstitutions(
      typeDefinition.expression,
      typeDefinition,
      typeArgs
    );
    const expandedType = expandNamespacedTypeReferences(
      substitutedType,
      requireAliasPathMap,
      exportTypeCache,
      activeFileSet,
      context
    );
    const isWholeExpression = normalizeWhitespace(normalizedTypeText) === normalizeWhitespace(fullReferenceText);
    output += embedTypeExpression(expandedType || substitutedType, isWholeExpression);
    cursor = referenceEnd;
    match = referencePattern.exec(normalizedTypeText);
  }

  output += normalizedTypeText.slice(cursor);
  return normalizeReturnType(output);
}

function getSharedExportTypeCache(context) {
  const ctx = context || {};
  if (!(ctx.__exportTypeCache instanceof Map)) {
    ctx.__exportTypeCache = new Map();
  }
  return ctx.__exportTypeCache;
}

function collectResolvedExportedTypeAliases(source, filePath, context) {
  const rawExportedTypes = collectExportedTypeDefinitions(source);
  if (rawExportedTypes.size === 0) {
    return new Map();
  }

  const requireAliasPathMap = collectRequireAliasPathMap(source, filePath, context);
  const exportTypeCache = getSharedExportTypeCache(context);
  const activeFileSet = new Set([path.resolve(filePath)]);
  const resolvedTypeDefinitions = new Map();

  for (const [typeName, typeDefinition] of rawExportedTypes.entries()) {
    const expandedTypeExpression = expandNamespacedTypeReferences(
      typeDefinition.expression,
      requireAliasPathMap,
      exportTypeCache,
      activeFileSet,
      context
    );
    resolvedTypeDefinitions.set(typeName, {
      ...typeDefinition,
      expression: expandedTypeExpression || typeDefinition.expression,
    });
  }

  const maxPasses = Math.max(resolvedTypeDefinitions.size + 1, 1);
  let changed = true;
  let pass = 0;
  while (changed && pass < maxPasses) {
    changed = false;
    pass += 1;

    for (const [typeName, typeDefinition] of Array.from(resolvedTypeDefinitions.entries())) {
      const expanded = expandLocalTypeReferences(typeDefinition.expression, resolvedTypeDefinitions, {
        skipAlias: typeName,
      });
      if (expanded && expanded !== typeDefinition.expression) {
        resolvedTypeDefinitions.set(typeName, {
          ...typeDefinition,
          expression: expanded,
        });
        changed = true;
      }
    }
  }

  const resolvedAliases = new Map();
  for (const [typeName, typeDefinition] of resolvedTypeDefinitions.entries()) {
    if (!typeDefinition || (typeDefinition.params && typeDefinition.params.length > 0)) {
      continue;
    }
    resolvedAliases.set(typeName, typeDefinition.expression);
  }

  return resolvedAliases;
}

function collectExportedNamespaceTypeAliases(source, resolvedExportedTypeAliases) {
  const output = new Map();
  const exportAliasPattern =
    /^\s*export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_.]*\s*(?:--.*)?$/gm;
  const localTypeAliases = resolvedExportedTypeAliases || new Map();

  let match = exportAliasPattern.exec(source);
  while (match) {
    const aliasTypeName = match[1];
    const namespaceIdentifier = match[2];
    const resolvedType = localTypeAliases.get(aliasTypeName) || aliasTypeName;
    if (!output.has(namespaceIdentifier)) {
      output.set(namespaceIdentifier, resolvedType);
    }
    match = exportAliasPattern.exec(source);
  }

  return output;
}

function parseSignatureFromOpenParen(source, openParenIndex) {
  let depth = 0;
  const paramsStart = openParenIndex + 1;

  for (let cursor = openParenIndex; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        const params = normalizeWhitespace(source.slice(paramsStart, cursor));
        let next = cursor + 1;

        while (next < source.length && /\s/.test(source[next])) {
          next += 1;
        }

        let returnType = "";
        if (source[next] === ":") {
          next += 1;
          const returnStart = next;
          while (next < source.length && source[next] !== "\n" && source[next] !== "\r") {
            next += 1;
          }
          returnType = normalizeReturnType(source.slice(returnStart, next));
        }

        return { params, returnType, endIndex: next };
      }
    }
  }

  return null;
}

function addMember(memberMap, memberName, functionType, excludePrivate) {
  if (excludePrivate && memberName.startsWith("_")) {
    return;
  }

  if (!memberMap.has(memberName)) {
    memberMap.set(memberName, functionType);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let start = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  let quote = null;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (quote) {
      if (char === quote && text[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(parenDepth - 1, 0);
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(braceDepth - 1, 0);
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(bracketDepth - 1, 0);
      continue;
    }
    if (char === "<") {
      angleDepth += 1;
      continue;
    }
    if (char === ">") {
      angleDepth = Math.max(angleDepth - 1, 0);
      continue;
    }

    if (
      char === delimiter &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0
    ) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

function normalizeParamSegment(segment) {
  const param = normalizeWhitespace(segment);
  if (!param) {
    return "";
  }

  if (param.startsWith("...")) {
    if (param === "...") {
      return "...: any";
    }

    if (/^\.\.\.\s*:/.test(param) || /^\.\.\.[A-Za-z_]/.test(param)) {
      return param;
    }

    return "...: any";
  }

  if (param.includes(":")) {
    return param;
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(param)) {
    return `${param}: any`;
  }

  return `${param}: any`;
}

function normalizeParams(params) {
  const normalized = normalizeWhitespace(params || "");
  if (!normalized) {
    return "";
  }

  return splitTopLevel(normalized, ",")
    .map((segment) => normalizeParamSegment(segment))
    .filter(Boolean)
    .join(", ");
}

function inferPropertyTypeFromExpression(expression, moduleTableName, inferenceContext) {
  const context = inferenceContext || {};
  const propertyTypeMap = context.propertyTypeMap || new Map();
  const localVariableTypeMap = context.localVariableTypeMap || new Map();
  const namespaceTypeAliasMap = context.namespaceTypeAliasMap || new Map();
  const typeAliasMap = context.typeAliasMap || new Map();
  const requireAliasPathMap = context.requireAliasPathMap || new Map();
  const exportTypeCache = context.exportTypeCache || new Map();
  const activeFileSet = context.activeFileSet || new Set();
  const parserContext = context.parserContext || {};
  const metaOutput = context.metaOutput || null;
  const cleaned = normalizeWhitespace((expression || "").replace(/\s*--.*$/g, "").trim());
  if (!cleaned) {
    return "";
  }

  const castOperatorIndex = cleaned.lastIndexOf("::");
  if (castOperatorIndex >= 0) {
    const assertedType = normalizeReturnType(cleaned.slice(castOperatorIndex + 2));
    if (assertedType) {
      const sourceTypeBaseName = extractTypeReferenceBaseName(assertedType);
      if (metaOutput && sourceTypeBaseName) {
        metaOutput.sourceTypeBaseName = sourceTypeBaseName;
      }

      const lspInferredType = inferExpressionTypeWithLanguageServer(cleaned, context);
      let expandedType = expandTypeAliases(assertedType, typeAliasMap);
      expandedType = expandNamespacedTypeReferences(
        expandedType,
        requireAliasPathMap,
        exportTypeCache,
        activeFileSet,
        parserContext
      );
      if (lspInferredType && lspInferredType !== "any") {
        const expandedLspType = expandNamespacedTypeReferences(
          expandTypeAliases(lspInferredType, typeAliasMap),
          requireAliasPathMap,
          exportTypeCache,
          activeFileSet,
          parserContext
        );
        return expandedLspType || expandedType;
      }

      return expandedType;
    }
  }

  if (/^function\b/.test(cleaned)) {
    return "";
  }

  if (cleaned === "nil") {
    return "nil";
  }

  if (cleaned === "true" || cleaned === "false") {
    return "boolean";
  }

  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) {
    return "number";
  }

  if (
    (cleaned.startsWith("\"") && cleaned.endsWith("\"")) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith("[[") && cleaned.endsWith("]]"))
  ) {
    return "string";
  }

  if (cleaned === "workspace.CurrentCamera") {
    return "Camera";
  }

  if (/\.FieldOfView\b/.test(cleaned)) {
    return "number";
  }

  if (/^math\.(?:abs|acos|asin|atan|atan2|ceil|clamp|cos|deg|exp|floor|fmod|frexp|ldexp|log|max|min|modf|pow|rad|random|round|sign|sin|sqrt|tan)\s*\(/.test(cleaned)) {
    return "number";
  }

  if (/^[^\n]*[+\-*/%][^\n]*$/.test(cleaned)) {
    return "number";
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned)) {
    const localType = localVariableTypeMap.get(cleaned);
    if (localType) {
      return localType;
    }

    const aliasType = typeAliasMap.get(cleaned);
    if (aliasType) {
      return aliasType;
    }
  }

  const callMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(cleaned);
  if (callMatch) {
    const callTarget = callMatch[1];
    const inferredAliasType = namespaceTypeAliasMap.get(callTarget);
    if (inferredAliasType) {
      return inferredAliasType;
    }
  }

  const modulePropertyMatch = moduleTableName
    ? cleaned.match(new RegExp(`^${escapeRegExp(moduleTableName)}\\.([A-Za-z_][A-Za-z0-9_]*)$`))
    : null;
  if (modulePropertyMatch) {
    const referencedType = propertyTypeMap.get(modulePropertyMatch[1]);
    if (referencedType) {
      return referencedType;
    }
  }

  if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
    return "{ [any]: any }";
  }

  return "";
}

function sanitizeSourceForDepthScan(source) {
  let output = "";
  let index = 0;
  let inLineComment = false;
  let stringQuote = null;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        output += char;
      } else {
        output += " ";
      }
      index += 1;
      continue;
    }

    if (stringQuote) {
      if (char === "\\" && next !== undefined) {
        output += " ";
        output += next === "\n" || next === "\r" ? next : " ";
        index += 2;
        continue;
      }

      if (char === stringQuote) {
        stringQuote = null;
      }

      output += char === "\n" || char === "\r" ? char : " ";
      index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      inLineComment = true;
      output += "  ";
      index += 2;
      continue;
    }

    if (char === "\"" || char === "'") {
      stringQuote = char;
      output += " ";
      index += 1;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function createBlockDepthEvents(source) {
  const sanitized = sanitizeSourceForDepthScan(source);
  const tokenPattern = /\b(function|if|for|while|repeat|do|end|until)\b/g;

  const stack = [];
  const events = [];
  let previousToken = "";
  let tokenMatch = tokenPattern.exec(sanitized);

  while (tokenMatch) {
    const token = tokenMatch[1];
    const tokenIndex = tokenMatch.index;

    if (token === "end") {
      if (stack.length > 0) {
        stack.pop();
        events.push({ index: tokenIndex, delta: -1 });
      }

      previousToken = token;
      tokenMatch = tokenPattern.exec(sanitized);
      continue;
    }

    if (token === "until") {
      const repeatIndex = stack.lastIndexOf("repeat");
      if (repeatIndex >= 0) {
        stack.splice(repeatIndex, 1);
        events.push({ index: tokenIndex, delta: -1 });
      }

      previousToken = token;
      tokenMatch = tokenPattern.exec(sanitized);
      continue;
    }

    if (token === "do") {
      if (previousToken === "for" || previousToken === "while") {
        previousToken = token;
        tokenMatch = tokenPattern.exec(sanitized);
        continue;
      }
    }

    stack.push(token);
    events.push({ index: tokenIndex, delta: 1 });
    previousToken = token;
    tokenMatch = tokenPattern.exec(sanitized);
  }

  return events;
}

function resolvePropertyStateType(propertyState) {
  const nonNilTypes = Array.from(propertyState.types).filter((type) => type !== "nil");
  const hasNilType = propertyState.types.has("nil");

  let baseType = "any";
  if (nonNilTypes.length > 0) {
    if (nonNilTypes.includes("any")) {
      baseType = "any";
    } else {
      baseType = nonNilTypes.sort((a, b) => a.localeCompare(b)).join(" | ");
    }
  }

  return {
    type: baseType,
    nilable: hasNilType || !propertyState.hasTopLevelAssignment,
  };
}

function collectTablePropertyMembers(
  source,
  filePath,
  moduleTableName,
  excludePrivate,
  memberMap,
  parserContext
) {
  if (!moduleTableName) {
    return [];
  }

  const propertyTypeMap = new Map();
  const propertyStateMap = new Map();
  const propertyTypeHintMap = new Map();
  const localVariableTypeMap = new Map();
  const requireAliasPathMap = collectRequireAliasPathMap(source, filePath, parserContext);
  const exportTypeCache = getSharedExportTypeCache(parserContext);
  const activeFileSet = new Set([path.resolve(filePath)]);
  const localExportedTypeAliases = collectResolvedExportedTypeAliases(source, filePath, parserContext);
  const namespaceTypeAliasMap = collectExportedNamespaceTypeAliases(
    source,
    localExportedTypeAliases
  );
  const blockDepthEvents = getBlockDepthEvents(source, parserContext);
  let eventIndex = 0;
  let currentDepth = 0;

  const localAssignmentPattern =
    /(^|\n)\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=\n\r]+))?\s*=\s*([^\n\r]+)/g;
  let localAssignmentMatch = localAssignmentPattern.exec(source);
  while (localAssignmentMatch) {
    const localName = localAssignmentMatch[2];
    const annotatedType = normalizeReturnType(localAssignmentMatch[3] || "");
    const expression = localAssignmentMatch[4] || "";

    if (annotatedType) {
      localVariableTypeMap.set(localName, expandTypeAliases(annotatedType, localExportedTypeAliases));
      localAssignmentMatch = localAssignmentPattern.exec(source);
      continue;
    }

    const inferredLocalType = inferPropertyTypeFromExpression(expression, moduleTableName, {
      propertyTypeMap,
      localVariableTypeMap,
      namespaceTypeAliasMap,
      typeAliasMap: localExportedTypeAliases,
      requireAliasPathMap,
      exportTypeCache,
      activeFileSet,
      parserContext,
      sourceText: source,
      filePath,
    });
    if (inferredLocalType) {
      localVariableTypeMap.set(localName, inferredLocalType);
    }

    localAssignmentMatch = localAssignmentPattern.exec(source);
  }

  // Aggregated assignments: bare `module.prop`, cast-wrapped `(module :: Type).prop`,
  // and bracketed string-literal keys `module["prop"]`.
  const escapedTable = escapeRegExp(moduleTableName);
  const combinedAssignmentPattern = new RegExp(
    `(^|\\n)\\s*(?:\\(\\s*${escapedTable}\\s*::[^)]+\\)|${escapedTable})` +
      `(?:\\.([A-Za-z_][A-Za-z0-9_]*)|\\[\\s*(?:"([^"\\n]+)"|'([^'\\n]+)')\\s*\\])` +
      `\\s*=\\s*([^\\n\\r]+)`,
    "g"
  );

  let assignmentMatch = combinedAssignmentPattern.exec(source);
  while (assignmentMatch) {
    while (eventIndex < blockDepthEvents.length && blockDepthEvents[eventIndex].index < assignmentMatch.index) {
      currentDepth += blockDepthEvents[eventIndex].delta;
      if (currentDepth < 0) {
        currentDepth = 0;
      }
      eventIndex += 1;
    }

    const propertyName =
      assignmentMatch[2] || assignmentMatch[3] || assignmentMatch[4] || "";
    const rawExpression = assignmentMatch[5];

    if (
      propertyName &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(propertyName) &&
      !memberMap.has(propertyName) &&
      !(excludePrivate && propertyName.startsWith("_"))
    ) {
      const propertyState = propertyStateMap.get(propertyName) || {
        hasTopLevelAssignment: false,
        types: new Set(),
      };
      const inferenceMeta = {};
      const inferredType = inferPropertyTypeFromExpression(rawExpression, moduleTableName, {
        propertyTypeMap,
        localVariableTypeMap,
        namespaceTypeAliasMap,
        typeAliasMap: localExportedTypeAliases,
        requireAliasPathMap,
        exportTypeCache,
        activeFileSet,
        parserContext,
        sourceText: source,
        filePath,
        metaOutput: inferenceMeta,
      });

      if (currentDepth === 0) {
        propertyState.hasTopLevelAssignment = true;
      }

      if (inferredType) {
        propertyState.types.add(inferredType);
        const resolvedType = resolvePropertyStateType(propertyState);
        propertyTypeMap.set(propertyName, resolvedType.type);
      }

      if (inferenceMeta.sourceTypeBaseName && !propertyTypeHintMap.has(propertyName)) {
        propertyTypeHintMap.set(propertyName, inferenceMeta.sourceTypeBaseName);
      }

      propertyStateMap.set(propertyName, propertyState);
    }

    assignmentMatch = combinedAssignmentPattern.exec(source);
  }

  return Array.from(propertyStateMap.entries())
    .map(([name, propertyState]) => {
      const resolvedType = resolvePropertyStateType(propertyState);
      return {
        name,
        type: resolvedType.type,
        nilable: resolvedType.nilable,
        sourceTypeBaseName: propertyTypeHintMap.get(name) || "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findTopLevelCharacterIndex(text, targetCharacter) {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      if (char === "\\" && next !== undefined) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(parenDepth - 1, 0);
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(braceDepth - 1, 0);
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(bracketDepth - 1, 0);
      continue;
    }
    if (char === "<") {
      angleDepth += 1;
      continue;
    }
    if (char === ">") {
      angleDepth = Math.max(angleDepth - 1, 0);
      continue;
    }

    if (
      char === targetCharacter &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}

function unwrapOuterParentheses(typeText) {
  let output = normalizeReturnType(typeText || "");
  while (output.startsWith("(") && output.endsWith(")")) {
    let depth = 0;
    let wrapsWholeExpression = true;
    for (let index = 0; index < output.length; index += 1) {
      const char = output[index];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0 && index < output.length - 1) {
          wrapsWholeExpression = false;
          break;
        }
      }
    }

    if (!wrapsWholeExpression || depth !== 0) {
      break;
    }

    output = normalizeReturnType(output.slice(1, -1));
  }

  return output;
}

function collectTablePropertiesFromLanguageServer(
  source,
  filePath,
  moduleTableName,
  excludePrivate,
  memberMap,
  parserContext
) {
  if (!moduleTableName || !filePath) {
    return [];
  }

  const inferredModuleType = inferExpressionTypeWithLanguageServer(moduleTableName, {
    parserContext: parserContext || {},
    sourceText: source,
    filePath,
    probeVariableName: "__SOF_MODULE_PROBE",
  });
  if (!inferredModuleType) {
    return [];
  }

  const normalizedModuleType = unwrapOuterParentheses(inferredModuleType);
  if (!normalizedModuleType.startsWith("{") || !normalizedModuleType.endsWith("}")) {
    return [];
  }

  const typeBody = normalizeReturnType(normalizedModuleType.slice(1, -1));
  if (!typeBody) {
    return [];
  }

  const discovered = new Map();
  const entries = splitTopLevel(typeBody, ",")
    .map((entry) => normalizeReturnType(entry))
    .filter(Boolean);

  for (const entry of entries) {
    if (entry.startsWith("[") || entry.startsWith("...")) {
      continue;
    }

    const colonIndex = findTopLevelCharacterIndex(entry, ":");
    if (colonIndex <= 0) {
      continue;
    }

    const propertyName = normalizeReturnType(entry.slice(0, colonIndex));
    const propertyType = normalizeReturnType(entry.slice(colonIndex + 1));
    if (!propertyName || !propertyType) {
      continue;
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(propertyName)) {
      continue;
    }

    if (excludePrivate && propertyName.startsWith("_")) {
      continue;
    }

    if (memberMap instanceof Map && memberMap.has(propertyName)) {
      continue;
    }

    if (discovered.has(propertyName)) {
      continue;
    }

    discovered.set(propertyName, {
      name: propertyName,
      type: propertyType,
      nilable: false,
      sourceTypeBaseName: extractTypeReferenceBaseName(propertyType),
    });
  }

  return Array.from(discovered.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergePropertyMembers(propertyMembers, languageServerProperties, memberMap) {
  const merged = new Map();

  for (const property of propertyMembers || []) {
    if (!property || !property.name) {
      continue;
    }

    if (memberMap instanceof Map && memberMap.has(property.name)) {
      continue;
    }

    merged.set(property.name, {
      name: property.name,
      type: normalizeReturnType(property.type || "any") || "any",
      nilable: property.nilable === true,
      sourceTypeBaseName: String(property.sourceTypeBaseName || "").trim(),
    });
  }

  for (const property of languageServerProperties || []) {
    if (!property || !property.name) {
      continue;
    }

    if (memberMap instanceof Map && memberMap.has(property.name)) {
      continue;
    }

    const normalizedType = normalizeReturnType(property.type || "");
    const existing = merged.get(property.name);
    if (!existing) {
      merged.set(property.name, {
        name: property.name,
        type: normalizedType || "any",
        nilable: property.nilable === true,
        sourceTypeBaseName: String(property.sourceTypeBaseName || "").trim(),
      });
      continue;
    }

    merged.set(property.name, {
      ...existing,
      type: normalizedType || existing.type,
      // Preserve dynamic callback writes from regex inference while still accepting LSP type upgrades.
      nilable: Boolean(existing.nilable) || property.nilable === true,
      sourceTypeBaseName: String(property.sourceTypeBaseName || existing.sourceTypeBaseName || "").trim(),
    });
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function formatFunctionType(operator, selfType, generics, params, returnType) {
  const genericPrefix = generics ? `${generics}` : "";
  const finalReturn = returnType || "()";

  let finalParams = normalizeParams(params);
  if (operator === ":") {
    const selfParam = `self: ${selfType}`;
    finalParams = finalParams ? `${selfParam}, ${finalParams}` : selfParam;
  }

  return `${genericPrefix}(${finalParams}) -> ${finalReturn}`;
}

function collectTableFunctionMembers(source, moduleTableName, selfType, excludePrivate, memberMap) {
  if (!moduleTableName) {
    return;
  }

  const declarationPattern = /(^|\n)\s*function\s+([A-Za-z_][A-Za-z0-9_\.]*)\s*([:.])\s*([A-Za-z_][A-Za-z0-9_]*)\s*(<[^>\n]*>)?\s*\(/g;
  let declarationMatch = declarationPattern.exec(source);
  while (declarationMatch) {
    const tablePath = declarationMatch[2];
    const operator = declarationMatch[3];
    const memberName = declarationMatch[4];
    const generics = normalizeWhitespace(declarationMatch[5] || "");

    if (tablePath === moduleTableName) {
      const openParenIndex = declarationPattern.lastIndex - 1;
      const signature = parseSignatureFromOpenParen(source, openParenIndex);
      if (signature) {
        const functionType = formatFunctionType(
          operator,
          selfType,
          generics,
          signature.params,
          signature.returnType
        );
        addMember(memberMap, memberName, functionType, excludePrivate);
      }
    }

    declarationMatch = declarationPattern.exec(source);
  }

  const assignmentPattern = /(^|\n)\s*([A-Za-z_][A-Za-z0-9_\.]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\s*(<[^>\n]*>)?\s*\(/g;
  let assignmentMatch = assignmentPattern.exec(source);
  while (assignmentMatch) {
    const tablePath = assignmentMatch[2];
    const memberName = assignmentMatch[3];
    const generics = normalizeWhitespace(assignmentMatch[4] || "");

    if (tablePath === moduleTableName) {
      const openParenIndex = assignmentPattern.lastIndex - 1;
      const signature = parseSignatureFromOpenParen(source, openParenIndex);
      if (signature) {
        const functionType = formatFunctionType(
          ".",
          selfType,
          generics,
          signature.params,
          signature.returnType
        );
        addMember(memberMap, memberName, functionType, excludePrivate);
      }
    }

    assignmentMatch = assignmentPattern.exec(source);
  }

  // Cast-wrapped assignments `(module :: Type).method = function ...`
  const escapedTable = escapeRegExp(moduleTableName);
  const castAssignmentPattern = new RegExp(
    `(^|\\n)\\s*\\(\\s*${escapedTable}\\s*::[^)]+\\)\\.([A-Za-z_][A-Za-z0-9_]*)` +
      `\\s*=\\s*function\\s*(<[^>\\n]*>)?\\s*\\(`,
    "g"
  );
  let castMatch = castAssignmentPattern.exec(source);
  while (castMatch) {
    const memberName = castMatch[2];
    const generics = normalizeWhitespace(castMatch[3] || "");
    const openParenIndex = castAssignmentPattern.lastIndex - 1;
    const signature = parseSignatureFromOpenParen(source, openParenIndex);
    if (signature) {
      const functionType = formatFunctionType(
        ".",
        selfType,
        generics,
        signature.params,
        signature.returnType
      );
      addMember(memberMap, memberName, functionType, excludePrivate);
    }
    castMatch = castAssignmentPattern.exec(source);
  }

  // Bracketed string-literal keys `module["method"] = function ...`
  const bracketAssignmentPattern = new RegExp(
    `(^|\\n)\\s*${escapedTable}\\[\\s*(?:"([^"\\n]+)"|'([^'\\n]+)')\\s*\\]` +
      `\\s*=\\s*function\\s*(<[^>\\n]*>)?\\s*\\(`,
    "g"
  );
  let bracketMatch = bracketAssignmentPattern.exec(source);
  while (bracketMatch) {
    const memberName = bracketMatch[2] || bracketMatch[3] || "";
    const generics = normalizeWhitespace(bracketMatch[4] || "");
    if (!memberName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(memberName)) {
      bracketMatch = bracketAssignmentPattern.exec(source);
      continue;
    }
    const openParenIndex = bracketAssignmentPattern.lastIndex - 1;
    const signature = parseSignatureFromOpenParen(source, openParenIndex);
    if (signature) {
      const functionType = formatFunctionType(
        ".",
        selfType,
        generics,
        signature.params,
        signature.returnType
      );
      addMember(memberMap, memberName, functionType, excludePrivate);
    }
    bracketMatch = bracketAssignmentPattern.exec(source);
  }
}

function findClosingBrace(source, openingBraceIndex) {
  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index++) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function collectReturnedObjectMembers(source, selfType, excludePrivate, memberMap) {
  let returnMatch = null;
  const returnPattern = /(^|\n)\s*return\s*\{/g;
  let nextMatch = returnPattern.exec(source);
  while (nextMatch) {
    returnMatch = nextMatch;
    nextMatch = returnPattern.exec(source);
  }

  if (!returnMatch) {
    return;
  }

  const openingBraceIndex = source.indexOf("{", returnMatch.index);
  if (openingBraceIndex < 0) {
    return;
  }

  const closingBraceIndex = findClosingBrace(source, openingBraceIndex);
  if (closingBraceIndex < 0) {
    return;
  }

  const body = source.slice(openingBraceIndex + 1, closingBraceIndex);
  const functionPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\s*(<[^>\n]*>)?\s*\(/g;
  let functionMatch = functionPattern.exec(body);

  while (functionMatch) {
    const memberName = functionMatch[1];
    const generics = normalizeWhitespace(functionMatch[2] || "");
    const openParenIndex = openingBraceIndex + 1 + functionMatch.index + functionMatch[0].length - 1;
    const signature = parseSignatureFromOpenParen(source, openParenIndex);

    if (signature) {
      const functionType = formatFunctionType(
        ".",
        selfType,
        generics,
        signature.params,
        signature.returnType
      );
      addMember(memberMap, memberName, functionType, excludePrivate);
    }

    functionMatch = functionPattern.exec(body);
  }
}

function collectReturnedFunctionType(source, selfType) {
  let lastMatch = null;
  let openParenIndex = -1;

  const returnFunctionPattern = /(^|\n)\s*return\s+function\s*(<[^>\n]*>)?\s*\(/g;
  let match = returnFunctionPattern.exec(source);
  while (match) {
    lastMatch = match;
    openParenIndex = returnFunctionPattern.lastIndex - 1;
    match = returnFunctionPattern.exec(source);
  }

  if (!lastMatch || openParenIndex < 0) {
    return "";
  }

  const signature = parseSignatureFromOpenParen(source, openParenIndex);
  if (!signature) {
    return "";
  }

  const generics = normalizeWhitespace(lastMatch[2] || "");
  return formatFunctionType(".", selfType, generics, signature.params, signature.returnType);
}

function parseLuauModule(source, filePath, options) {
  const opts = options || {};
  const excludePrivate = opts.excludePrivate !== false;
  const parserContext = opts.parserContext || {};
  const moduleTypeName = deriveModuleTypeName(filePath);
  const moduleTableName = detectModuleTableName(source, parserContext);

  // Batch-warm the luau-lsp cache with every cast expression + module probe in
  // one spawn. Callers that prefer async prewarm can run prewarmLanguageServerCacheAsync
  // ahead of time; this sync fallback keeps correctness when prewarm was skipped.
  if (opts.prewarmLanguageServer !== false) {
    try {
      prewarmLanguageServerCache(source, filePath, parserContext, moduleTableName);
    } catch (_err) {
      // Continue with regex-based inference on any LSP failure.
    }
  }

  const memberMap = new Map();
  collectTableFunctionMembers(source, moduleTableName, moduleTypeName, excludePrivate, memberMap);

  if (memberMap.size === 0) {
    collectReturnedObjectMembers(source, moduleTypeName, excludePrivate, memberMap);
  }

  let functionType = "";
  let moduleKind = "table";
  if (memberMap.size === 0) {
    functionType = collectReturnedFunctionType(source, moduleTypeName);
    if (functionType) {
      moduleKind = "function";
    }
  }

  const members = Array.from(memberMap.entries())
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const inferredProperties = collectTablePropertyMembers(
    source,
    filePath,
    moduleTableName,
    excludePrivate,
    memberMap,
    parserContext
  );
  const languageServerProperties = collectTablePropertiesFromLanguageServer(
    source,
    filePath,
    moduleTableName,
    excludePrivate,
    memberMap,
    parserContext
  );
  const properties = mergePropertyMembers(inferredProperties, languageServerProperties, memberMap);

  return {
    moduleName: moduleTypeName,
    typeName: moduleTypeName,
    tableName: moduleTableName,
    moduleKind,
    functionType,
    properties,
    members,
  };
}

module.exports = {
  deriveModuleTypeName,
  detectModuleTableName,
  hashString,
  parseLuauModule,
  prewarmLanguageServerCache,
  prewarmLanguageServerCacheAsync,
  prewarmLanguageServerCacheMulti,
  toPascalCase,
};
