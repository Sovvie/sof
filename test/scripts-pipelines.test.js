"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runScript } = require("../src/commands/script");
const { parseScript, readScriptsFile } = require("../src/scripts/parse");
const { buildPlan, outline, planShape } = require("../src/scripts/plan");
const { changesBetween, snapshot } = require("../src/scripts/watch");
const { definitionHash } = require("../src/scripts/trust");
const { EXE_SUFFIX } = require("../src/tools/store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-pipelines-test-"));
}

function file(directory, scripts) {
  const target = path.join(directory, "sof.toml");
  fs.writeFileSync(target, `[scripts]\n${scripts}\n`);
  return readScriptsFile(target);
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

// --- parsing ------------------------------------------------------------------------------------

test("a script can be a table with run, depends, parallel, watch and description", () => {
  const script = parseScript("ci", { depends: ["lint", "test"], parallel: true, run: "sof run install", watch: ["src/**"], description: "all" });
  assert.deepEqual(script.depends, ["lint", "test"]);
  assert.equal(script.parallel, true);
  assert.deepEqual(script.watch, ["src/**"]);
  assert.equal(script.commands.length, 1);

  const only = parseScript("all", { depends: ["a"] });
  assert.deepEqual(only.commands, []);

  const plain = parseScript("build", "rojo build");
  assert.deepEqual([plain.depends, plain.parallel, plain.watch], [[], false, []]);
});

test("a table is checked: keys, shapes, self-dependence and watch globs", () => {
  assert.throws(() => parseScript("x", {}), /needs "run"/);
  assert.throws(() => parseScript("x", { run: "a", extra: 1 }), /unknown key "extra"/);
  assert.throws(() => parseScript("x", { depends: "y" }), /array/);
  assert.throws(() => parseScript("x", { depends: ["x"] }), /depends on itself/);
  assert.throws(() => parseScript("x", { depends: ["y", "y"] }), /twice/);
  assert.throws(() => parseScript("x", { depends: ["bad name"] }), /isn't valid/);
  assert.throws(() => parseScript("x", { run: "a", parallel: "yes" }), /true or false/);
  assert.throws(() => parseScript("x", { run: "a", watch: ["../outside/**"] }), /inside the project/);
  assert.throws(() => parseScript("x", { run: "a", watch: ["/abs/**"] }), /relative/);
  assert.throws(() => parseScript("x", { run: "a", watch: ["a‮b"] }), /invisible/);
  assert.throws(() => parseScript("x", { run: "a; b" }), /without a shell/);
});

// --- planning -----------------------------------------------------------------------------------

test("a plan runs dependencies first, each script once", () => {
  const found = file(
    tempDir(),
    `base = "tool a"\nlint = { depends = ["base"], run = "tool b" }\ntest = { depends = ["base"], run = "tool c" }\nci = { depends = ["lint", "test"], run = "tool d" }`
  );
  const plan = buildPlan(found, "ci");
  assert.deepEqual(plan.nodes.map((node) => node.name), ["base", "lint", "test", "ci"]);
  assert.equal(plan.root, "ci");
  assert.deepEqual(outline(plan)[0], "  [base]:");
});

test("circles, unknown scripts and broken dependencies are explained before anything runs", () => {
  assert.throws(() => buildPlan(file(tempDir(), `a = { depends = ["b"] }\nb = { depends = ["a"] }`), "a"), /circle: a -> b -> a/);
  assert.throws(() => buildPlan(file(tempDir(), `a = { depends = ["nope"] }`), "a"), /"a" depends on "nope"/);
  assert.throws(() => buildPlan(file(tempDir(), `a = { depends = ["b"] }\nb = "x; y"`), "a"), /script "b"/);
});

test("everything a pipeline runs has to fit the size limit together", () => {
  const many = Array.from({ length: 14 }, (_, index) => `"tool ${index}"`).join(", ");
  const found = file(tempDir(), `one = [${many}]\ntwo = { depends = ["one"], run = [${many}] }`);
  assert.throws(() => buildPlan(found, "two"), /more than 25 commands/);
});

test("a simple script's trust hash does not change; a pipeline's covers how it is put together", () => {
  const tools = { widget: "acme/widget@1.0.0" };
  const simple = buildPlan(file(tempDir(), `build = "widget a"`), "build");
  assert.equal(planShape(simple), undefined);
  assert.equal(definitionHash([["widget", "a"]], tools, planShape(simple)), definitionHash([["widget", "a"]], tools));

  const sequential = buildPlan(file(tempDir(), `a = "widget a"\nb = "widget b"\nci = { depends = ["a", "b"] }`), "ci");
  const parallel = buildPlan(file(tempDir(), `a = "widget a"\nb = "widget b"\nci = { depends = ["a", "b"], parallel = true }`), "ci");
  const commands = [["widget", "a"], ["widget", "b"]];
  assert.notEqual(definitionHash(commands, tools, planShape(sequential)), definitionHash(commands, tools, planShape(parallel)));
});

// --- watching -----------------------------------------------------------------------------------

test("snapshots notice files that were added, changed and removed", () => {
  const directory = tempDir();
  fs.mkdirSync(path.join(directory, "src"));
  fs.mkdirSync(path.join(directory, "node_modules"));
  fs.writeFileSync(path.join(directory, "src", "a.lua"), "1");
  fs.writeFileSync(path.join(directory, "src", "b.lua"), "1");
  fs.writeFileSync(path.join(directory, "node_modules", "x.lua"), "1");

  const before = snapshot(["**/*.lua"], directory);
  assert.deepEqual([...before.keys()].sort(), ["src/a.lua", "src/b.lua"]);

  fs.writeFileSync(path.join(directory, "src", "a.lua"), "changed!");
  fs.rmSync(path.join(directory, "src", "b.lua"));
  fs.writeFileSync(path.join(directory, "src", "c.lua"), "1");
  assert.deepEqual(changesBetween(before, snapshot(["**/*.lua"], directory)), ["src/a.lua", "src/b.lua", "src/c.lua"]);
});

// --- running ------------------------------------------------------------------------------------

function installNodeAs(home) {
  const directory = path.join(home, "tools", "acme", "widget", "1.0.0");
  fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, `widget${EXE_SUFFIX}`);
  for (const link of [fs.linkSync, fs.symlinkSync]) {
    try {
      link(process.execPath, executable);
      return true;
    } catch (_err) {
      // Next kind of link.
    }
  }
  return false;
}

const CAN_LINK = (() => installNodeAs(tempDir()))();
const RUNS = { skip: !CAN_LINK && "this machine can't link node" };

const WRITE = (name, text) => `widget -e "require('fs').appendFileSync('${name}', '${text}\\n')"`;

async function inProject(scripts, run) {
  const home = tempDir();
  const project = tempDir();
  const saved = { home: process.env.SOF_HOME, trust: process.env.SOF_TRUST_SCRIPTS, cwd: process.cwd(), code: process.exitCode };
  process.env.SOF_HOME = home;
  delete process.env.SOF_TRUST_SCRIPTS;
  installNodeAs(home);
  fs.writeFileSync(path.join(project, "sof.toml"), `[tools]\nwidget = "acme/widget@1.0.0"\n\n[scripts]\n${scripts}\n`);
  process.chdir(project);
  try {
    await run({ project, marker: (name) => (fs.existsSync(path.join(project, name)) ? fs.readFileSync(path.join(project, name), "utf8") : null) });
  } finally {
    process.chdir(saved.cwd);
    process.exitCode = saved.code;
    process.env.SOF_HOME = saved.home;
    if (saved.home === undefined) delete process.env.SOF_HOME;
    if (saved.trust !== undefined) process.env.SOF_TRUST_SCRIPTS = saved.trust;
  }
}

const deps = (answer = true) => {
  const asked = [];
  return { asked, interactive: () => true, ask: async (question) => (asked.push(question), answer) };
};

test("dependencies run once, in order, before the script's own commands; one question covers all", RUNS, async () => {
  const scripts = [
    `base = ${JSON.stringify(WRITE("log.txt", "base"))}`,
    `lint = { depends = ["base"], run = ${JSON.stringify(WRITE("log.txt", "lint"))} }`,
    `test = { depends = ["base"], run = ${JSON.stringify(WRITE("log.txt", "test"))} }`,
    `ci = { depends = ["lint", "test"], run = ${JSON.stringify(WRITE("log.txt", "ci"))} }`,
  ].join("\n");

  await inProject(scripts, async ({ marker }) => {
    const answers = deps();
    await capture(() => runScript(["ci"], answers));
    assert.equal(answers.asked.length, 1);
    assert.match(answers.asked[0], /\[base\]:\n.*\n {2}\[lint\], after base:/s);
    assert.equal(marker("log.txt"), "base\nlint\ntest\nci\n");
    assert.ok(!process.exitCode);
  });
});

test("a failing dependency stops everything after it", RUNS, async () => {
  const scripts = [
    `bad = "widget -e \\"process.exit(4)\\""`,
    `ci = { depends = ["bad"], run = ${JSON.stringify(WRITE("after.txt", "ran"))} }`,
  ].join("\n");
  await inProject(scripts, async ({ marker }) => {
    await capture(() => runScript(["ci"], deps()));
    assert.equal(process.exitCode, 4);
    assert.equal(marker("after.txt"), null);
  });
});

test("parallel dependencies all finish, and a failure among them fails the script", RUNS, async () => {
  const scripts = [
    `bad = "widget -e \\"process.exit(5)\\""`,
    `slow = "widget -e \\"setTimeout(() => require('fs').writeFileSync('slow.txt', 'done'), 300)\\""`,
    `ci = { depends = ["bad", "slow"], parallel = true, run = ${JSON.stringify(WRITE("after.txt", "ran"))} }`,
  ].join("\n");
  await inProject(scripts, async ({ marker }) => {
    await capture(() => runScript(["ci"], deps()));
    assert.equal(process.exitCode, 5);
    assert.equal(marker("slow.txt"), "done", "the other one was allowed to finish");
    assert.equal(marker("after.txt"), null);
  });
});

test("changing a script anywhere in the pipeline asks again", RUNS, async () => {
  await inProject(`a = ${JSON.stringify(WRITE("log.txt", "a"))}\nci = { depends = ["a"] }`, async ({ project }) => {
    const answers = deps();
    await capture(() => runScript(["ci"], answers));
    await capture(() => runScript(["ci"], answers));
    assert.equal(answers.asked.length, 1);

    const toml = path.join(project, "sof.toml");
    fs.writeFileSync(toml, fs.readFileSync(toml, "utf8").replace("log.txt", "other.txt"));
    await capture(() => runScript(["ci"], answers));
    assert.equal(answers.asked.length, 2);
    assert.match(answers.asked[1], /has changed since you trusted it/);
  });
});

test("arguments need a command of the script's own; --watch needs watch globs", RUNS, async () => {
  await inProject(`a = ${JSON.stringify(WRITE("log.txt", "a"))}\nci = { depends = ["a"] }`, async () => {
    await assert.rejects(() => runScript(["ci", "--flag"], deps()), /nothing to pass the arguments to/);
    await assert.rejects(() => runScript(["--watch", "a"], deps()), /no watch globs/);
  });
});

test("--watch runs again when a watched file changes, and stops when the pipeline is edited", RUNS, async () => {
  const scripts = `w = { run = ${JSON.stringify(WRITE("log.txt", "run"))}, watch = ["src/**"] }`;
  await inProject(scripts, async ({ project, marker }) => {
    fs.mkdirSync(path.join(project, "src"));
    fs.writeFileSync(path.join(project, "src", "a.txt"), "1");
    let waits = 0;
    const watching = {
      ...deps(),
      watch: {
        snapshot: require("../src/scripts/watch").snapshot,
        waitForChange: async (globs, directory) => {
          waits += 1;
          if (waits === 2) {
            const toml = path.join(directory, "sof.toml");
            fs.writeFileSync(toml, fs.readFileSync(toml, "utf8").replace("log.txt", "other.txt"));
          }
          return { files: ["src/a.txt"], snapshot: new Map() };
        },
      },
    };

    const output = await capture(() => runScript(["--watch", "w"], watching));
    assert.equal(marker("log.txt"), "run\nrun\n", "ran at the start and once after the first change");
    assert.equal(waits, 2);
    assert.match(output, /src\/a\.txt changed/);
    assert.match(output, /no longer the pipeline you trusted/);
    assert.equal(process.exitCode, 1);
  });
});

test("waitForChange reports a change once the writes settle, and stops when asked", async () => {
  const { snapshot, waitForChange } = require("../src/scripts/watch");
  const directory = tempDir();
  fs.writeFileSync(path.join(directory, "a.txt"), "1");
  const before = snapshot(["*.txt"], directory);
  setTimeout(() => fs.writeFileSync(path.join(directory, "a.txt"), "two"), 30);
  const change = await waitForChange(["*.txt"], directory, before, { intervalMs: 20, settleMs: 20 });
  assert.deepEqual(change.files, ["a.txt"]);

  let stop = false;
  setTimeout(() => (stop = true), 60);
  assert.equal(await waitForChange(["*.txt"], directory, change.snapshot, { intervalMs: 20, shouldStop: () => stop }), null);
});
