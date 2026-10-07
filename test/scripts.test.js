"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runScript } = require("../src/commands/script");
const { findScript, findScriptsTable, parseScript, readScriptsFile, splitCommand } = require("../src/scripts/parse");
const { resolveScript, scriptEnvironment } = require("../src/scripts/runner");
const { definitionHash, trust, trustStatus, untrust } = require("../src/scripts/trust");
const { currentPlatform, writeToolsLock } = require("../src/tools/lock");
const { binDirectory, EXE_SUFFIX } = require("../src/tools/store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-scripts-test-"));
}

async function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function capture(run) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...parts) => lines.push(parts.join(" "));
  console.warn = (...parts) => lines.push(parts.join(" "));
  console.error = (...parts) => lines.push(parts.join(" "));
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines.join("\n");
}

// --- splitting a command ------------------------------------------------------------------------

test("a command is split into arguments the way a person would read it", () => {
  assert.deepEqual(splitCommand("rojo build -o game.rbxl"), ["rojo", "build", "-o", "game.rbxl"]);
  assert.deepEqual(splitCommand("  rojo   build\t-o   game.rbxl  "), ["rojo", "build", "-o", "game.rbxl"]);
  assert.deepEqual(splitCommand('rojo build -o "my game.rbxl"'), ["rojo", "build", "-o", "my game.rbxl"]);
  assert.deepEqual(splitCommand("stylua --glob 'src/**/*.luau'"), ["stylua", "--glob", "src/**/*.luau"]);
  assert.deepEqual(splitCommand('rojo build --output="my game.rbxl"'), ["rojo", "build", "--output=my game.rbxl"]);
  assert.deepEqual(splitCommand("lune run x \"\""), ["lune", "run", "x", ""], "an empty quoted argument is kept");
  assert.deepEqual(splitCommand(`lune run x "say 'hi'" 'say "hi"'`), ["lune", "run", "x", "say 'hi'", 'say "hi"']);
  assert.deepEqual(splitCommand("selene src\\Server"), ["selene", "src\\Server"], "a backslash is always a backslash");
  assert.deepEqual(splitCommand('selene "C:\\Users\\me\\game\\"'), ["selene", "C:\\Users\\me\\game\\"]);
  assert.deepEqual(splitCommand("stylua src/**/*.luau ~/x"), ["stylua", "src/**/*.luau", "~/x"], "no globbing or ~ expansion");
});

test("what a shell would act on is refused instead of being passed along as text", () => {
  for (const [text, character] of [
    ["rojo build && echo done", "&"],
    ["rojo build | tee log", "|"],
    ["rojo build; rm -rf .", ";"],
    ["rojo build > out.txt", ">"],
    ["rojo build < in.txt", "<"],
    ["rojo build $HOME", "$"],
    ["rojo build `whoami`", "`"],
    ["rojo build $(whoami)", "$"],
    ["rojo build (x)", "("],
    ["rojo build %PATH%", "%"],
    ["rojo build # a comment", "#"],
  ]) {
    assert.throws(() => splitCommand(text), (error) => error.message.includes(`"${character}"`) && /without a shell/.test(error.message), text);
  }

  // The same characters are fine inside quotes, and # is fine inside a word.
  assert.deepEqual(splitCommand('lune run x "a && b | c; $d `e` %f% (g) > h"'), ["lune", "run", "x", "a && b | c; $d `e` %f% (g) > h"]);
  assert.deepEqual(splitCommand("rojo build --id=a#b"), ["rojo", "build", "--id=a#b"]);

  assert.throws(() => splitCommand('rojo "build'), /quote that is never closed/);
  assert.throws(() => splitCommand("   "), /is empty/);
});

// --- scripts ------------------------------------------------------------------------------------

