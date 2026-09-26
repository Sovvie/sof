"use strict";

const { toPascalCase } = require("./parser");
const HOIST_ALIAS_MIN_LENGTH = 120;

function toIdentifier(value, fallback) {
  const normalized = toPascalCase(value);
  return normalized || fallback;
}

function formatPropertyType(type, nilable) {
  if (!nilable || type.endsWith("?")) {
    return type;
  }

  if (type.includes("|")) {
    return `(${type})?`;
  }

  return `${type}?`;
}

function normalizeTypeKey(typeText) {
  return String(typeText || "").replace(/\s+/g, " ").trim();
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let start = 0;
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

function findTopLevelIndex(text, target) {
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
      char === target &&
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

function stripOuterParens(typeText) {
  let output = normalizeTypeKey(typeText);

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

    output = normalizeTypeKey(output.slice(1, -1));
  }

  return output;
}

function comparableType(typeText) {
  return normalizeTypeKey(stripOuterParens(typeText));
}

function parseFunctionSignature(typeText) {
  const normalized = normalizeTypeKey(typeText);
  if (!normalized.startsWith("(")) {
    return null;
  }

  let depth = 0;
  let closeParenIndex = -1;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        closeParenIndex = index;
        break;
      }
    }
  }

  if (closeParenIndex < 0) {
    return null;
  }

  const params = normalizeTypeKey(normalized.slice(1, closeParenIndex));
  const rest = normalizeTypeKey(normalized.slice(closeParenIndex + 1));
  if (!rest.startsWith("->")) {
    return null;
  }

  return {
    params,
    returnType: normalizeTypeKey(rest.slice(2)),
  };
}

function parseObjectTypeFields(typeText) {
  const normalized = normalizeTypeKey(typeText);
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) {
    return null;
  }

  const inner = normalizeTypeKey(normalized.slice(1, -1));
  const fields = new Map();
  if (!inner) {
    return fields;
  }

  const entries = splitTopLevel(inner, ",")
    .map((entry) => normalizeTypeKey(entry))
    .filter(Boolean);

  for (const entry of entries) {
    const colonIndex = findTopLevelIndex(entry, ":");
    if (colonIndex <= 0) {
      continue;
    }

    const key = normalizeTypeKey(entry.slice(0, colonIndex));
    const value = normalizeTypeKey(entry.slice(colonIndex + 1));
    if (!key || !value || fields.has(key)) {
      continue;
    }

    fields.set(key, value);
  }

  return fields;
}

function extractListenerPayload(listenerParamType) {
  const signature = parseFunctionSignature(listenerParamType);
  if (!signature) {
    return "";
  }

  if (comparableType(signature.returnType) !== "()") {
    return "";
  }

  return comparableType(signature.params);
}

function tryBuildReusableEmitChannelType(typeText) {
  const fields = parseObjectTypeFields(typeText);
  if (!fields) {
    return null;
  }

  const requiredFields = ["name", "emit", "subscribe", "once", "wait", "request", "onRequest"];
  for (const field of requiredFields) {
    if (!fields.has(field)) {
      return null;
    }
  }

  const emitSignature = parseFunctionSignature(fields.get("emit"));
  const waitSignature = parseFunctionSignature(fields.get("wait"));
  const requestSignature = parseFunctionSignature(fields.get("request"));
  const subscribeSignature = parseFunctionSignature(fields.get("subscribe"));
  const onceSignature = parseFunctionSignature(fields.get("once"));
  if (!emitSignature || !waitSignature || !requestSignature || !subscribeSignature || !onceSignature) {
    return null;
  }

  const payloadType = comparableType(emitSignature.params);
  if (!payloadType || comparableType(emitSignature.returnType) !== "()") {
    return null;
  }

  if (comparableType(waitSignature.params) !== "" || comparableType(waitSignature.returnType) !== payloadType) {
    return null;
  }

  if (comparableType(requestSignature.params) !== payloadType) {
    return null;
  }

  const subscribeParamColon = findTopLevelIndex(subscribeSignature.params, ":");
  const onceParamColon = findTopLevelIndex(onceSignature.params, ":");
  if (subscribeParamColon < 0 || onceParamColon < 0) {
    return null;
  }

  const subscribeListenerType = subscribeSignature.params.slice(subscribeParamColon + 1).trim();
  const onceListenerType = onceSignature.params.slice(onceParamColon + 1).trim();
  if (extractListenerPayload(subscribeListenerType) !== payloadType) {
    return null;
  }
  if (extractListenerPayload(onceListenerType) !== payloadType) {
    return null;
  }

  return {
    payloadType: stripOuterParens(emitSignature.params) || emitSignature.params,
  };
}

