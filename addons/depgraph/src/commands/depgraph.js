"use strict";

const fs = require("fs");
const path = require("path");
const fg = require("fast-glob");
const { readPackagePublishConfig } = require("../packages/config");
const { resolveOutputDefault } = require("../output-config");

const HELP_TEXT = `
sof run depgraph - Analyze dependency graphs

USAGE:
  sof run depgraph <package|require> [options]

SUBCOMMANDS:
  package
    sof run depgraph package [path/to/sof.toml] [options]
    Graph package dependencies from [[package]] metadata
    OPTIONS:
      --scope <scope/name>               Root package for a scoped subgraph
      --format <tree|json|dot|mermaid>   Output format (default: tree)
      --check                            Validate package dependency issues
      --output <file>                    Write output to a file
      -h, --help                         Show package graph help

  require
    sof run depgraph require [options]
    Graph Luau require() dependencies from source files
    OPTIONS:
      --entry <path/to/file.luau>        Restrict output to one entry's reachable subgraph
      --realm <server|client|shared>     Filter files by execution realm
      --format <tree|json|dot|mermaid>   Output format (default: tree)
      --check                            Validate unresolved/cycles/realm-crossing/dead-code
      --output <file>                    Write output to a file
      -h, --help                         Show require graph help
`;

const PACKAGE_HELP_TEXT = `
sof run depgraph package - Graph [[package]] dependencies

USAGE:
  sof run depgraph package [path/to/sof.toml] [options]

OPTIONS:
  --scope <scope/name>               Root package for a scoped subgraph
  --format <tree|json|dot|mermaid>   Output format (default: tree)
  --check                            Validate package dependency issues
  --output <file>                    Write output to a file
  -h, --help                         Show this help message
`;

const REQUIRE_HELP_TEXT = `
sof run depgraph require - Graph Luau require() dependencies

USAGE:
  sof run depgraph require [options]

OPTIONS:
  --entry <path/to/file.luau>        Restrict output to one entry's reachable subgraph
  --realm <server|client|shared>     Filter files by execution realm
  --format <tree|json|dot|mermaid>   Output format (default: tree)
  --check                            Validate unresolved/cycles/realm-crossing/dead-code
  --output <file>                    Write output to a file
  -h, --help                         Show this help message
`;

const SUPPORTED_FORMATS = new Set(["tree", "json", "dot", "mermaid"]);
const SUPPORTED_REALMS = new Set(["server", "client", "shared"]);

function normalizeSlash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function displayPath(value) {
  const relative = path.relative(process.cwd(), value);
  return relative || ".";
}

function writeOutput(text, outputPathArg) {
  if (!outputPathArg) {
    process.stdout.write(`${text.endsWith("\n") ? text : `${text}\n`}`);
    return;
  }

  const outputPath = path.resolve(outputPathArg);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, text, "utf8");
  console.log(`Wrote graph to ${displayPath(outputPath)}`);
}

function parseSharedOptions(argv) {
  const output = {
    format: "tree",
    check: false,
    outputPath: null,
    help: false,
    positional: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--check") {
      output.check = true;
      continue;
    }

    if (arg === "--format") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--format requires a value.");
      }
      output.format = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--output requires a path value.");
      }
      output.outputPath = value.trim();
      index += 1;
      continue;
    }

    output.positional.push(arg);
  }

  if (!SUPPORTED_FORMATS.has(output.format)) {
    throw new Error(
      `Unsupported format "${output.format}". Expected one of: ${Array.from(SUPPORTED_FORMATS).join(", ")}.`
    );
  }

  return output;
}

function resolvePublishConfig(configPathArg) {
  if (configPathArg) {
    return readPackagePublishConfig(configPathArg);
  }

  const defaultPath = path.resolve("sof.toml");
  const fallbackPath = path.resolve("packages.sof.toml");

  if (!fs.existsSync(defaultPath) && fs.existsSync(fallbackPath)) {
    return readPackagePublishConfig(fallbackPath);
  }

  try {
    return readPackagePublishConfig(defaultPath);
  } catch (err) {
    const missingPattern = /must define at least one \[\[package\]\] entry to publish\./;
    if (!missingPattern.test(String(err.message || "")) || !fs.existsSync(fallbackPath)) {
      throw err;
    }
    return readPackagePublishConfig(fallbackPath);
  }
}