test("invisible and control characters are refused, so the prompt can't show something else than what runs", () => {
  for (const [character, code] of [
    ["\n", "000A"], ["\r", "000D"], ["\u001b", "001B"], ["\u0000", "0000"], ["\u007f", "007F"], ["\u0085", "0085"],
    ["​", "200B"], ["‮", "202E"], ["⁦", "2066"], [" ", "2028"], ["﻿", "FEFF"],
  ]) {
    assert.throws(() => splitCommand(`rojo build ${character}x`), new RegExp(`invisible or control character \\(U\\+${code}\\)`), code);
    assert.throws(() => splitCommand(`rojo build "a${character}b"`), /invisible or control character/, `${code} inside quotes`);
    assert.throws(() => parseScript("x", `rojo build ${character}x`), /invisible or control character/);
  }

  // Ordinary text, including a tab, a non-breaking space and accents, is fine.
  assert.deepEqual(splitCommand("rojo\tbuild café"), ["rojo", "build", "café"]);
});

test("the command shown is rebuilt from the arguments that will run", () => {
  const { formatCommand } = require("../src/scripts/parse");

  assert.equal(formatCommand(["rojo", "build", "-o", "game.rbxl"]), "rojo build -o game.rbxl");
  assert.equal(formatCommand(["lune", "run", "my script.luau", ""]), 'lune run "my script.luau" ""');
  assert.equal(formatCommand(["x", 'say "hi"']), "x 'say \"hi\"'");
  assert.equal(formatCommand(["x", `a'b"c`]), 'x "a\'b\\"c"');
  assert.equal(formatCommand(["selene", "src\\Server", "src/**/*.luau"]), "selene src\\Server src/**/*.luau");

  // What was typed in odd ways is normalized: the display is the argv, not the source text.
  const script = parseScript("x", "rojo   build\t'a b'");
  assert.equal(script.commands[0].text, 'rojo build "a b"');
  assert.deepEqual(script.commands[0].argv, ["rojo", "build", "a b"]);
});

test("a script is a command or a list of commands, and runs a tool by its bare name", () => {
  assert.deepEqual(parseScript("build", "rojo build").commands.map((command) => command.argv), [["rojo", "build"]]);
  assert.deepEqual(
    parseScript("check", ["stylua --check src", "selene src"]).commands.map((command) => command.text),
    ["stylua --check src", "selene src"]
  );
  assert.equal(parseScript("sof", "sof run install").name, "sof", "any name is fine unless it is a subcommand");
  assert.equal(parseScript("a:b-c.d_e", "rojo build").name, "a:b-c.d_e");
});

test("a script can't name a path or a program that isn't a tool", () => {
  for (const program of ["./build.sh", ".\\build.cmd", "../x", "..\\x", "C:\\Windows\\System32\\cmd.exe", "/bin/sh", "tools/rojo", "-rf", ".hidden"]) {
    assert.throws(() => parseScript("build", `${program} --x`), /not a path or another program/, program);
  }
});

test("script names and shapes are checked", () => {
  for (const name of ["list", "trust", "untrust", "help", "LIST"]) {
    assert.throws(() => parseScript(name, "rojo build"), /reserved/, name);
  }
  for (const name of ["", ".x", "-x", "a b", "a/b", "x".repeat(65)]) {
    assert.throws(() => parseScript(name, "rojo build"), /script name/, JSON.stringify(name));
  }

  assert.throws(() => parseScript("x", 5), /must be a command/);
  assert.throws(() => parseScript("x", []), /must be a command/);
  assert.throws(() => parseScript("x", [""]), /command 1 must be a non-empty string/);
  assert.throws(() => parseScript("x", ["rojo build", 7]), /command 2 must be a non-empty string/);
  assert.throws(() => parseScript("x", ["rojo build", "selene src && x"]), /script "x", command 2 contains "&"/);
});

test("a script is small enough to read in full when you are asked about it", () => {
  assert.doesNotThrow(() => parseScript("x", Array(25).fill("rojo build")));
  assert.throws(() => parseScript("x", Array(26).fill("rojo build")), /more than 25 commands/);

  assert.doesNotThrow(() => parseScript("x", `rojo ${"a".repeat(990)}`));
  assert.throws(() => parseScript("x", `rojo ${"a".repeat(1001)}`), /longer than 1000/);
  assert.throws(() => parseScript("x", `rojo "${"a b ".repeat(300)}"`), /longer than 1000/, "measured as it is shown, quotes included");

  // Individually fine, too much together: 4 x ~900 characters.
  assert.throws(() => parseScript("x", Array(4).fill(`rojo ${"a".repeat(895)}`)), /longer than 3000 characters in all/);
  assert.doesNotThrow(() => parseScript("x", Array(3).fill(`rojo ${"a".repeat(895)}`)));
});

