"use strict";

const fs = require("fs");
const path = require("path");
const { loadBundleConfig, mergeOptions } = require("./config");
const { resolveFormat, defaultName, defaultFileName } = require("./naming");
const { selectFiles } = require("./select");

const DEFAULT_MTIME = Date.UTC(2020, 0, 1);

function bundleDate(env = process.env) {
  const epoch = env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined && /^\d+$/.test(epoch)) {
    return new Date(Number(epoch) * 1000);
  }
  return null;
}

// realpath of the deepest existing ancestor plus the rest, so a not-yet-created file still compares fairly.
function resolveReal(target) {
  const full = path.resolve(target);
  const rest = [];
  let current = full;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch (_err) {
      const parent = path.dirname(current);
      if (parent === current) return full;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function looksLikeArchive(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4);
    const n = fs.readSync(fd, head, 0, 4, 0);
    return n >= 2 && ((head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0x1f && head[1] === 0x8b));
  } catch (_err) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Refuses an output that would clobber something that is not an earlier bundle.
function checkOutput(folderReal, outPath) {
  let stat = null;
  try {
    stat = fs.lstatSync(outPath);
  } catch (_err) {
    return;
  }
  if (stat.isDirectory()) {
    throw new Error(`The output path ${outPath} is a folder.`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`The output path ${outPath} is a symlink; refusing to write through it.`);
  }
  if (isInside(folderReal, resolveReal(outPath)) && !looksLikeArchive(outPath)) {
    throw new Error(
      `Refusing to overwrite ${outPath}: it is a file inside the bundled folder and not an earlier archive. Pick another --out.`
    );
  }
}

// Works out everything a run needs (options, output path, file list) without writing anything.
function planBundle(cli, { cwd = process.cwd(), env = process.env, now = new Date() } = {}) {
  const folder = path.resolve(cwd, cli.folder || ".");
  let stat;
  try {
    stat = fs.statSync(folder);
  } catch (_err) {
    throw new Error(`Folder not found: ${folder}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${folder} is not a folder.`);
  }
  const folderReal = fs.realpathSync(folder);

  const { file: configFile, config } = loadBundleConfig(folder);
  const opts = mergeOptions(cli, config);

  const outArg = opts.out;
  const format = resolveFormat(outArg, opts.format);
  const epoch = bundleDate(env);
  const nameDate = epoch || now;

  let outPath;
  if (outArg) {
    // a flag is relative to where the user is; the table's value to the bundled folder
    outPath = path.resolve(cli.out !== undefined ? cwd : folder, outArg);
  } else {
    outPath = path.join(path.resolve(cwd), "dist", defaultFileName({ folder, name: opts.name, version: opts.version || packageVersion(folder), date: nameDate, format }));
  }
  const outReal = resolveReal(outPath);
  checkOutput(folderReal, outPath);

  const selection = selectFiles(folder, {
    include: opts.include,
    exclude: opts.exclude,
    gitignore: opts.gitignore,
    skipPaths: [outPath, outPath + ".part", outReal, outReal + ".part"].filter((p) => isInside(folderReal, p) || isInside(folder, p)).map((p) =>
      isInside(folderReal, p) ? path.join(folder, path.relative(folderReal, p)) : p
    ),
  });

  const root = opts.rootFolder ? defaultName(folder, opts.name) : null;
  return {
    folder,
    configFile,
    options: opts,
    format,
    outPath,
    rootFolder: root,
    mtime: epoch || new Date(DEFAULT_MTIME),
    ...selection,
  };
}

function packageVersion(folder) {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8")).version;
    return typeof version === "string" ? version : undefined;
  } catch (_err) {
    return undefined;
  }
}

module.exports = { planBundle, checkOutput, resolveReal, bundleDate };