function toPackageGraph(config) {
  const nodes = new Map();
  for (const packageEntry of config.packages) {
    nodes.set(packageEntry.name, {
      id: packageEntry.name,
      include: packageEntry.include.slice(),
      dependencies: packageEntry.dependencies.map((dep) => ({
        alias: dep.alias,
        name: dep.name,
        range: dep.range,
      })),
    });
  }

  const edges = [];
  for (const node of nodes.values()) {
    for (const dep of node.dependencies) {
      edges.push({
        from: node.id,
        to: dep.name,
        alias: dep.alias,
        declaredRange: dep.range,
        internal: nodes.has(dep.name),
      });
    }
  }

  return {
    nodes: Array.from(nodes.values()).sort((a, b) => a.id.localeCompare(b.id)),
    edges,
  };
}

function collectReachableNodesFromPackageRoot(graph, rootId) {
  const edgesByFrom = new Map();
  for (const edge of graph.edges) {
    const list = edgesByFrom.get(edge.from) || [];
    list.push(edge);
    edgesByFrom.set(edge.from, list);
  }

  const visited = new Set();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const edge of edgesByFrom.get(current) || []) {
      if (!visited.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }

  return visited;
}

function scopePackageGraph(graph, scopePackageName) {
  if (!scopePackageName) {
    return graph;
  }

  if (!graph.nodes.some((node) => node.id === scopePackageName)) {
    throw new Error(`Package "${scopePackageName}" was not found in graph nodes.`);
  }

  const reachable = collectReachableNodesFromPackageRoot(graph, scopePackageName);
  return {
    nodes: graph.nodes.filter((node) => reachable.has(node.id)),
    edges: graph.edges.filter((edge) => reachable.has(edge.from) && reachable.has(edge.to)),
  };
}

function detectPackageCycles(graph) {
  const adjacency = new Map();
  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!edge.internal) {
      continue;
    }
    const list = adjacency.get(edge.from) || [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function dfs(nodeId) {
    if (visiting.has(nodeId)) {
      const cycleStart = stack.indexOf(nodeId);
      if (cycleStart >= 0) {
        const cycle = stack.slice(cycleStart).concat(nodeId);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(nodeId)) {
      return;
    }

    visiting.add(nodeId);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) || []) {
      dfs(next);
    }
    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const node of graph.nodes) {
    dfs(node.id);
  }

  return cycles;
}

function parseServiceAliases(source) {
  const aliases = new Map();
  const regex =
    /local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*game:GetService\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g;
  let match = regex.exec(source);
  while (match) {
    aliases.set(match[1], match[2]);
    match = regex.exec(source);
  }
  return aliases;
}

function extractRequireArguments(source) {
  const output = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf("require", cursor);
    if (start < 0) {
      break;
    }

    let index = start + "require".length;
    while (index < source.length && /\s/.test(source[index])) {
      index += 1;
    }

    if (source[index] !== "(") {
      cursor = start + 1;
      continue;
    }

    index += 1;
    const argStart = index;
    let depth = 1;
    let quote = null;
    while (index < source.length) {
      const char = source[index];
      if (quote) {
        if (char === "\\" && index + 1 < source.length) {
          index += 2;
          continue;
        }
        if (char === quote) {
          quote = null;
        }
        index += 1;
        continue;
      }

      if (char === "'" || char === "\"") {
        quote = char;
        index += 1;
        continue;
      }

      if (char === "(") {
        depth += 1;
        index += 1;
        continue;
      }

      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          const argument = source.slice(argStart, index).trim();
          output.push(argument);
          index += 1;
          break;
        }
        index += 1;
        continue;
      }

      index += 1;
    }

    cursor = index;
  }

  return output;
}

