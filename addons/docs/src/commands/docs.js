"use strict";

const fs = require("fs");
const path = require("path");
const fg = require("fast-glob");
const { readAutoTypesConfig } = require("../auto-types/config");
const { parseLuauModule } = require("../auto-types/parser");
const { resolveOutputDefault } = require("../output-config");

const HELP_TEXT = `
sof run docs - Generate API docs from Luau modules

USAGE:
  sof run docs [path/to/sof.toml] [options]

ARGUMENTS:
  path/to/sof.toml          Optional config path (default: ./sof.toml)

OPTIONS:
  --format <md|html>        Output format (default: md)
  --output <dir>            Output directory (default: ./docs/sof-api)
  -h, --help                Show this help message
`;

function parseArgs(argv) {
  const output = {
    configPath: null,
    format: "md",
    outputDir: null,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }

    if (arg === "--format") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--format requires a value: md or html.");
      }
      output.format = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--output requires a directory path.");
      }
      output.outputDir = value.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("docs accepts at most one positional argument (the config path).");
  }

  if (output.format !== "md" && output.format !== "html") {
    throw new Error(`Unsupported format "${output.format}". Use "md" or "html".`);
  }

  output.configPath = positional[0] || null;
  return output;
}

function toSafeFileName(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "group";
}

function collectFromDirectory(directoryPath, recursive) {
  const pattern = recursive ? "**/*.luau" : "*.luau";
  return fg.sync(pattern, {
    cwd: directoryPath,
    absolute: true,
    onlyFiles: true,
  });
}

function collectFromGlob(includePattern, cwd) {
  return fg.sync(includePattern, {
    cwd,
    absolute: true,
    onlyFiles: true,
  });
}

function collectLuauFiles(group, configDirectory) {
  const files = new Set();
  for (const includeEntry of group.include) {
    const resolved = path.resolve(configDirectory, includeEntry);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        for (const filePath of collectFromDirectory(resolved, group.recursive)) {
          if (filePath.toLowerCase().endsWith(".luau")) {
            files.add(path.resolve(filePath));
          }
        }
        continue;
      }

      if (stat.isFile() && resolved.toLowerCase().endsWith(".luau")) {
        files.add(path.resolve(resolved));
        continue;
      }
    }

    for (const filePath of collectFromGlob(includeEntry, configDirectory)) {
      if (filePath.toLowerCase().endsWith(".luau")) {
        files.add(path.resolve(filePath));
      }
    }
  }

  return Array.from(files).sort((a, b) => a.localeCompare(b));
}

function renderPropertiesTable(properties) {
  if (!properties || properties.length === 0) {
    return "_No properties detected._";
  }

  const lines = [
    "| Name | Type | Nilable |",
    "| --- | --- | --- |",
  ];

  for (const property of properties) {
    lines.push(
      `| \`${property.name}\` | \`${property.type || "any"}\` | ${property.nilable ? "yes" : "no"} |`
    );
  }

  return lines.join("\n");
}

function renderMembersTable(members) {
  if (!members || members.length === 0) {
    return "_No methods detected._";
  }

  const lines = [
    "| Name | Signature |",
    "| --- | --- |",
  ];

  for (const member of members) {
    lines.push(`| \`${member.name}\` | \`${member.type || "any"}\` |`);
  }

  return lines.join("\n");
}

function renderModuleMarkdown(moduleInfo) {
  const lines = [
    `## ${moduleInfo.typeName}`,
    "",
    `- Path: \`${moduleInfo.relativePath}\``,
    `- Module kind: \`${moduleInfo.moduleKind}\``,
    "",
  ];

  if (moduleInfo.moduleKind === "function" && moduleInfo.functionType) {
    lines.push(`- Function signature: \`${moduleInfo.functionType}\``);
    lines.push("");
  }

  lines.push("### Properties");
  lines.push("");
  lines.push(renderPropertiesTable(moduleInfo.properties));
  lines.push("");

  lines.push("### Methods");
  lines.push("");
  lines.push(renderMembersTable(moduleInfo.members));
  lines.push("");

  return lines.join("\n");
}