function tryBuildReusableEmitChannelTypeLoose(typeText) {
  const normalized = normalizeTypeKey(typeText);
  if (
    !normalized.startsWith("{") ||
    !normalized.endsWith("}") ||
    !normalized.includes("emit:") ||
    !normalized.includes("subscribe:") ||
    !normalized.includes("once:") ||
    !normalized.includes("wait:") ||
    !normalized.includes("request:") ||
    !normalized.includes("onRequest:")
  ) {
    return null;
  }

  const emitMatch = /emit:\s*\((.+?)\)\s*->\s*\(\)\s*,/.exec(normalized);
  const waitMatch = /wait:\s*\(\)\s*->\s*([^,]+),/.exec(normalized);
  const requestMatch = /request:\s*\((.+?)\)\s*->/.exec(normalized);
  if (!emitMatch || !waitMatch || !requestMatch) {
    return null;
  }

  const emitPayload = comparableType(emitMatch[1]);
  const waitPayload = comparableType(waitMatch[1]);
  const requestPayload = comparableType(requestMatch[1]);
  if (!emitPayload || emitPayload !== waitPayload || emitPayload !== requestPayload) {
    return null;
  }

  return {
    payloadType: stripOuterParens(emitMatch[1]) || emitMatch[1],
  };
}

function shouldHoistTypeAlias(typeText) {
  const normalized = normalizeTypeKey(typeText);
  if (!normalized) {
    return false;
  }

  if (normalized.length < HOIST_ALIAS_MIN_LENGTH) {
    return false;
  }

  if (!normalized.includes("{") && !normalized.includes("->")) {
    return false;
  }

  if (/^[A-Za-z_][A-Za-z0-9_.]*\??$/.test(normalized)) {
    return false;
  }

  return true;
}