function parseExpressionSegments(expression) {
  const trimmed = expression.trim();
  const rootMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
  if (!rootMatch) {
    return null;
  }

  const output = {
    root: rootMatch[1],
    segments: [],
  };

  let cursor = rootMatch[0].length;
  while (cursor < trimmed.length) {
    const remainder = trimmed.slice(cursor);
    const dotMatch = /^\.\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(remainder);
    if (dotMatch) {
      output.segments.push(dotMatch[1]);
      cursor += dotMatch[0].length;
      continue;
    }

    const indexMatch = /^\[\s*["']([^"']+)["']\s*\]/.exec(remainder);
    if (indexMatch) {
      output.segments.push(indexMatch[1]);
      cursor += indexMatch[0].length;
      continue;
    }

    const waitForChildMatch = /^:\s*(?:WaitForChild|FindFirstChild)\(\s*["']([^"']+)["']\s*\)/.exec(
      remainder
    );
    if (waitForChildMatch) {
      output.segments.push(waitForChildMatch[1]);
      cursor += waitForChildMatch[0].length;
      continue;
    }

    if (/^\s*$/.test(remainder)) {
      break;
    }

    return null;
  }

  return output;
}

function resolvePathFromSegments(baseDirectory, segments) {
  if (!baseDirectory || segments.length === 0) {
    return null;
  }
  const candidateBase = path.join(baseDirectory, ...segments);
  const candidates = [];
  if (/\.(luau|lua)$/i.test(candidateBase)) {
    candidates.push(candidateBase);
  } else {
    candidates.push(candidateBase);
    candidates.push(`${candidateBase}.luau`);
    candidates.push(`${candidateBase}.lua`);
    candidates.push(path.join(candidateBase, "init.luau"));
    candidates.push(path.join(candidateBase, "init.lua"));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.resolve(candidate);
    }
  }

  return null;
}

function deriveRealmFromFile(filePath) {
  const normalized = normalizeSlash(path.resolve(filePath)).toLowerCase();
  if (normalized.includes("/src/serverstorage/") || normalized.includes("/src/serverscriptservice/")) {
    return "server";
  }
  if (
    normalized.includes("/src/starterplayerscripts/") ||
    normalized.includes("/src/replicatedfirst/")
  ) {
    return "client";
  }
  if (normalized.includes("/src/replicatedstorage/")) {
    return "shared";
  }
  return "unknown";
}

function resolveRequireTarget(filePath, requireArgument, workspaceRoot, serviceAliases) {
  const trimmed = requireArgument.trim();
  const stringMatch = /^["']([^"']+)["']$/.exec(trimmed);
  if (stringMatch) {
    const value = stringMatch[1];
    if (value.startsWith("@self/")) {
      const relative = value.slice("@self/".length);
      const segments = relative.split("/").filter(Boolean);
      return resolvePathFromSegments(path.dirname(filePath), segments);
    }
    return null;
  }

  const expression = parseExpressionSegments(trimmed);
  if (!expression) {
    return null;
  }

  if (expression.root === "script" && expression.segments.length > 0 && expression.segments[0] === "Parent") {
    return resolvePathFromSegments(path.dirname(filePath), expression.segments.slice(1));
  }

  const serviceName = serviceAliases.get(expression.root);
  if (!serviceName) {
    return null;
  }

  const serviceRoots = {
    ReplicatedStorage: path.join(workspaceRoot, "src", "ReplicatedStorage"),
    ServerStorage: path.join(workspaceRoot, "src", "ServerStorage"),
    ServerScriptService: path.join(workspaceRoot, "src", "ServerScriptService"),
    StarterPlayerScripts: path.join(workspaceRoot, "src", "StarterPlayerScripts"),
    ReplicatedFirst: path.join(workspaceRoot, "src", "ReplicatedFirst"),
  };

  const baseRoot = serviceRoots[serviceName];
  if (!baseRoot) {
    return null;
  }

  return resolvePathFromSegments(baseRoot, expression.segments);
}

