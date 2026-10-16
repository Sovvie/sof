"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..", "addons", "img");
const { parseArgs, applyDefaults } = require(path.join(root, "src/img/args"));
const { planOutput, planAll } = require(path.join(root, "src/img/plan"));
const { normalizeImgTable } = require(path.join(root, "src/img/config"));
const { formatBytes, formatLine, summarize, formatTotal } = require(path.join(root, "src/img/report"));
const { staticBase } = require(path.join(root, "src/img/collect"));

function resolvable(name) {
  try {
    require.resolve(name, { paths: [root] });
    return true;
  } catch (_e) {
    return false;
  }
}
const hasSharp = resolvable("sharp") && resolvable("fast-glob");
const skipSharp = hasSharp ? false : "sharp/fast-glob not installed in addons/img";

test("parseArgs reads inputs and options", () => {
  const o = parseArgs(["a.png", "dir", "--format", "jpg", "--quality=70", "--width", "100", "--dry-run", "--json"]);
  assert.deepEqual(o.inputs, ["a.png", "dir"]);
  assert.equal(o.format, "jpeg");
  assert.equal(o.quality, 70);
  assert.equal(o.width, 100);
  assert.equal(o.height, undefined);
  assert.equal(o.dryRun, true);
  assert.equal(o.json, true);
  assert.equal(o.enlarge, false);
  assert.equal(o.recursive, true);
});

test("parseArgs rejects bad input", () => {
  assert.throws(() => parseArgs([]), /at least one input/);
  assert.throws(() => parseArgs(["a.png", "--bogus"]), /Unknown option/);
  assert.throws(() => parseArgs(["a.png", "--quality", "0"]), /between 1 and 100/);
  assert.throws(() => parseArgs(["a.png", "--quality", "abc"]), /whole number/);
  assert.throws(() => parseArgs(["a.png", "--format", "bmp"]), /one of/);
  assert.throws(() => parseArgs(["a.png", "--fit", "x"]), /--fit/);
  assert.throws(() => parseArgs(["a.png", "--out", "o", "--in-place"]), /cannot be used together/);
  assert.throws(() => parseArgs(["a.png", "--delete-source"]), /requires --in-place/);
  assert.throws(() => parseArgs(["a.png", "--width"]), /requires a value/);
});

test("parseArgs help needs no inputs", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("applyDefaults lets flags win over config", () => {
  const o = applyDefaults(parseArgs(["a.png", "--quality", "50"]), { quality: 90, format: "webp", width: 64 });
  assert.equal(o.quality, 50);
  assert.equal(o.format, "webp");
  assert.equal(o.width, 64);
  assert.equal(o.fit, "inside");
  assert.equal(applyDefaults(parseArgs(["a.png"]), {}).quality, 80);
  assert.equal(applyDefaults(parseArgs(["a.png", "--in-place"]), { out: "/x" }).out, undefined);
});

test("normalizeImgTable validates and resolves out", () => {
  const base = path.resolve("/proj");
  assert.deepEqual(normalizeImgTable({ format: "JPG", quality: 60, out: "dist" }, base), {
    format: "jpeg",
    quality: 60,
    out: path.join(base, "dist"),
  });
  assert.deepEqual(normalizeImgTable(undefined, base), {});
  assert.throws(() => normalizeImgTable({ quality: 200 }, base), /quality/);
});

test("planOutput: default writes next to the input with a suffix", () => {
  const src = path.resolve("/w/a.png");
  const p = planOutput({ file: src, base: path.dirname(src) }, {});
  assert.equal(p.dest, path.resolve("/w/a.min.png"));
  assert.equal(p.sameFile, false);
  const c = planOutput({ file: src, base: path.dirname(src) }, { format: "webp" });
  assert.equal(c.dest, path.resolve("/w/a.webp"));
});

test("planOutput: --out mirrors the layout", () => {
  const base = path.resolve("/w/art");
  const src = path.join(base, "ui", "b.jpeg");
  const p = planOutput({ file: src, base }, { out: "/o", format: "avif" });
  assert.equal(p.dest, path.resolve("/o/ui/b.avif"));
  const same = planOutput({ file: src, base }, { out: "/o" });
  assert.equal(same.dest, path.resolve("/o/ui/b.jpeg"));
});

test("planOutput: --out equal to the source folder never overwrites the source", () => {
  const src = path.resolve("/w/a.png");
  const p = planOutput({ file: src, base: path.dirname(src) }, { out: "/w" });
  assert.equal(p.dest, path.resolve("/w/a.min.png"));
});

test("planOutput: --in-place", () => {
  const src = path.resolve("/w/a.png");
  const item = { file: src, base: path.dirname(src) };
  const same = planOutput(item, { inPlace: true });
  assert.equal(same.dest, src);
  assert.equal(same.keepOnlyIfSmaller, true);
  const conv = planOutput(item, { inPlace: true, format: "webp" });
  assert.equal(conv.dest, path.resolve("/w/a.webp"));
  assert.equal(conv.keepOnlyIfSmaller, false);
  assert.equal(conv.deleteSource, false);
  assert.equal(planOutput(item, { inPlace: true, format: "webp", deleteSource: true }).deleteSource, true);
  // jpeg -> jpeg keeps the .jpeg extension
  const j = path.resolve("/w/c.jpeg");
  assert.equal(planOutput({ file: j, base: path.dirname(j) }, { inPlace: true, format: "jpeg" }).dest, j);
});

test("planAll flags colliding outputs", () => {
  const items = [
    { file: path.resolve("/w/a.png"), base: path.resolve("/w") },
    { file: path.resolve("/w/a.jpg"), base: path.resolve("/w") },
  ];
  const plans = planAll(items, { format: "webp" });
  assert.equal(plans[0].error, undefined);
  assert.match(plans[1].error, /would also be written/);
});

test("staticBase finds the fixed part of a glob", () => {
  assert.equal(staticBase("art/**/*.png"), "art");
  assert.equal(staticBase("*.png"), ".");
  assert.equal(staticBase("a/b/c.png"), "a/b");
});

test("report formatting", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(120 * 1024), "120 KB");
  assert.equal(formatBytes(31 * 1024), "31 KB");
  const cwd = path.resolve("/w");
  const line = formatLine(
    { src: path.resolve("/w/src/a.png"), dest: path.resolve("/w/out/a.webp"), status: "ok", inBytes: 120 * 1024, outBytes: 31 * 1024 },
    cwd
  );
  assert.equal(line, "src/a.png -> out/a.webp  120 KB -> 31 KB (-74%)");
  const failed = formatLine({ src: path.resolve("/w/x.png"), status: "failed", error: "boom" }, cwd);
  assert.equal(failed, "x.png -> FAILED: boom");
  const results = [
    { status: "ok", inBytes: 1000, outBytes: 500 },
    { status: "skipped", inBytes: 1000, outBytes: 1200 },
    { status: "failed", error: "x" },
  ];
  const s = summarize(results);
  assert.equal(s.failed, 1);
  assert.equal(s.inBytes, 2000);
  assert.equal(s.outBytes, 1500);
  assert.match(formatTotal(s, true), /^Total: Would process 3 files/);
});