function createUniqueAliasName(baseName, usedNames) {
  const root = `__${toIdentifier(baseName, "Type")}`;
  let candidate = root;
  let index = 2;
  while (usedNames.has(candidate)) {
    candidate = `${root}${index}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function createUniquePrefixedName(baseIdentifier, usedNames) {
  const root = `__${toIdentifier(baseIdentifier, "Type")}`;
  let candidate = root;
  let index = 2;
  while (usedNames.has(candidate)) {
    candidate = `${root}${index}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function deriveReusableChannelAliasNames(sourceTypeBaseName, usedNames) {
  const channelBase = toIdentifier(sourceTypeBaseName, "Channel");
  const channelAlias = createUniquePrefixedName(channelBase, usedNames);

  let stem = channelBase;
  if (stem.endsWith("Channel") && stem.length > "Channel".length) {
    stem = stem.slice(0, -("Channel".length));
  }

  const requestAlias = createUniquePrefixedName(`${stem}Request`, usedNames);
  const connectionAlias = createUniquePrefixedName(`${stem}Connection`, usedNames);

  return {
    sourceTypeBaseName: channelBase,
    channelAlias,
    requestAlias,
    connectionAlias,
  };
}

function buildTypeAliasPlan(modules, groupName) {
  const reservedNames = new Set([groupName]);
  for (const moduleInfo of modules) {
    reservedNames.add(moduleInfo.moduleName);
    reservedNames.add(moduleInfo.typeName);
  }

  const aliases = [];
  const aliasNameByTypeKey = new Map();
  const reusableChannelAliases = [];
  const reusableChannelAliasByBaseName = new Map();

  const modulesWithAliases = modules.map((moduleInfo) => {
    if (moduleInfo.moduleKind === "function") {
      return moduleInfo;
    }

    const nextProperties = moduleInfo.properties.map((property) => {
      const emitChannelReuse =
        tryBuildReusableEmitChannelType(property.type) ||
        tryBuildReusableEmitChannelTypeLoose(property.type);
      let transformedProperty = property;
      const sourceTypeBaseName = String(property.sourceTypeBaseName || "").trim();
      if (emitChannelReuse && sourceTypeBaseName) {
        let aliasNames = reusableChannelAliasByBaseName.get(sourceTypeBaseName);
        if (!aliasNames) {
          aliasNames = deriveReusableChannelAliasNames(sourceTypeBaseName, reservedNames);
          reusableChannelAliasByBaseName.set(sourceTypeBaseName, aliasNames);
          reusableChannelAliases.push(aliasNames);
        }

        transformedProperty = {
          ...property,
          type: `${aliasNames.channelAlias}<${emitChannelReuse.payloadType}>`,
        };
      }

      const normalizedType = normalizeTypeKey(transformedProperty.type);
      if (!shouldHoistTypeAlias(normalizedType)) {
        return transformedProperty;
      }

      let aliasName = aliasNameByTypeKey.get(normalizedType);
      if (!aliasName) {
        aliasName = createUniqueAliasName(
          `${moduleInfo.typeName} ${property.name} Type`,
          reservedNames
        );
        aliasNameByTypeKey.set(normalizedType, aliasName);
        aliases.push({
          name: aliasName,
          type: normalizedType,
        });
      }

      return {
        ...transformedProperty,
        hoistedAliasName: aliasName,
      };
    });

    return {
      ...moduleInfo,
      properties: nextProperties,
    };
  });

  return {
    modules: modulesWithAliases,
    aliases,
    reusableChannelAliases,
  };
}

function renderReusableChannelAliases(aliasDefinitions) {
  const output = [];
  const definitions = Array.isArray(aliasDefinitions) ? aliasDefinitions : [];

  for (const aliasDef of definitions) {
    output.push(`type ${aliasDef.connectionAlias} = {`);
    output.push("    connected: boolean,");
    output.push(`    disconnect: (self: ${aliasDef.connectionAlias}) -> (),`);
    output.push(`    isConnected: (self: ${aliasDef.connectionAlias}) -> boolean,`);
    output.push("}");
    output.push("");

    output.push(`type ${aliasDef.requestAlias}<T...> = {`);
    output.push("    id: number,");
    output.push(
      `    andThen: (self: ${aliasDef.requestAlias}<T...>, listener: (T...) -> ()) -> ${aliasDef.connectionAlias},`
    );
    output.push("}");
    output.push("");

    output.push(`type ${aliasDef.channelAlias}<T...> = {`);
    output.push("    name: string,");
    output.push("    emit: (T...) -> (),");
    output.push(`    subscribe: (listener: (T...) -> ()) -> ${aliasDef.connectionAlias},`);
    output.push(`    once: (listener: (T...) -> ()) -> ${aliasDef.connectionAlias},`);
    output.push("    wait: () -> T...,");
    output.push(`    request: (T...) -> ${aliasDef.requestAlias}<T...>,`);
    output.push(
      `    onRequest: (handler: (resolve: (...any) -> boolean, T...) -> ()) -> ${aliasDef.connectionAlias},`
    );
    output.push("}");
    output.push("");
  }

  if (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }

  return output;
}

function renderModuleType(moduleInfo) {
  if (moduleInfo.moduleKind === "function" && moduleInfo.functionType) {
    return `export type ${moduleInfo.typeName} = ${moduleInfo.functionType}`;
  }

  const lines = [];
  lines.push(`export type ${moduleInfo.typeName} = {`);

  if (moduleInfo.properties.length === 0 && moduleInfo.members.length === 0) {
    lines.push("}");
    return lines.join("\n");
  }

  for (const property of moduleInfo.properties) {
    const baseType = property.hoistedAliasName || property.type;
    const typeText = formatPropertyType(baseType, property.nilable);
    lines.push(`    ${property.name}: ${typeText},`);
  }

  for (const member of moduleInfo.members) {
    lines.push(`    ${member.name}: ${member.type},`);
  }

  lines.push("}");
  return lines.join("\n");
}

function generateTypeFile(params) {
  const groupName = toIdentifier(params.groupName, "Modules");
  const normalizedModules = (params.modules || [])
    .map((moduleInfo) => {
      const moduleName = toIdentifier(moduleInfo.moduleName, "Module");
      const typeName = toIdentifier(moduleInfo.typeName || moduleInfo.moduleName, moduleName);
      return {
        moduleName,
        typeName,
        moduleKind: moduleInfo.moduleKind || "table",
        functionType: moduleInfo.functionType || "",
        properties: (moduleInfo.properties || []).slice().sort((a, b) => a.name.localeCompare(b.name)),
        members: (moduleInfo.members || []).slice().sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => a.moduleName.localeCompare(b.moduleName));
  const aliasPlan = buildTypeAliasPlan(normalizedModules, groupName);
  const modules = aliasPlan.modules;

  const lines = [
    "--!strict",
    "-- Auto-generated by Sof (auto-types).",
    "-- Do not edit manually.",
    "",
  ];

  if (aliasPlan.reusableChannelAliases.length > 0) {
    lines.push(...renderReusableChannelAliases(aliasPlan.reusableChannelAliases));
    lines.push("");
  }

  for (const aliasInfo of aliasPlan.aliases) {
    lines.push(`type ${aliasInfo.name} = ${aliasInfo.type}`);
  }
  if (aliasPlan.aliases.length > 0) {
    lines.push("");
  }

  for (const moduleInfo of modules) {
    lines.push(renderModuleType(moduleInfo));
    lines.push("");
  }

  lines.push(`export type ${groupName} = {`);
  for (const moduleInfo of modules) {
    lines.push(`    ${moduleInfo.moduleName}: ${moduleInfo.typeName},`);
  }
  lines.push("}");
  lines.push("");
  lines.push("return {}");
  lines.push("");

  return lines.join("\n");
}

module.exports = {
  generateTypeFile,
};