function buildRequireGraph() {
  const workspaceRoot = process.cwd();
  const files = fg.sync("src/**/*.luau", {
    cwd: workspaceRoot,
    absolute: true,
    onlyFiles: true,
  });

  const nodeSet = new Set(files.map((filePath) => path.resolve(filePath)));
  const edges = [];
  const unresolved = [];

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const serviceAliases = parseServiceAliases(source);
    const requireArguments = extractRequireArguments(source);

    for (const argument of requireArguments) {
      const targetPath = resolveRequireTarget(filePath, argument, workspaceRoot, serviceAliases);
      if (!targetPath || !nodeSet.has(targetPath)) {
        unresolved.push({
          from: path.resolve(filePath),
          argument,
        });
        continue;
      }

      edges.push({
        from: path.resolve(filePath),
        to: targetPath,
      });
    }
  }

  const nodes = Array.from(nodeSet).map((absolutePath) => ({
    id: absolutePath,
    realm: deriveRealmFromFile(absolutePath),
  }));

  return {
    nodes,
    edges,
    unresolved,
  };
}

function scopeRequireGraph(graph, entryPathArg) {
  if (!entryPathArg) {
    return graph;
  }

  const entryAbsolute = path.resolve(entryPathArg);
  if (!graph.nodes.some((node) => node.id === entryAbsolute)) {
    throw new Error(`Entry file is not part of the require graph: ${displayPath(entryAbsolute)}`);
  }

  const edgesByFrom = new Map();
  for (const edge of graph.edges) {
    const list = edgesByFrom.get(edge.from) || [];
    list.push(edge.to);
    edgesByFrom.set(edge.from, list);
  }

  const visited = new Set();
  const queue = [entryAbsolute];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of edgesByFrom.get(current) || []) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }

  return {
    nodes: graph.nodes.filter((node) => visited.has(node.id)),
    edges: graph.edges.filter((edge) => visited.has(edge.from) && visited.has(edge.to)),
    unresolved: graph.unresolved.filter((issue) => visited.has(issue.from)),
  };
}

function filterRequireGraphByRealm(graph, realm) {
  if (!realm) {
    return graph;
  }
  const allowed = new Set(
    graph.nodes.filter((node) => node.realm === realm).map((node) => node.id)
  );
  return {
    nodes: graph.nodes.filter((node) => allowed.has(node.id)),
    edges: graph.edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to)),
    unresolved: graph.unresolved.filter((issue) => allowed.has(issue.from)),
  };
}

function buildAdjacency(graph) {
  const adjacency = new Map();
  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) || [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  return adjacency;
}

function detectCyclesFromAdjacency(adjacency) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function dfs(nodeId) {
    if (visiting.has(nodeId)) {
      const cycleStart = stack.indexOf(nodeId);
      if (cycleStart >= 0) {
        cycles.push(stack.slice(cycleStart).concat(nodeId));
      }
      return;
    }
    if (visited.has(nodeId)) {
      return;
    }

    visiting.add(nodeId);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) || []) {
      dfs(next);
    }
    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const nodeId of adjacency.keys()) {
    dfs(nodeId);
  }

  return cycles;
}

function detectRealmCrossing(graph) {
  const realmByNode = new Map(graph.nodes.map((node) => [node.id, node.realm]));
  const issues = [];
  for (const edge of graph.edges) {
    const fromRealm = realmByNode.get(edge.from);
    const toRealm = realmByNode.get(edge.to);
    if (fromRealm === "client" && toRealm === "server") {
      issues.push(edge);
    }
  }
  return issues;
}

function detectDeadNodes(graph) {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
  }
  return graph.nodes
    .filter((node) => (indegree.get(node.id) || 0) === 0)
    .map((node) => node.id);
}