// ---- tests that really encode images ----

function sharpLib() {
  return require(require.resolve("sharp", { paths: [root] }));
}

async function makePng(file, w, h) {
  const sharp = sharpLib();
  const data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 7) % 256;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toFile(file);
}

function capture(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  return fn().then(
    () => {
      console.log = log;
      console.error = error;
      return { out, err };
    },
    (e) => {
      console.log = log;
      console.error = error;
      throw e;
    }
  );
}

test("run converts and resizes into --out", { skip: skipSharp }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sof-img-"));
  await makePng(path.join(dir, "in", "a.png"), 200, 100);
  await makePng(path.join(dir, "in", "sub", "b.png"), 50, 50);
  const { run } = require(path.join(root, "src/commands/img"));
  const prevCwd = process.cwd();
  const prevCode = process.exitCode;
  process.chdir(dir);
  try {
    const { out } = await capture(() => run(["in", "--out", "dist", "--format", "webp", "--width", "100"]));
    assert.ok(fs.existsSync(path.join(dir, "dist", "a.webp")));
    assert.ok(fs.existsSync(path.join(dir, "dist", "sub", "b.webp")));
    const meta = await sharpLib()(path.join(dir, "dist", "a.webp")).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 100);
    assert.equal(meta.height, 50);
    const small = await sharpLib()(path.join(dir, "dist", "sub", "b.webp")).metadata();
    assert.equal(small.width, 50, "never upscales");
    assert.ok(out.some((l) => l.startsWith("Total:")));
    assert.ok(fs.existsSync(path.join(dir, "in", "a.png")), "source untouched");
    assert.notEqual(process.exitCode, 1);
  } finally {
    process.chdir(prevCwd);
    process.exitCode = prevCode;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run --dry-run writes nothing; failures set exit code but others continue", { skip: skipSharp }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sof-img-"));
  await makePng(path.join(dir, "good.png"), 64, 64);
  fs.writeFileSync(path.join(dir, "bad.png"), "not an image");
  const { run } = require(path.join(root, "src/commands/img"));
  const prevCwd = process.cwd();
  const prevCode = process.exitCode;
  process.chdir(dir);
  try {
    await capture(() => run(["good.png", "--dry-run", "--format", "jpeg"]));
    assert.equal(fs.existsSync(path.join(dir, "good.jpg")), false);
    assert.notEqual(process.exitCode, 1);

    const { out, err } = await capture(() => run([".", "--out", "o", "--format", "jpeg", "--json"]));
    assert.equal(process.exitCode, 1);
    assert.ok(fs.existsSync(path.join(dir, "o", "good.jpg")));
    assert.equal(fs.existsSync(path.join(dir, "o", "bad.jpg")), false);
    const report = JSON.parse(out.join("\n"));
    assert.equal(report.summary.failed, 1);
    assert.equal(report.files.length, 2);
    assert.deepEqual(err, []);
  } finally {
    process.chdir(prevCwd);
    process.exitCode = prevCode;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run --in-place keeps the source when the result is not smaller", { skip: skipSharp }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sof-img-"));
  const file = path.join(dir, "a.png");
  await makePng(file, 64, 64);
  const before = fs.readFileSync(file);
  const { run } = require(path.join(root, "src/commands/img"));
  const prevCwd = process.cwd();
  const prevCode = process.exitCode;
  process.chdir(dir);
  try {
    await capture(() => run(["a.png", "--in-place", "--lossless"]));
    const after = fs.readFileSync(file);
    assert.ok(after.length <= before.length);
    await capture(() => run(["a.png", "--in-place", "--format", "webp", "--delete-source"]));
    assert.ok(fs.existsSync(path.join(dir, "a.webp")));
    assert.equal(fs.existsSync(file), false);
  } finally {
    process.chdir(prevCwd);
    process.exitCode = prevCode;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
