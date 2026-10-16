"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sofhome-doctor-"));
process.env.SOF_HOME = home;
process.env.SOF_ACCOUNT_PROTECTION = "off";
delete process.env.SOF_OFFLINE;

const { runDoctor } = require("../src/commands/doctor");
const { runChecks } = require("../src/doctor/checks");
const { writeManifest } = require("../src/addons/store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-doctor-test-"));
}

async function capture(run) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...parts) => lines.push(parts.join(" "));
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines.join("\n");
}

function addonFolder(parent, name, descriptor = {}, files = {}) {
  const directory = path.join(parent, name);
  fs.mkdirSync(path.join(directory, "src"), { recursive: true });
  fs.writeFileSync(path.join(directory, "sof-addon.json"), JSON.stringify({ name, version: "1.0.0", command: name, entry: "src/main.js", description: "d", usage: name, sandbox: false, ...descriptor }));
  fs.writeFileSync(path.join(directory, "src", "main.js"), "exports.run = async () => {};\n");
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), content);
  return directory;
}

test.beforeEach(() => {
  writeManifest({ addons: {} });
  process.exitCode = undefined;
  delete process.env.SOF_OFFLINE;
});
test.after(() => {
  process.exitCode = undefined;
});

const find = (findings, pattern, status) => findings.filter((finding) => pattern.test(finding.message) && (!status || finding.status === status));

test("a machine with nothing set up has no problems", async () => {
  const findings = await runChecks({ directory: tempDir(), network: false });
  assert.deepEqual(findings.filter((finding) => finding.status === "problem"), []);
  assert.ok(find(findings, /no sof\.toml here or above/).length === 1);
});

test("add-ons: a missing folder, missing dependencies, unmet requirements and a bad descriptor are each reported", async () => {
  const parent = tempDir();
  const withDeps = addonFolder(parent, "deps", {}, { "package.json": JSON.stringify({ dependencies: { left: "1.0.0" } }) });
  const needy = addonFolder(parent, "needy", { requires: { sof: ">=99.0.0", addons: { absent: "*" } } });
  const broken = addonFolder(parent, "broken", { version: "nope" });
  const entry = (name, directory, extra = {}) => ({ name, version: "1.0.0", command: name, entry: "src/main.js", export: "run", directory, source: "path", ...extra });
  writeManifest({
    addons: {
      deps: entry("deps", withDeps),
      needy: entry("needy", needy),
      broken: entry("broken", broken),
      gone: entry("gone", path.join(parent, "gone")),
    },
  });

  const findings = await runChecks({ directory: tempDir(), network: false });
  assert.equal(find(findings, /gone@1\.0\.0: its folder is gone/, "problem").length, 1);
  assert.equal(find(findings, /dependencies \(left\) aren't installed/, "problem").length, 1);
  assert.ok(find(findings, /dependencies/)[0].fix.apply, "installing npm dependencies can be done by --fix");
  assert.equal(find(findings, /needs sof >=99\.0\.0/, "problem").length, 1);
  assert.equal(find(findings, /needs the add-on absent/, "problem").length, 1);
  assert.equal(find(findings, /"version" must be a semantic version/, "problem").length, 1);
  assert.match(find(findings, /not sandboxed/, "info")[0].message, /deps/);
});

test("a project: tools, scripts and packages are checked, and problems come with the command to run", async () => {
  const project = tempDir();
  fs.writeFileSync(
    path.join(project, "sof.toml"),
    `[tools]\nwidget = "acme/widget@1.0.0"\n\n[[dependencies]]\npath = "src/Packages"\nRouter = "sovvie/router@^1.0.0"\n\n[scripts]\nbuild = "widget build"\nbad = "echo hi | cat"\n`
  );
  const findings = await runChecks({ directory: project, network: false });

  const tool = find(findings, /widget 1\.0\.0 isn't installed/, "problem")[0];
  assert.equal(tool.fix.command, "sof run tools install");
  assert.equal(find(findings, /no sof\.lock yet/, "warn")[0].fix.command, "sof run install");
  assert.equal(find(findings, /script "bad".*without a shell/, "problem").length, 1);
});

test("a broken sof.toml is a problem, not a crash", async () => {
  const project = tempDir();
  fs.writeFileSync(path.join(project, "sof.toml"), "[tools\nbroken");
  const findings = await runChecks({ directory: project, network: false });
  assert.ok(findings.some((finding) => finding.status === "problem" && /parse/i.test(finding.message)));
});

test("the command prints sections, exits 1 on problems, and --json is parseable", async () => {
  const parent = tempDir();
  writeManifest({ addons: { gone: { name: "gone", version: "1.0.0", command: "gone", entry: "x.js", directory: path.join(parent, "gone"), source: "path" } } });
  const project = tempDir();
  fs.writeFileSync(path.join(project, "sof.toml"), "");
  const toml = path.join(project, "sof.toml");

  const text = await capture(() => runDoctor([toml, "--offline"]));
  assert.match(text, /\nadd-ons\n {2}✗ gone@1\.0\.0: its folder is gone/);
  assert.match(text, /1 problem\(s\) found/);
  assert.equal(process.exitCode, 1);

  process.exitCode = undefined;
  const json = JSON.parse(await capture(() => runDoctor([toml, "--offline", "--json"])));
  assert.equal(json.problems, 1);
  assert.ok(json.findings.some((finding) => finding.section === "add-ons" && finding.status === "problem"));

  writeManifest({ addons: {} });
  process.exitCode = undefined;
  await capture(() => runDoctor([toml, "--offline"]));
  assert.ok(!process.exitCode);
});

test("--fix applies what is safe and checks again", async () => {
  // runChecks is replaced so --fix can be tested with findings that carry an apply(), without installing anything.
  const checksPath = require.resolve("../src/doctor/checks");
  const doctorPath = require.resolve("../src/commands/doctor");
  const checks = require(checksPath);
  const original = checks.runChecks;
  let applied = 0;
  let round = 0;
  checks.runChecks = async () => [
    { section: "add-ons", status: round++ === 0 ? "problem" : "ok", message: "needs work", fix: { label: "do the thing", command: "do-it", apply: async () => (applied += 1) } },
  ];
  delete require.cache[doctorPath];
  try {
    const text = await capture(() => require("../src/commands/doctor").runDoctor(["--fix", "--offline"]));
    assert.equal(applied, 1);
    assert.match(text, /\+ do the thing/);
    assert.ok(!process.exitCode, "no problem is left after the fix");
  } finally {
    checks.runChecks = original;
    delete require.cache[doctorPath];
  }
});