function toTreeText(graph, kind) {
  if (kind === "package") {
    const edgesByFrom = new Map();
    for (const edge of graph.edges) {
      const list = edgesByFrom.get(edge.from) || [];
      list.push(edge);
      edgesByFrom.set(edge.from, list);
    }
    const lines = [];
    for (const node of graph.nodes.slice().sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(node.id);
      const deps = (edgesByFrom.get(node.id) || []).slice().sort((a, b) => a.to.localeCompare(b.to));
      if (deps.length === 0) {
        lines.push("  (no dependencies)");
      } else {
        for (const dep of deps) {
          const marker = dep.internal ? "" : " (external)";
          lines.push(`  -> ${dep.alias}: ${dep.to}${marker}`);
        }
      }
    }
    return `${lines.join("\n")}\n`;
  }

  const lines = [];
  const edgesByFrom = new Map();
  for (const edge of graph.edges) {
    const list = edgesByFrom.get(edge.from) || [];
    list.push(edge.to);
    edgesByFrom.set(edge.from, list);
  }
  for (const node of graph.nodes.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`${displayPath(node.id)} [${node.realm}]`);
    const deps = (edgesByFrom.get(node.id) || []).slice().sort((a, b) => a.localeCompare(b));
    if (deps.length === 0) {
      lines.push("  (no requires)");
    } else {
      for (const dep of deps) {
        lines.push(`  -> ${displayPath(dep)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function toDotText(graph, kind) {
  const lines = ["digraph G {"];
  if (kind === "package") {
    for (const node of graph.nodes) {
      lines.push(`  "${node.id}";`);
    }
    for (const edge of graph.edges) {
      lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.alias}"];`);
    }
  } else {
    for (const node of graph.nodes) {
      lines.push(`  "${displayPath(node.id)}";`);
    }
    for (const edge of graph.edges) {
      lines.push(`  "${displayPath(edge.from)}" -> "${displayPath(edge.to)}";`);
    }
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

function toMermaidText(graph, kind) {
  const lines = ["flowchart TD"];
  const nodeIds = new Map();
  let counter = 0;

  function getNodeId(label) {
    if (!nodeIds.has(label)) {
      counter += 1;
      nodeIds.set(label, `n${counter}`);
    }
    return nodeIds.get(label);
  }

  if (kind === "package") {
    for (const node of graph.nodes) {
      const nodeId = getNodeId(node.id);
      lines.push(`  ${nodeId}["${node.id}"]`);
    }
    for (const edge of graph.edges) {
      const fromId = getNodeId(edge.from);
      const toId = getNodeId(edge.to);
      lines.push(`  ${fromId} -->|"${edge.alias}"| ${toId}`);
    }
  } else {
    for (const node of graph.nodes) {
      const label = displayPath(node.id);
      const nodeId = getNodeId(label);
      lines.push(`  ${nodeId}["${label}"]`);
    }
    for (const edge of graph.edges) {
      const fromId = getNodeId(displayPath(edge.from));
      const toId = getNodeId(displayPath(edge.to));
      lines.push(`  ${fromId} --> ${toId}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function formatGraph(graph, kind, format) {
  if (format === "json") {
    if (kind === "require") {
      const jsonGraph = {
        nodes: graph.nodes.map((node) => ({
          id: displayPath(node.id),
          realm: node.realm,
        })),
        edges: graph.edges.map((edge) => ({
          from: displayPath(edge.from),
          to: displayPath(edge.to),
        })),
        unresolved: graph.unresolved.map((issue) => ({
          from: displayPath(issue.from),
          argument: issue.argument,
        })),
      };
      return `${JSON.stringify(jsonGraph, null, 2)}\n`;
    }
    return `${JSON.stringify(graph, null, 2)}\n`;
  }

  if (format === "dot") {
    return toDotText(graph, kind);
  }

  if (format === "mermaid") {
    return toMermaidText(graph, kind);
  }

  return toTreeText(graph, kind);
}

function runPackageGraph(argv) {
  const shared = parseSharedOptions(argv);
  if (shared.help) {
    console.log(PACKAGE_HELP_TEXT);
    process.exit(0);
  }

  let configPath = null;
  let scope = null;
  const remainder = [];
  for (let index = 0; index < shared.positional.length; index += 1) {
    const arg = shared.positional[index];
    if (arg === "--scope") {
      const value = shared.positional[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--scope requires a package name.");
      }
      scope = value.trim();
      index += 1;
      continue;
    }
    remainder.push(arg);
  }

  const filteredPositional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope") {
      index += 1;
      continue;
    }
    if (arg === "--format" || arg === "--output") {
      index += 1;
      continue;
    }
    if (arg === "--check" || arg === "-h" || arg === "--help") {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    filteredPositional.push(arg);
  }
  if (filteredPositional.length > 1) {
    throw new Error("depgraph package accepts at most one config path positional argument.");
  }
  configPath = filteredPositional[0] || null;

  const config = resolvePublishConfig(configPath);
  const graph = scopePackageGraph(toPackageGraph(config), scope);
  const cycles = detectPackageCycles(graph);

  const issues = [];
  if (shared.check) {
    for (const cycle of cycles) {
      issues.push(`Cycle: ${cycle.join(" -> ")}`);
    }
  }

  const effectiveOutputPath = shared.outputPath ?? resolveOutputDefault(configPath, "depgraph");
  const output = formatGraph(graph, "package", shared.format);
  writeOutput(output, effectiveOutputPath);

  if (shared.check && issues.length > 0) {
    throw new Error(`depgraph package check failed:\n- ${issues.join("\n- ")}`);
  }
}

function runRequireGraph(argv) {
  const shared = parseSharedOptions(argv);
  if (shared.help) {
    console.log(REQUIRE_HELP_TEXT);
    process.exit(0);
  }

  let entryPath = null;
  let realm = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--entry") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--entry requires a file path.");
      }
      entryPath = value.trim();
      index += 1;
      continue;
    }
    if (arg === "--realm") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--realm requires a value.");
      }
      realm = value.trim().toLowerCase();
      index += 1;
      continue;
    }
  }

  if (realm && !SUPPORTED_REALMS.has(realm)) {
    throw new Error(`Unsupported realm "${realm}". Expected: server, client, shared.`);
  }

  let graph = buildRequireGraph();
  graph = scopeRequireGraph(graph, entryPath);
  graph = filterRequireGraphByRealm(graph, realm);

  const adjacency = buildAdjacency(graph);
  const cycles = detectCyclesFromAdjacency(adjacency);
  const realmCrossing = detectRealmCrossing(graph);
  const deadNodes = detectDeadNodes(graph);

  const effectiveOutputPath = shared.outputPath ?? resolveOutputDefault(null, "depgraph");
  const output = formatGraph(graph, "require", shared.format);
  writeOutput(output, effectiveOutputPath);

  if (shared.check) {
    const issues = [];
    for (const issue of graph.unresolved) {
      issues.push(`Unresolved require in ${displayPath(issue.from)}: require(${issue.argument})`);
    }
    for (const cycle of cycles) {
      issues.push(`Cycle: ${cycle.map((node) => displayPath(node)).join(" -> ")}`);
    }
    for (const edge of realmCrossing) {
      issues.push(
        `Realm crossing: client file ${displayPath(edge.from)} requires server file ${displayPath(edge.to)}`
      );
    }
    for (const dead of deadNodes) {
      issues.push(`Possibly dead module (indegree 0): ${displayPath(dead)}`);
    }

    if (issues.length > 0) {
      throw new Error(`depgraph require check failed:\n- ${issues.join("\n- ")}`);
    }
  }
}

function runDepgraph(argv) {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    console.log(HELP_TEXT);
    process.exit(subcommand ? 0 : 1);
  }

  if (subcommand === "package") {
    runPackageGraph(rest);
    return;
  }

  if (subcommand === "require") {
    runRequireGraph(rest);
    return;
  }

  throw new Error(`Unknown depgraph command: ${subcommand}`);
}

module.exports = {
  runDepgraph,
};