test("one broken script doesn't stop the others from being read", () => {
  const dir = tempDir();
  const file = path.join(dir, "sof.toml");
  fs.writeFileSync(
    file,
    '[scripts]\nbuild = "rojo build"\nbad = "rojo build && x"\nlist = "rojo build"\ncheck = ["stylua src", "selene src"]\n'
  );

  const read = readScriptsFile(file);
  assert.deepEqual(read.names, ["build", "bad", "list", "check"]);
  assert.deepEqual(Object.keys(read.scripts), ["build", "check"]);
  assert.deepEqual(read.problems.map((problem) => problem.name), ["bad", "list"]);
  assert.equal(read.directory, dir);
});

test("a script is found in the nearest sof.toml that defines it", () => {
  const root = tempDir();
  const nested = path.join(root, "packages", "ui");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, "sof.toml"), '[scripts]\nbuild = "rojo build"\nlint = "selene src"\n');
  fs.writeFileSync(path.join(root, "packages", "sof.toml"), '[scripts]\nbuild = "rojo build packages.project.json"\n');

  assert.equal(findScript("build", nested).directory, path.join(root, "packages"));
  assert.equal(findScript("lint", nested).directory, root, "falls through to a folder above");
  assert.equal(findScript("nothing", nested), null);
  assert.equal(findScriptsTable(nested).directory, path.join(root, "packages"));
});

// --- trust --------------------------------------------------------------------------------------

test("a yes covers one script of one folder, and only exactly what it does", async () => {
  await withEnv({ SOF_HOME: tempDir() }, () => {
    const project = tempDir();
    const other = tempDir();
    const hash = definitionHash([["rojo", "build"]], { rojo: "rojo-rbx/rojo@7.6.1" });

    assert.equal(trustStatus(project, "build", hash), "untrusted");
    trust(project, "build", hash);
    assert.equal(trustStatus(project, "build", hash), "trusted");
    assert.equal(trustStatus(other, "build", hash), "untrusted", "another folder doesn't inherit it");
    assert.equal(trustStatus(project, "lint", hash), "untrusted", "nor does another script");

    assert.notEqual(hash, definitionHash([["rojo", "build", "-o", "x"]], { rojo: "rojo-rbx/rojo@7.6.1" }));
    assert.notEqual(hash, definitionHash([["rojo", "build"]], { rojo: "evil/rojo@7.6.1" }), "a tool that now comes from elsewhere");
    assert.notEqual(hash, definitionHash([["rojo", "build"]], { rojo: "rojo-rbx/rojo@7.7.0" }));
    assert.notEqual(hash, definitionHash([["rojo", "build"], ["selene", "src"]], { rojo: "rojo-rbx/rojo@7.6.1" }));
    assert.equal(hash, definitionHash([["rojo", "build"]], { rojo: "rojo-rbx/rojo@7.6.1" }), "and it is stable");

    assert.equal(trustStatus(project, "build", definitionHash([["rojo", "build", "-o", "x"]], { rojo: "rojo-rbx/rojo@7.6.1" })), "changed");

    assert.equal(untrust(project, "lint"), 0);
    assert.equal(untrust(project, "build"), 1);
    assert.equal(trustStatus(project, "build", hash), "untrusted");
    trust(project, "a", hash);
    trust(project, "b", hash);
    assert.equal(untrust(project), 2);
  });
});

test("script names that are also properties of every object don't find trust that isn't there", async () => {
  await withEnv({ SOF_HOME: tempDir() }, () => {
    const project = tempDir();
    const hash = definitionHash([["rojo", "build"]], {});
    trust(project, "build", hash);

    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      assert.equal(trustStatus(project, name, hash), "untrusted", name);
      assert.equal(untrust(project, name), 0, name);
    }
    assert.equal(trustStatus(project, "build", hash), "trusted", "and trust that is there is untouched");
  });
});