function renderGroupMarkdown(groupName, modules) {
  const lines = [
    `# ${groupName} API`,
    "",
    `Generated by \`sof run docs\` on ${new Date().toISOString()}.`,
    "",
    `Modules: **${modules.length}**`,
    "",
  ];

  if (modules.length === 0) {
    lines.push("_No module APIs were detected in this group._");
    lines.push("");
    return lines.join("\n");
  }

  for (const moduleInfo of modules) {
    lines.push(renderModuleMarkdown(moduleInfo));
  }

  return lines.join("\n");
}

function markdownToSimpleHtml(markdownText) {
  // Keep this intentionally lightweight and dependency-free.
  const escaped = markdownText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '  <meta charset="utf-8" />',
    "  <title>sof docs</title>",
    "  <style>",
    "    body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 24px; }",
    "    pre { white-space: pre-wrap; }",
    "  </style>",
    "</head>",
    "<body>",
    "<pre>",
    escaped,
    "</pre>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderIndex(config, generatedGroups, format) {
  const extension = format === "html" ? "html" : "md";
  const lines = [
    "# sof docs index",
    "",
    `Config: \`${path.relative(process.cwd(), config.configPath) || "."}\``,
    "",
    "## Groups",
    "",
  ];

  for (const item of generatedGroups) {
    lines.push(`- [${item.groupName}](${item.fileName}.${extension}) (${item.moduleCount} module(s))`);
  }

  lines.push("");
  const markdown = lines.join("\n");
  if (format === "html") {
    return markdownToSimpleHtml(markdown);
  }
  return markdown;
}

function runDocs(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const config = readAutoTypesConfig(args.configPath);
  const outputDirectory = path.resolve(
    args.outputDir ?? resolveOutputDefault(args.configPath, "docs") ?? "docs/sof-api"
  );
  fs.mkdirSync(outputDirectory, { recursive: true });

  const generatedGroups = [];
  for (const group of config.groups) {
    const files = collectLuauFiles(group, config.configDirectory);
    const modules = [];

    for (const filePath of files) {
      const source = fs.readFileSync(filePath, "utf8");
      const parsed = parseLuauModule(source, filePath, { excludePrivate: group.excludePrivate });
      const hasSurface =
        parsed.moduleKind === "function"
          ? Boolean(parsed.functionType)
          : (parsed.members.length > 0 || parsed.properties.length > 0);

      if (!hasSurface) {
        continue;
      }

      modules.push({
        ...parsed,
        relativePath: path.relative(process.cwd(), filePath) || path.basename(filePath),
      });
    }

    modules.sort((a, b) => a.typeName.localeCompare(b.typeName));
    const markdown = renderGroupMarkdown(group.name, modules);
    const baseName = toSafeFileName(group.name);
    const extension = args.format === "html" ? "html" : "md";
    const outputPath = path.join(outputDirectory, `${baseName}.${extension}`);
    const outputText = args.format === "html" ? markdownToSimpleHtml(markdown) : markdown;
    fs.writeFileSync(outputPath, outputText, "utf8");

    generatedGroups.push({
      groupName: group.name,
      moduleCount: modules.length,
      fileName: baseName,
      outputPath,
    });
  }

  const indexExtension = args.format === "html" ? "html" : "md";
  const indexPath = path.join(outputDirectory, `index.${indexExtension}`);
  fs.writeFileSync(indexPath, renderIndex(config, generatedGroups, args.format), "utf8");

  console.log(`Using config: ${path.relative(process.cwd(), config.configPath) || "."}`);
  console.log(`Wrote docs to: ${path.relative(process.cwd(), outputDirectory) || "."}`);
  for (const groupInfo of generatedGroups) {
    console.log(
      `  ✓ ${groupInfo.groupName}: ${path.relative(process.cwd(), groupInfo.outputPath)} (${groupInfo.moduleCount} module(s))`
    );
  }
  console.log(`  ✓ index: ${path.relative(process.cwd(), indexPath)}`);
}

module.exports = {
  runDocs,
};
