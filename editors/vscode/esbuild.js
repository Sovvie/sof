"use strict";

// Bundles src/extension.js and its dependencies (semver) into dist/extension.js, so the
// packaged extension carries no node_modules.

const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.js"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    return;
  }
  await esbuild.build(options);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