test("a damaged trust file means nothing is trusted, never everything", async () => {
  const home = tempDir();
  await withEnv({ SOF_HOME: home }, () => {
    const project = tempDir();
    const hash = definitionHash([["rojo", "build"]], {});
    for (const text of ["not json", "[]", '{"projects": 5}', '{"projects": {"x": {"build": 3}}}']) {
      fs.writeFileSync(path.join(home, "script-trust.json"), text);
      assert.equal(trustStatus(project, "build", hash), "untrusted", text);
    }
  });
});

// --- running ------------------------------------------------------------------------------------

// A tool that is really node: `widget -e "..."` runs node, so a script has something real to start.
function installNodeAs(home, owner, repo, version) {
  const directory = path.join(home, "tools", owner, repo, version);
  fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, `${repo}${EXE_SUFFIX}`);
  for (const link of [fs.linkSync, fs.symlinkSync]) {
    try {
      link(process.execPath, executable);
      return executable;
    } catch (_err) {
      // Try the next kind of link.
    }
  }
  return null;
}

// Whether this machine lets a test make a link to node (symbolic links need Developer Mode on Windows).
const CAN_LINK_NODE = (() => {
  const probe = tempDir();
  return installNodeAs(probe, "acme", "probe", "1.0.0") !== null;
})();
const RUNS = { skip: !CAN_LINK_NODE && "this machine can't link node.exe" };

// Runs `run` in a project folder with a node-as-widget tool installed and pinned in sof.toml, and
// the given [scripts]. The scripts leave marker files in the project, because a tool's stdout would
// land in the test runner's own output.
async function inProject(scripts, run) {
  const home = tempDir();
  const project = tempDir();
  const previousDirectory = process.cwd();
  const previousExitCode = process.exitCode;

  await withEnv({ SOF_HOME: home, SOF_TRUST_SCRIPTS: undefined }, async () => {
    installNodeAs(home, "acme", "widget", "1.0.0");

    fs.writeFileSync(path.join(project, "sof.toml"), `[tools]\nwidget = "acme/widget@1.0.0"\n\n[scripts]\n${scripts}\n`);
    process.chdir(project);
    try {
      await run({ home, project, marker: (name) => (fs.existsSync(path.join(project, name)) ? fs.readFileSync(path.join(project, name), "utf8") : null) });
    } finally {
      process.chdir(previousDirectory);
      process.exitCode = previousExitCode;
    }
  });
}

const WRITE = (file, expression) => `widget -e "require('fs').appendFileSync('${file}', ${expression} + '\\n')"`;

function deps({ interactive = true, answer = true } = {}) {
  const asked = [];
  return {
    asked,
    interactive: () => interactive,
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
  };
}

test("a trusted script runs from the project folder; extra arguments go on the last command", RUNS, async () => {
  const scripts = `build = [${JSON.stringify(WRITE("one.txt", "process.argv.slice(1).join(',')"))}, ${JSON.stringify(WRITE("two.txt", "process.cwd() + '|' + process.argv.slice(1).join(',')"))}]`;
  await inProject(scripts, async ({ project, marker }) => {
    const answers = deps();
    const subfolder = path.join(project, "deep", "folder");
    fs.mkdirSync(subfolder, { recursive: true });
    process.chdir(subfolder);

    await capture(() => runScript(["build", "extra", "a b"], answers));
    assert.equal(answers.asked.length, 1, "asked once");
    assert.match(answers.asked[0], /hasn't been trusted yet.*\n {2}1\. widget -e .*\n {2}2\. widget -e .*\nwith these tools: widget = acme\/widget@1\.0\.0/s);

    assert.equal(marker("one.txt"), "\n", "the first command got no extra arguments");
    const [cwd, args] = marker("two.txt").trim().split("|");
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(project), "run from the folder of the sof.toml, not where you were");
    assert.equal(args, "extra,a b");
    assert.ok(!process.exitCode);

    // Trusted now: no second question. A leading -- only separates; a later one is passed on.
    await capture(() => runScript(["build", "--", "x", "--", "y"], answers));
    assert.equal(answers.asked.length, 1);
    assert.equal(marker("two.txt").trim().split("\n").pop().split("|")[1], "x,--,y");
  });
});

