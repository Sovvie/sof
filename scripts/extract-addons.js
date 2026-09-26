"use strict";

// One-off migration helper: builds addons/<command>/ from the monolithic sof (Balloons
// tools/sof) by tracing each command's requires. Whole top-level folders under src/ that
// a command touches are copied, so data files next to the code come along.
//
//   node scripts/extract-addons.js <path to old tools/sof>

const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");

const COMMANDS = {
  "auto-types": { export: "runAutoTypes", usage: "auto-types [config]", description: "Compile Luau modules into a type file from TOML config" },
  docs: { export: "runDocs", usage: "docs [config]", description: "Generate API docs from Luau modules" },
  depgraph: { export: "runDepgraph", usage: "depgraph package|require", description: "Build package/require dependency graphs" },
  atlas: { export: "runAtlas", usage: "atlas generate <font> [output]", description: "Generate GlyphMetrics.luau from a font file" },
  spritesheet: { export: "runSpritesheet", usage: "spritesheet pack <in> [out]", description: "Pack sprites into atlas PNGs + Luau metadata" },
  "html-luau": { export: "runHtmlLuau", usage: "html-luau <path> [output]", description: "Compile HTML file(s) into Luau modules" },
  template: { export: "runTemplate", usage: "template save|use|list|remove", description: "Save and reuse project templates" },
  init: { export: "runInit", usage: "init [name]", description: "Scaffold a Sof-ready project layout" },
  pix: { export: "runPix", usage: "pix <input> <width> <height> [palette]", description: "Convert an image into pixel-art" },
  asset: { export: "runAsset", usage: "asset audit|list|replace", description: "Audit/list/replace rbxassetid references" },
  place: { export: "runPlace", usage: "place publish|versions|...", description: "Place publish/version/rollback/info utilities" },
  uploader: { export: "runUploader", usage: "uploader images|animations|...", description: "Upload assets via Roblox APIs" },
  "mesh-service": { export: "runMeshService", usage: "mesh-service [--port <port>]", description: "Mesh extraction/reupload HTTP service" },
  video: { export: "runVideo", usage: "video <file...> [options]", description: "Build video spritesheets and upload to Roblox" },
  webserver: { export: "runWebserver", usage: "webserver <path>|start|stop|...", description: "Manage local website servers" },
  "remote-exec": { export: "runRemoteExec", usage: "remote-exec [--port <port>]", description: "Roblox remote execution WebSocket bridge" },
  obfuscate: { export: "runObfuscate", usage: "obfuscate <input...> [options]", description: "Obfuscate Luau files" },
  "editable-mesh-bypasser": { export: "runEditableMeshBypasser", usage: "editable-mesh-bypasser [--port <port>]", description: "Asset proxy with mesh parsing and image downscaling" },
};

const oldRoot = path.resolve(process.argv[2] || "");
const oldSrc = path.join(oldRoot, "src");
const oldPackage = JSON.parse(fs.readFileSync(path.join(oldRoot, "package.json"), "utf8"));
const outRoot = path.resolve(__dirname, "..", "addons");
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function resolveLocal(fromFile, request) {
  const base = path.resolve(path.dirname(fromFile), request);
  for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function trace(entryFile) {
  const files = new Set();
  const external = new Set();
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) {
      continue;
    }
    files.add(file);

    if (!file.endsWith(".js")) {
      continue;
    }

    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      const request = match[1];
      if (request.startsWith(".")) {
        const resolved = resolveLocal(file, request);
        if (resolved) {
          queue.push(resolved);
        }
      } else if (!builtins.has(request)) {
        const parts = request.split("/");
        external.add(request.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
      }
    }
  }

  return { files, external };
}

fs.mkdirSync(outRoot, { recursive: true });

for (const [command, info] of Object.entries(COMMANDS)) {
  const entry = path.join(oldSrc, "commands", `${command}.js`);
  const { files, external } = trace(entry);
  const target = path.join(outRoot, command);
  fs.rmSync(target, { recursive: true, force: true });

  const copiedFolders = new Set();
  for (const file of files) {
    const relative = path.relative(oldSrc, file);
    const top = relative.split(path.sep)[0];

    if (relative.includes(path.sep) && top !== "commands") {
      if (!copiedFolders.has(top)) {
        copiedFolders.add(top);
        fs.cpSync(path.join(oldSrc, top), path.join(target, "src", top), {
          recursive: true,
          filter: (source) => !source.includes(`${path.sep}node_modules`),
        });
      }
      continue;
    }

    fs.mkdirSync(path.dirname(path.join(target, "src", relative)), { recursive: true });
    fs.copyFileSync(file, path.join(target, "src", relative));
  }

  const dependencies = {};
  for (const name of [...external].sort()) {
    const version = (oldPackage.dependencies || {})[name];
    if (!version) {
      console.warn(`  ! ${command}: "${name}" is not in the old package.json`);
      continue;
    }
    dependencies[name] = version;
  }

  fs.writeFileSync(
    path.join(target, "package.json"),
    `${JSON.stringify({ name: `sof-addon-${command}`, version: "1.0.0", private: true, license: "MIT", description: info.description, dependencies }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(target, "sof-addon.json"),
    `${JSON.stringify({ name: command, version: "1.0.0", command, entry: `src/commands/${command}.js`, export: info.export, usage: info.usage, description: info.description }, null, 2)}\n`
  );

  console.log(`${command}: ${files.size} traced files, folders [${[...copiedFolders].join(", ")}], deps [${Object.keys(dependencies).join(", ")}]`);
}