test("a failing step stops the script and its exit code is the script's", RUNS, async () => {
  const scripts = `check = ["widget -e \\"process.exit(3)\\"", ${JSON.stringify(WRITE("after.txt", "'ran'"))}]`;
  await inProject(scripts, async ({ marker }) => {
    const output = await capture(() => runScript(["check"], deps()));
    assert.equal(process.exitCode, 3);
    assert.match(output, /exited with 3 \(step 1 of 2\); nothing after it ran/);
    assert.equal(marker("after.txt"), null);
  });
});

test("without a terminal an untrusted script is refused and nothing runs", RUNS, async () => {
  const scripts = `build = ${JSON.stringify(WRITE("ran.txt", "'ran'"))}`;
  await inProject(scripts, async ({ marker }) => {
    const answers = deps({ interactive: false });
    await assert.rejects(
      capture(() => runScript(["build"], answers)),
      (error) =>
        /hasn't been trusted yet.*so it wasn't run.*ask the user to say yes in their own terminal: sof run script trust build/s.test(error.message) &&
        !/SOF_TRUST_SCRIPTS/.test(error.message) // what an agent reads must not hand it the way around
    );
    assert.equal(answers.asked.length, 0);
    assert.equal(marker("ran.txt"), null);

    // CI you control can opt out of the check; the variable has to be exactly 1.
    await withEnv({ SOF_TRUST_SCRIPTS: "yes" }, () => assert.rejects(capture(() => runScript(["build"], answers)), /wasn't run/));
    await withEnv({ SOF_TRUST_SCRIPTS: "1" }, () => capture(() => runScript(["build"], answers)));
    assert.equal(marker("ran.txt"), "ran\n");
  });
});

test("saying no runs nothing and trusts nothing", RUNS, async () => {
  const scripts = `build = ${JSON.stringify(WRITE("ran.txt", "'ran'"))}`;
  await inProject(scripts, async ({ marker, project }) => {
    const no = deps({ answer: false });
    const output = await capture(() => runScript(["build"], no));
    assert.match(output, /Not trusted: nothing was run/);
    assert.equal(process.exitCode, 1);
    assert.equal(marker("ran.txt"), null);

    process.exitCode = undefined;
    const yes = deps();
    await capture(() => runScript(["build"], yes));
    assert.equal(yes.asked.length, 1, "asked again, because the no was not remembered");
    assert.equal(marker("ran.txt"), "ran\n");
    assert.equal(fs.existsSync(path.join(project, "sof.toml")), true);
  });
});

test("changing the script, or the tool it runs, asks again", RUNS, async () => {
  const scripts = `build = ${JSON.stringify(WRITE("ran.txt", "'one'"))}`;
  await inProject(scripts, async ({ home, project, marker }) => {
    const answers = deps();
    await capture(() => runScript(["build"], answers));
    assert.equal(answers.asked.length, 1);

    // A git pull rewrites the script.
    fs.writeFileSync(path.join(project, "sof.toml"), `[tools]\nwidget = "acme/widget@1.0.0"\n\n[scripts]\nbuild = ${JSON.stringify(WRITE("ran.txt", "'two'"))}\n`);
    await capture(() => runScript(["build"], answers));
    assert.equal(answers.asked.length, 2);
    assert.match(answers.asked[1], /has changed since you trusted it/);
    assert.equal(marker("ran.txt"), "one\ntwo\n");

    // The script is untouched but [tools] now pins another version (or repository) of the tool.
    installNodeAs(home, "acme", "widget", "2.0.0");
    fs.writeFileSync(path.join(project, "sof.toml"), `[tools]\nwidget = "acme/widget@2.0.0"\n\n[scripts]\nbuild = ${JSON.stringify(WRITE("ran.txt", "'two'"))}\n`);
    await capture(() => runScript(["build"], answers));
    assert.equal(answers.asked.length, 3, "a different tool version needs a new yes");
    assert.match(answers.asked[2], /widget = acme\/widget@2\.0\.0/);
  });
});

test("only tools from [tools] (and sof) can run: nothing is looked up on PATH, and nothing runs before a problem is found", RUNS, async () => {
  // A program that really is on PATH. It never starts: a script can't name it.
  const decoyDirectory = tempDir();
  fs.writeFileSync(path.join(decoyDirectory, `decoy${EXE_SUFFIX}`), "not started");

  const scripts = [
    `viaPath = "decoy -e 1"`,
    `shell = [${JSON.stringify(WRITE("first.txt", "'ran'"))}, "sh -c x"]`,
    `node = "node -e 1"`,
  ].join("\n");

  await inProject(scripts, async ({ marker }) => {
    await withEnv({ PATH: [decoyDirectory, process.env.PATH].join(path.delimiter) }, async () => {
      await assert.rejects(capture(() => runScript(["viaPath"], deps())), /"decoy" isn't listed under \[tools\]/);
      await assert.rejects(capture(() => runScript(["node"], deps())), /"node" isn't listed under \[tools\]/);

      const answers = deps();
      await assert.rejects(capture(() => runScript(["shell"], answers)), /"sh" isn't listed under \[tools\]/);
      assert.equal(marker("first.txt"), null, "the valid first command didn't run before the invalid second one was found");
      assert.equal(answers.asked.length, 0, "and the user wasn't asked about a script that can't run");
    });
  });
});

test("a script can ask sof to set the project up, and nothing that signs in, publishes or runs other code", () => {
  const home = tempDir();
  return withEnv({ SOF_HOME: home }, () => {
    const resolve = (text) => resolveScript(parseScript("x", text), home);

    for (const allowed of [
      "sof run install",
      "sof run install --force",
      "sof run package install --frozen",
      "sof run package check",
      "sof run package outdated",
      "sof run package search wally",
      "sof run tools install",
      "sof run tools list",
      "sof run tools doctor",
      "sof run tools lock",
    ]) {
      const { steps } = resolve(allowed);
      assert.equal(steps[0].executable, process.execPath, allowed);
      assert.equal(steps[0].args.slice(1).join(" "), allowed.split(" ").slice(1).join(" "), allowed);
    }

    // Only flags after the command: a value could be a path to some other project's files.
    for (const allowed of ["sof run tools which rojo", "sof run tools which luau-lsp", "sof run package search a/b wally", "sof run install -f", "sof run tools install --global --locked"]) {
      assert.doesNotThrow(() => resolve(allowed), allowed);
    }
    for (const refused of [
      "sof run install \\\\\\\\evil\\\\share\\\\sof.toml",
      "sof run install //evil/share/sof.toml",
      "sof run install ../other/sof.toml",
      "sof run install sof.toml",
      "sof run install --force extra",
      "sof run package install ..\\\\other",
      "sof run package check C:\\\\x\\\\sof.toml",
      "sof run tools doctor //host/share/sof.toml",
      "sof run tools lock ../../other/sof.toml",
      "sof run tools which ../rojo",
      "sof run tools which rojo.toml",
      "sof run tools install --config=x",
    ]) {
      assert.throws(() => resolve(refused), /(a script can pass only flags|isn't accepted)/, refused);
    }

    for (const refused of [
      "sof run package publish",
      "sof run package login",
      "sof run package owner add scope user",
      "sof run package yank a/b 1.0.0",
      "sof run package",
      "sof run tools x evil/tool",
      "sof run tools add evil/tool",
      "sof run tools rokit",
      "sof run addon add evil",
      "sof run account login",
      "sof run self update",
      "sof run uploader",
      "sof run script build",
      "sof --version",
      "sof install",
      "sof",
      "sof run",
      "SOF run constructor",
      "sof run __proto__",
    ]) {
      assert.throws(() => resolve(refused), /a script can ask sof only to set the project up/, refused);
    }
  });
});

test("a tool that isn't installed is reported with the fix", RUNS, async () => {
  await inProject(`build = "widget -e 1"`, async ({ home }) => {
    fs.rmSync(path.join(home, "tools"), { recursive: true });
    await assert.rejects(capture(() => runScript(["build"], deps())), /widget 1\.0\.0 isn't installed yet\. Run: sof run tools install/);
  });
});

test("a tool that doesn't match sof.tools.lock isn't started from a script", RUNS, async () => {
  await inProject(`build = ${JSON.stringify(WRITE("ran.txt", "'ran'"))}`, async ({ home, project, marker }) => {
    const spec = path.join(home, "tools", "acme", "widget", "1.0.0");
    fs.writeFileSync(path.join(spec, ".sof-install.json"), JSON.stringify({ asset: "widget.zip", sha256: "a".repeat(64) }));
    writeToolsLock(path.join(project, "sof.tools.lock"), [
      { name: "acme/widget", version: "1.0.0", platform: currentPlatform(), asset: "widget.zip", sha256: "b".repeat(64) },
    ]);

    await assert.rejects(capture(() => runScript(["build"], deps())), /doesn't match sof\.tools\.lock, so it isn't started/);
    assert.equal(marker("ran.txt"), null);

    writeToolsLock(path.join(project, "sof.tools.lock"), [
      { name: "acme/widget", version: "1.0.0", platform: currentPlatform(), asset: "widget.zip", sha256: "a".repeat(64) },
    ]);
    await capture(() => runScript(["build"], deps()));
    assert.equal(marker("ran.txt"), "ran\n");
  });
});

test("scripts run with sof's shim folder first on PATH", RUNS, async () => {
  await inProject(`build = ${JSON.stringify(WRITE("path.txt", "process.env.PATH.split(require('path').delimiter)[0]"))}`, async ({ marker }) => {
    await capture(() => runScript(["build"], deps()));
    assert.equal(marker("path.txt").trim(), binDirectory());
  });

  const environment = scriptEnvironment({ Path: "C:\\a", OTHER: "x" });
  assert.deepEqual(Object.keys(environment).sort(), ["OTHER", "Path"], "the existing spelling of PATH is kept, not duplicated");
  assert.ok(environment.Path.endsWith("C:\\a"));
});

test("an unknown script, and a script with a problem, are explained", RUNS, async () => {
  await inProject(`build = "widget -e 1"\nbroken = "widget -e 1 && x"\n`, async () => {
    await assert.rejects(capture(() => runScript(["nope"], deps())), /There is no script "nope".*sof run script list/);
    await assert.rejects(capture(() => runScript(["broken"], deps())), /script "broken" contains "&"/);
  });
});

test("trust needs a terminal, and untrust doesn't", RUNS, async () => {
  await inProject(`build = "widget -e 1"\nlint = "widget -e 2"\n`, async () => {
    await assert.rejects(capture(() => runScript(["trust", "build"], deps({ interactive: false }))), /needs a terminal, on purpose.*sof run script trust build/s);

    const answers = deps();
    const output = await capture(() => runScript(["trust"], answers));
    assert.equal(answers.asked.length, 2, "one question per script");
    assert.match(output, /Trusted "build"\.\nTrusted "lint"\./);

    assert.match(await capture(() => runScript(["trust", "build"], deps())), /"build" is already trusted/);
    await assert.rejects(capture(() => runScript(["trust", "nope"], deps())), /no script "nope"/);

    assert.match(await capture(() => runScript(["untrust", "build"], deps({ interactive: false }))), /Removed your trust from 1 script/);
    assert.match(await capture(() => runScript(["untrust", "build"], deps())), /None of those scripts was trusted/);
    assert.match(await capture(() => runScript(["untrust"], deps())), /Removed your trust from 1 script/);

    const refused = deps({ answer: false });
    assert.match(await capture(() => runScript(["trust", "lint"], refused)), /Left "lint" untrusted/);
  });
});

test("list shows each script's state", RUNS, async () => {
  await inProject(`build = "widget -e 1"\ncheck = ["widget -e 1", "widget -e 2"]\nbad = "widget -e 1 && x"\nmissing = "ghost run"\n`, async () => {
    await capture(() => runScript(["trust", "build"], deps()));
    const output = await capture(() => runScript(["list"], deps()));

    assert.match(output, /build +trusted +widget -e 1\n/);
    assert.match(output, /check +not trusted +widget -e 1 \(\+1 more\)/);
    assert.match(output, /bad +can't run: .*contains "&"/);
    assert.match(output, /missing +can't run: .*"ghost" isn't listed under \[tools\]/);
  });
});

test("a [tools] entry named like a shell or system program is not a tool for a script either", () => {
  const home = tempDir();
  const project = tempDir();
  fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nsh = "evil/sh@1.0.0"\npowershell = "evil/powershell@1.0.0"\ngit = "evil/git@1.0.0"\n');

  return withEnv({ SOF_HOME: home }, () => {
    for (const program of ["sh", "powershell", "git"]) {
      assert.throws(() => resolveScript(parseScript("x", `${program} -c x`), project), /reserved/, program);
    }
  });
});

test("text from a repository's files is shown without terminal control sequences", async () => {
  const { safeText } = require("../src/safe-text");

  assert.equal(safeText("plain text\nwith a line\tand a tab"), "plain text\nwith a line\tand a tab");
  assert.equal(safeText("a\u001b[2Jb"), "a\\u{1b}[2Jb");
  assert.equal(safeText("x\u001b]52;c;QUJD\u0007y"), "x\\u{1b}]52;c;QUJD\\u{7}y");
  assert.equal(safeText("a\rb‮c​d e"), "a\\u{d}b\\u{202e}c\\u{200b}d\\u{2028}e");
  assert.equal(safeText("café ✓"), "café ✓");

  // A script name made of an escape sequence is listed escaped, never sent to the terminal as it is.
  const project = tempDir();
  fs.writeFileSync(path.join(project, "sof.toml"), '[scripts]\n"x\\u001b[2J\\u001b]52;c;QUJD\\u0007y" = "rojo build"\nbuild = "rojo build"\n');
  const previous = process.cwd();
  process.chdir(project);
  try {
    const output = await withEnv({ SOF_HOME: tempDir() }, () => capture(() => runScript(["list"], deps())));
    assert.doesNotMatch(output, /[\u001b\u0007]/);
    assert.match(output, /x\\u\{1b\}\[2J\\u\{1b\}\]52;c;QUJD\\u\{7\}y +can't run/);
  } finally {
    process.chdir(previous);
  }

  // A TOML parse error quotes the offending line, escape characters included: the CLI cleans it.
  fs.writeFileSync(path.join(project, "sof.toml"), "[scripts]\nbuild = \"rojo\u001b[2J\u001b]52;c;QUJD\u0007\n");
  process.chdir(project);
  const savedExitCode = process.exitCode;
  try {
    const output = await capture(() => require("../src/cli").runCli(["run", "script", "list"]));
    assert.doesNotMatch(output, /[\u001b\u0007]/);
    assert.match(output, /^Error: /m);
  } finally {
    process.chdir(previous);
    process.exitCode = savedExitCode;
  }
});

test("end of input at the question (Ctrl-D, a closed pipe) is a no, not a silent success", () => {
  const { spawnSync } = require("child_process");
  const grants = path.join(__dirname, "..", "src", "account", "grants.js").replace(/\\/g, "/");
  const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(grants)}).ask("q? ").then((answer) => console.log("answer:" + answer))`], {
    input: "",
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /answer:false/, "the question settles with a no instead of the process just ending");
});

test("scripts never run just because a project is installed or sof starts", () => {
  // sof has no hook anywhere that starts a script: the only way in is `sof run script <name>`.
  const sources = ["src/cli.js", "src/commands/install.js", "src/commands/tools.js", "src/commands/package.js", "src/commands/self.js"].map((file) =>
    fs.readFileSync(path.join(__dirname, "..", file), "utf8")
  );
  for (const source of sources) {
    assert.doesNotMatch(source, /scripts\/runner|runSteps|resolveScript/);
  }
});
