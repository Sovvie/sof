"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

const { startServer, sendJson } = require("./helpers");
const { runTools, runToolsInstall, installConfiguredTools } = require("../src/commands/tools");
const { currentPlatform, readToolsLock } = require("../src/tools/lock");
const { readToolsFromConfig } = require("../src/tools/manifest");
const { runTool } = require("../src/tools/exec");
const { clearReplacedShims, ensureShims, findCsc, replaceFile, shScript } = require("../src/tools/shims");
const {
  EXE_SUFFIX,
  installTool,
  isToolInstalled,
  readInstallRecord,
  toolExecutablePath,
} = require("../src/tools/store");
const { parseToolSpecifier } = require("../src/tools/spec");

const PLATFORM_ASSETS = ["windows-x86_64", "windows-aarch64", "linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64"];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-tools-install-"));
}

async function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
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

function zipWith(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
}

// A stand-in for api.github.com. releases: { "owner/repo": [{ tag, content, digest? }] }, oldest first.
async function startGithub(releases) {
  const downloads = new Map();
  let nextId = 1;

  const server = await startServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const download = /^\/download\/(\d+)\/(.+)$/.exec(url.pathname);
    if (download) {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(downloads.get(download[1]));
      return;
    }

    const match = /^\/repos\/([^/]+)\/([^/]+)\/releases(?:\/(latest)|\/tags\/([^/]+))?$/.exec(url.pathname);
    const list = match ? releases[`${match[1]}/${match[2]}`] : null;
    if (!list) {
      sendJson(response, 404, { message: "Not Found" });
      return;
    }

    const describe = (release) => {
      const buffer = release.archive || zipWith({ [`${match[2]}${EXE_SUFFIX}`]: release.content || "BINARY" });
      const assets = PLATFORM_ASSETS.map((suffix) => {
        const id = String(nextId++);
        downloads.set(id, buffer);
        return {
          name: `${match[2]}-${release.tag.replace(/^v/, "")}-${suffix}.zip`,
          size: buffer.length,
          digest: release.digest === undefined ? `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}` : release.digest,
          browser_download_url: `${server.url}/download/${id}/asset.zip`,
        };
      });
      return { tag_name: release.tag, assets };
    };

    if (match[3]) {
      sendJson(response, 200, describe(list[list.length - 1]));
    } else if (match[4]) {
      const release = list.find((candidate) => candidate.tag === decodeURIComponent(match[4]));
      release ? sendJson(response, 200, describe(release)) : sendJson(response, 404, { message: "Not Found" });
    } else {
      sendJson(response, 200, list.map(describe));
    }
  });

  return server;
}

async function withEnvironment(releases, run) {
  const server = await startGithub(releases);
  const home = tempDir();
  const rokit = tempDir();
  try {
    return await withEnv(
      { SOF_HOME: home, ROKIT_ROOT: rokit, SOF_GITHUB_API_URL: server.url, GITHUB_TOKEN: "", GH_TOKEN: "", PATH: process.env.PATH },
      () => run({ server, home, rokit })
    );
  } finally {
    await server.close();
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// --- installing -------------------------------------------------------------------------------

test("installTool downloads the asset for this platform once and records where it came from", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0", content: "WIDGET-ONE" }] }, async ({ server }) => {
    const first = await installTool("acme/widget@1.0.0", { alias: "widget" });
    assert.equal(first.skipped, false);
    assert.equal(fs.readFileSync(toolExecutablePath(first.spec), "utf8"), "WIDGET-ONE");

    const record = readInstallRecord(first.spec);
    assert.equal(record.sha256, first.record.sha256);
    assert.match(record.asset, /^widget-1\.0\.0-(windows|linux|macos)-/);
    const archive = zipWith({ [`widget${EXE_SUFFIX}`]: "WIDGET-ONE" });
    assert.equal(record.sha256, sha256(archive));

    const requestsBefore = server.requests.length;
    const second = await installTool("acme/widget@1.0.0", { alias: "widget" });
    assert.equal(second.skipped, true);
    assert.equal(second.record.sha256, record.sha256);
    assert.equal(server.requests.length, requestsBefore, "an installed version makes no requests");

    const forced = await installTool("acme/widget@1.0.0", { force: true });
    assert.equal(forced.skipped, false);
    assert.equal(fs.readdirSync(path.dirname(toolExecutablePath(first.spec))).filter((name) => name.includes("partial")).length, 0);
  });
});

test("a version folder that lost its executable is repaired by a plain install", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0", content: "FRESH" }] }, async () => {
    const spec = parseToolSpecifier("acme/widget@1.0.0");
    const directory = path.dirname(toolExecutablePath(spec));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, ".sof-install.json"), '{"asset":"x","sha256":"y"}\n');
    fs.writeFileSync(path.join(directory, "leftover.txt"), "from an interrupted install");

    const result = await installTool(spec);
    assert.equal(result.skipped, false);
    assert.equal(fs.readFileSync(toolExecutablePath(spec), "utf8"), "FRESH");
    assert.equal(readInstallRecord(spec).sha256, result.record.sha256);
  });
});

test("a tool that is running can be reinstalled without losing its record", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const system = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const running = path.join(system, "ping.exe");
  if (!fs.existsSync(running)) {
    return;
  }

  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0", content: "NEW-BINARY" }] }, async () => {
    const spec = parseToolSpecifier("acme/widget@1.0.0");
    const executable = toolExecutablePath(spec);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(running, executable);

    const child = childProcess.spawn(executable, ["-n", "4", "127.0.0.1"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("close", resolve));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await installTool(spec, { force: true });

      assert.equal(fs.readFileSync(executable, "utf8"), "NEW-BINARY", "the new version is in place");
      assert.equal(readInstallRecord(spec).sha256, result.record.sha256, "and its record with it");
      assert.equal(fs.readdirSync(path.dirname(executable)).filter((name) => /\.old-/.test(name)).length, 1, "the running copy is parked");
    } finally {
      await exited;
    }

    await installTool(spec, { force: true });
    assert.equal(fs.readdirSync(path.dirname(executable)).filter((name) => /\.old-/.test(name)).length, 0, "and cleared by the next install");
  });
});

test("tags without a v, or with a name prefix, are found", async () => {
  await withEnvironment(
    {
      "acme/plain": [{ tag: "2.0.0" }],
      "acme/prefixed": [{ tag: "prefixed-v3.1.0" }, { tag: "prefixed-v3.2.0" }],
    },
    async () => {
      assert.equal((await installTool("acme/plain@2.0.0")).skipped, false);
      assert.equal((await installTool("acme/prefixed@3.1.0")).skipped, false);
      await assert.rejects(installTool("acme/plain@9.9.9"), /has no release "9\.9\.9"/);
      await assert.rejects(installTool("acme/missing@1.0.0"), /has no release/);
    }
  );
});

test("a download that doesn't match the checksum GitHub lists is refused and leaves nothing behind", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0", digest: `sha256:${"0".repeat(64)}` }] }, async () => {
    const spec = parseToolSpecifier("acme/widget@1.0.0");
    await assert.rejects(installTool(spec), /doesn't match the checksum GitHub lists/);
    assert.equal(isToolInstalled(spec), false);
    assert.equal(fs.existsSync(path.dirname(toolExecutablePath(spec))), false);
  });
});

test("an install is checked against sof.tools.lock, and a swapped release is refused", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0", content: "REAL" }] }, async () => {
    const spec = parseToolSpecifier("acme/widget@1.0.0");
    const real = sha256(zipWith({ [`widget${EXE_SUFFIX}`]: "REAL" }));

    const assetName = (await installTool(spec)).record.asset;
    fs.rmSync(path.dirname(toolExecutablePath(spec)), { recursive: true });

    await assert.rejects(
      installTool(spec, { expected: { asset: assetName, sha256: "f".repeat(64) } }),
      /doesn't match sof\.tools\.lock/
    );
    assert.equal(isToolInstalled(spec), false);

    const ok = await installTool(spec, { expected: { asset: assetName, sha256: real } });
    assert.equal(ok.skipped, false);

    // Present but with another checksum than the lock: redone, and refused if the download differs too.
    await assert.rejects(installTool(spec, { expected: { asset: assetName, sha256: "e".repeat(64) } }), /doesn't match sof\.tools\.lock/);
  });
});

test("a version Rokit already downloaded is copied, unless there is a lock to check it against", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0", content: "FROM-GITHUB" }] }, async ({ server, rokit }) => {
    const stored = path.join(rokit, "tool-storage", "acme", "widget", "1.0.0");
    fs.mkdirSync(stored, { recursive: true });
    fs.writeFileSync(path.join(stored, `widget${EXE_SUFFIX}`), "FROM-ROKIT");

    const imported = await installTool("acme/widget@1.0.0");
    assert.equal(imported.record, null);
    assert.equal(fs.readFileSync(toolExecutablePath(imported.spec), "utf8"), "FROM-ROKIT");
    assert.equal(server.requests.length, 0);

    // A copy from Rokit has no checksum to compare, so with a lock the tool is downloaded and checked
    // (this lock names an asset the server doesn't have, so it is refused).
    await assert.rejects(
      installTool("acme/widget@1.0.0", { expected: { asset: "widget-1.0.0-elsewhere.zip", sha256: "a".repeat(64) } }),
      /doesn't match sof\.tools\.lock/
    );
    assert.ok(server.requests.length > 0, "a locked tool is downloaded, not copied from Rokit");
  });
});

// --- the commands ----------------------------------------------------------------------------

async function inProject(run) {
  const project = tempDir();
  const previous = process.cwd();
  process.chdir(project);
  try {
    return await run(project);
  } finally {
    process.chdir(previous);
  }
}

test("install reads [tools], needs no rokit.toml and removes the one earlier sof versions generated", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0" }], "Kampfkarren/selene": [{ tag: "0.30.1" }] }, async ({ home }) => {
    await inProject(async (project) => {
      fs.writeFileSync(
        path.join(project, "sof.toml"),
        '[tools]\nwidget = "acme/widget@1.0.0"\nselene = "Kampfkarren/selene@0.30.1"\n'
      );
      fs.writeFileSync(
        path.join(project, "rokit.toml"),
        "# This file is auto-generated by Sof from [tools] in sof.toml.\n[tools]\nwidget = \"acme/widget@1.0.0\"\n"
      );

      const output = await capture(() => runToolsInstall(null, {}));
      assert.match(output, /Removed rokit\.toml/);
      assert.equal(fs.existsSync(path.join(project, "rokit.toml")), false);
      assert.equal(fs.existsSync(path.join(project, "selene.toml")), true, "known tool configs are still scaffolded");

      assert.equal(isToolInstalled(parseToolSpecifier("acme/widget@1.0.0")), true);
      const shim = path.join(home, "bin", process.platform === "win32" ? "widget.exe" : "widget");
      assert.equal(fs.existsSync(shim) || fs.existsSync(path.join(home, "bin", "widget.cmd")), true, "a shim was written");

      const again = await capture(() => runToolsInstall(null, {}));
      assert.match(again, /Tools are up to date \(2 installed\)/);
      assert.equal(fs.existsSync(path.join(project, "sof.tools.lock")), false, "no lockfile unless asked for");
    });
  });
});

test("a rokit.toml somebody wrote by hand is left alone", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0" }] }, async () => {
    await inProject(async (project) => {
      fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "acme/widget@1.0.0"\n');
      fs.writeFileSync(path.join(project, "rokit.toml"), '[tools]\nrojo = "rojo-rbx/rojo@7.6.1"\n');

      await capture(() => runToolsInstall(null, {}));
      assert.match(fs.readFileSync(path.join(project, "rokit.toml"), "utf8"), /rojo-rbx\/rojo/);
    });
  });
});

test("one failing tool doesn't stop the rest, and the failures are reported together", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0" }] }, async () => {
    await inProject(async (project) => {
      fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "acme/widget@1.0.0"\ngone = "acme/gone@1.0.0"\n');
      const config = readToolsFromConfig(path.join(project, "sof.toml"));

      await assert.rejects(capture(() => installConfiguredTools(config)), /1 tool\(s\) couldn't be installed:\n {2}gone: /);
      assert.equal(isToolInstalled(parseToolSpecifier("acme/widget@1.0.0")), true);
    });
  });
});

test("add resolves the latest release, writes [tools] and installs; --alias and @version work", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0" }, { tag: "v1.1.0" }] }, async () => {
    await inProject(async (project) => {
      fs.writeFileSync(path.join(project, "sof.toml"), '[[dependencies]]\npath = "Packages"\n');

      await capture(() => runTools(["add", "acme/widget"]));
      assert.equal(readToolsFromConfig(path.join(project, "sof.toml")).tools.widget, "acme/widget@1.1.0");
      assert.equal(isToolInstalled(parseToolSpecifier("acme/widget@1.1.0")), true);

      await capture(() => runTools(["add", "acme/widget@1.0.0", "--alias", "oldwidget"]));
      const tools = readToolsFromConfig(path.join(project, "sof.toml")).tools;
      assert.equal(tools.oldwidget, "acme/widget@1.0.0");
      assert.equal(tools.widget, "acme/widget@1.1.0");

      await assert.rejects(runTools(["add", "acme/widget", "--alias", "sof"]), /reserved/);
      assert.match(fs.readFileSync(path.join(project, "sof.toml"), "utf8"), /\[\[dependencies\]\]\npath = "Packages"/);
    });
  });
});

test("outdated shows what has a newer release; update moves only what was asked for", async () => {
  await withEnvironment(
    { "acme/widget": [{ tag: "v1.0.0" }, { tag: "v1.2.0" }], "acme/gadget": [{ tag: "v2.0.0" }] },
    async () => {
      await inProject(async (project) => {
        const file = path.join(project, "sof.toml");
        fs.writeFileSync(file, '[tools]\ngadget = "acme/gadget@2.0.0"\nwidget = "acme/widget@1.0.0"\n');

        const report = await capture(() => runTools(["outdated"]));
        assert.match(report, /widget {2}1\.0\.0 -> 1\.2\.0/);
        assert.match(report, /gadget {2}2\.0\.0 \(latest\)/);
        assert.equal(readToolsFromConfig(file).tools.widget, "acme/widget@1.0.0", "outdated changes nothing");

        await capture(() => runTools(["update", "--check"]));
        assert.equal(readToolsFromConfig(file).tools.widget, "acme/widget@1.0.0");

        await capture(() => runTools(["update", "widget"]));
        assert.equal(readToolsFromConfig(file).tools.widget, "acme/widget@1.2.0");
        assert.equal(isToolInstalled(parseToolSpecifier("acme/widget@1.2.0")), true);

        await assert.rejects(runTools(["update", "nope"]), /no tool "nope"/);
      });
    }
  );
});

test("a pinned version newer than the latest release isn't 'updated' backwards", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0" }] }, async () => {
    await inProject(async (project) => {
      fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "acme/widget@1.1.0-rc.1"\n');
      assert.match(await capture(() => runTools(["outdated"])), /widget {2}1\.1\.0-rc\.1 \(latest\)/);
    });
  });
});

test("import moves a rokit.toml's tools into sof.toml (creating it) and installs them", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0" }, { tag: "v1.1.0" }], "acme/gadget": [{ tag: "v2.0.0" }] }, async () => {
    await inProject(async (project) => {
      fs.writeFileSync(
        path.join(project, "rokit.toml"),
        '[tools]\nwidget = "acme/widget@1.0.0"\ngadget = "acme/gadget@2.0.0"\n'
      );

      const first = await capture(() => runTools(["import"]));
      assert.match(first, /\+ widget = "acme\/widget@1\.0\.0"/);
      assert.deepEqual(readToolsFromConfig(path.join(project, "sof.toml")).tools, {
        gadget: "acme/gadget@2.0.0",
        widget: "acme/widget@1.0.0",
      });
      assert.equal(isToolInstalled(parseToolSpecifier("acme/gadget@2.0.0")), true);
      assert.equal(fs.existsSync(path.join(project, "rokit.toml")), true, "the original is left alone");

      // Running it again changes nothing; a difference is reported and sof.toml wins.
      fs.writeFileSync(
        path.join(project, "rokit.toml"),
        '[tools]\nwidget = "acme/widget@1.1.0"\ngadget = "acme/gadget@2.0.0"\nextra = { gitlab = "a/b", version = "1.0.0" }\n'
      );
      const second = await capture(() => runTools(["import"]));
      assert.match(second, /= gadget \(already in sof\.toml\)/);
      assert.match(second, /! widget: sof\.toml has acme\/widget@1\.0\.0 and rokit\.toml has acme\/widget@1\.1\.0; kept sof\.toml's/);
      assert.match(second, /! extra skipped: it comes from GitLab/);
      assert.match(second, /Nothing new to import/);
      assert.equal(readToolsFromConfig(path.join(project, "sof.toml")).tools.widget, "acme/widget@1.0.0");

      await assert.rejects(runTools(["import", "nope.toml"]), /nope\.toml doesn't exist/);
    });

    await inProject(async () => {
      await assert.rejects(runTools(["import"]), /no rokit\.toml, aftman\.toml or foreman\.toml/);
    });
  });
});

test("global tools live in ~/.sof/tools.toml", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0" }] }, async ({ home }) => {
    await inProject(async () => {
      await capture(() => runTools(["add", "acme/widget", "--global"]));
      assert.equal(readToolsFromConfig(path.join(home, "tools.toml")).tools.widget, "acme/widget@1.0.0");
      assert.equal(isToolInstalled(parseToolSpecifier("acme/widget@1.0.0")), true);

      assert.match(await capture(() => runTools(["list", "--global"])), /widget {2}acme\/widget@1\.0\.0 {2}installed/);
      await capture(() => runTools(["remove", "widget", "--global"]));
      assert.deepEqual(readToolsFromConfig(path.join(home, "tools.toml")).tools, {});
    });
  });
});

test("lock records checksums, later installs are held to them, --locked needs them", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0", content: "ONE" }] }, async () => {
    await inProject(async (project) => {
      const file = path.join(project, "sof.toml");
      const lockPath = path.join(project, "sof.tools.lock");
      fs.writeFileSync(file, '[tools]\nwidget = "acme/widget@1.0.0"\n');

      await assert.rejects(capture(() => runToolsInstall(null, { locked: true })), /--locked needs sof\.tools\.lock/);

      await capture(() => runTools(["lock"]));
      const lock = readToolsLock(lockPath);
      assert.equal(lock.entries.length, 1);
      assert.equal(lock.entries[0].platform, currentPlatform());
      assert.equal(lock.entries[0].sha256, sha256(zipWith({ [`widget${EXE_SUFFIX}`]: "ONE" })));

      await capture(() => runToolsInstall(null, { locked: true }));

      // The release is swapped on the server after locking: a fresh machine must refuse it.
      fs.rmSync(path.join(process.env.SOF_HOME, "tools"), { recursive: true, force: true });
      const spec = parseToolSpecifier("acme/widget@1.0.0");
      const swapped = await startGithub({ "acme/widget": [{ tag: "v1.0.0", content: "TWO" }] });
      try {
        await withEnv({ SOF_GITHUB_API_URL: swapped.url }, async () => {
          await assert.rejects(capture(() => runToolsInstall(null, {})), /doesn't match sof\.tools\.lock/);
          assert.equal(isToolInstalled(spec), false);
        });
      } finally {
        await swapped.close();
      }

      // Without the swap it installs, and removing the tool prunes its line from the lock.
      await capture(() => runToolsInstall(null, {}));
      assert.equal(isToolInstalled(spec), true);
      await capture(() => runTools(["remove", "widget"]));
      assert.equal(readToolsLock(lockPath).entries.length, 0);
    });
  });
});

test("add and update check a version the lock already knows, and leave sof.toml alone when it doesn't match", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0" }, { tag: "v1.1.0", content: "NEWER" }] }, async () => {
    await inProject(async (project) => {
      const file = path.join(project, "sof.toml");
      fs.writeFileSync(file, '[tools]\nwidget = "acme/widget@1.0.0"\n');
      await capture(() => runTools(["lock"]));

      // The lock already holds a checksum for 1.1.0 on this platform, and the release doesn't match it.
      const lockPath = path.join(project, "sof.tools.lock");
      fs.appendFileSync(
        lockPath,
        `\n[[tool]]\nname = "acme/widget"\nversion = "1.1.0"\nplatform = "${currentPlatform()}"\nasset = "whatever.zip"\nsha256 = "${"d".repeat(64)}"\n`
      );

      await assert.rejects(capture(() => runTools(["update"])), /doesn't match sof\.tools\.lock/);
      assert.equal(readToolsFromConfig(file).tools.widget, "acme/widget@1.0.0", "sof.toml keeps its old pin");
      assert.equal(isToolInstalled(parseToolSpecifier("acme/widget@1.1.0")), false, "nothing unverified was installed");

      await assert.rejects(capture(() => runTools(["add", "acme/widget@1.1.0", "--alias", "widget2"])), /doesn't match sof\.tools\.lock/);
      assert.equal(readToolsFromConfig(file).tools.widget2, undefined);
      assert.equal(isToolInstalled(parseToolSpecifier("acme/widget@1.1.0")), false);
    });
  });
});

test("--locked fails when this platform has no checksum for a tool", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0" }], "acme/gadget": [{ tag: "v1.0.0" }] }, async () => {
    await inProject(async (project) => {
      fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "acme/widget@1.0.0"\n');
      await capture(() => runTools(["lock"]));

      fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "acme/widget@1.0.0"\ngadget = "acme/gadget@1.0.0"\n');
      await assert.rejects(capture(() => runToolsInstall(null, { locked: true })), /no .* checksum for: gadget/);
    });
  });
});

test("tools exec explains itself when it can't run something", async () => {
  await withEnvironment({}, async () => {
    await inProject(async (project) => {
      assert.match(await capture(async () => assert.equal(await runTool("widget", []), 1)), /"widget" isn't listed under \[tools\]/);

      fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "acme/widget@1.0.0"\n');
      assert.match(await capture(async () => assert.equal(await runTool("widget", []), 1)), /widget 1\.0\.0 isn't installed yet\. Run: sof run tools install/);

      fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "not a spec"\n');
      assert.match(await capture(async () => assert.equal(await runTool("widget", []), 1)), /must use "owner\/repo@version"/);
    });
  });
});

test("doctor reports tools that are missing, shadowed or fine, and sets the exit code", async () => {
  await withEnvironment({ "acme/widget": [{ tag: "v1.0.0" }] }, async ({ home }) => {
    await inProject(async (project) => {
      fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "acme/widget@1.0.0"\ngadget = "acme/gadget@1.0.0"\n');
      await capture(() => runToolsInstall(null, {})).catch(() => {});

      const previous = process.exitCode;
      try {
        const sofBin = path.join(home, "bin");
        const shadow = tempDir();
        fs.writeFileSync(path.join(shadow, process.platform === "win32" ? "gadget.exe" : "gadget"), "x");

        const report = await withEnv({ PATH: [shadow, sofBin, process.env.PATH].join(path.delimiter) }, () =>
          capture(() => runTools(["doctor"]))
        );
        assert.match(report, /✓ widget 1\.0\.0 is installed/);
        assert.match(report, /! gadget 1\.0\.0 isn't installed/);
        assert.match(report, /1 problem\(s\) found/);
        assert.equal(process.exitCode, 1);

        const clean = await withEnv({ PATH: [sofBin, process.env.PATH].join(path.delimiter) }, async () => {
          fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "acme/widget@1.0.0"\n');
          return capture(() => runTools(["doctor"]));
        });
        assert.match(clean, /No problems found/);
        assert.equal(process.exitCode, 0);

        // A copy of the tool that comes before sof's shim on PATH is called out.
        fs.writeFileSync(path.join(shadow, process.platform === "win32" ? "widget.exe" : "widget"), "x");
        const shadowed = await withEnv({ PATH: [shadow, sofBin, process.env.PATH].join(path.delimiter) }, () =>
          capture(() => runTools(["doctor"]))
        );
        assert.match(shadowed, /! widget 1\.0\.0 is installed, but "widget" runs .* first/);
      } finally {
        process.exitCode = previous;
      }
    });
  });
});

test("the old Rokit-only commands say what replaced them", async () => {
  await assert.rejects(runTools(["rokit", "list"]), /no longer bundles Rokit/);
  assert.match(await capture(() => runTools(["self-update"])), /no longer bundles Rokit/);
  await assert.rejects(runTools(["bogus"]), /Unknown tools command: bogus/);
});

// --- shims -----------------------------------------------------------------------------------

// A tool that is really node: `widget -p "..."` runs node, so a shim has something real to start.
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

const SHIMS_AVAILABLE = process.platform !== "win32" || findCsc() !== null;

test("a shim runs the version the current folder's sof.toml pins, with arguments and exit code intact", { skip: !SHIMS_AVAILABLE && "no C# compiler" }, async (t) => {
  const home = tempDir();
  const root = tempDir();

  await withEnv({ SOF_HOME: home }, async () => {
    if (!installNodeAs(home, "acme", "widget", "1.0.0") || !installNodeAs(home, "acme", "widget", "2.0.0")) {
      t.skip("couldn't link node.exe");
      return;
    }

    const result = ensureShims(["widget"]);
    assert.equal(result.kind, process.platform === "win32" ? "exe" : "sh");

    const oldProject = path.join(root, "old");
    const newProject = path.join(root, "new", "deeper");
    const inline = path.join(root, "inline");
    const mixed = path.join(root, "new", "mixed");
    fs.mkdirSync(oldProject, { recursive: true });
    fs.mkdirSync(newProject, { recursive: true });
    fs.mkdirSync(inline, { recursive: true });
    fs.mkdirSync(mixed, { recursive: true });
    // Lists some other tool only, so the widget pin is the one in the folder above.
    fs.writeFileSync(path.join(mixed, "sof.toml"), '[tools]\ngadget = "acme/gadget@1.0.0"\n');
    fs.writeFileSync(path.join(oldProject, "sof.toml"), '[tools]\nwidget = "acme/widget@1.0.0"\n');
    fs.writeFileSync(path.join(root, "new", "sof.toml"), '# comment\n[tools]\n# another\nWidget = "acme/widget@2.0.0"  # pinned\n');
    fs.writeFileSync(path.join(inline, "sof.toml"), 'tools = { widget = "acme/widget@2.0.0" }\n');

    const shim = path.join(home, "bin", process.platform === "win32" ? "widget.exe" : "widget");
    const run = (cwd, args, env = {}) =>
      childProcess.spawnSync(shim, args, { cwd, encoding: "utf8", env: { ...process.env, SOF_HOME: home, ...env } });

    // The tool is node itself, so the version shows in which file the shim started it from.
    const versionOf = (cwd, env) => {
      const outcome = run(cwd, ["-p", "process.argv0"], env);
      assert.equal(outcome.status, 0, outcome.stderr);
      return outcome.stdout.trim();
    };

    for (const env of [{}, { SOF_SHIM_SLOW: "1" }]) {
      assert.match(versionOf(oldProject, env), /[\\/]1\.0\.0[\\/]widget/, JSON.stringify(env));
      assert.match(versionOf(newProject, env), /[\\/]2\.0\.0[\\/]widget/, JSON.stringify(env));
      assert.match(versionOf(mixed, env), /[\\/]2\.0\.0[\\/]widget/, `${JSON.stringify(env)} (nearest file lists another tool)`);
      assert.match(versionOf(inline, env), /[\\/]2\.0\.0[\\/]widget/, `${JSON.stringify(env)} (tools written as an inline table)`);

      const args = run(oldProject, ["-p", "process.argv.slice(1).join('|')", 'one two', 'say "hi"', "c:\\dir\\"], env);
      assert.equal(args.status, 0, args.stderr);
      assert.equal(args.stdout.trim(), 'one two|say "hi"|c:\\dir\\', JSON.stringify(env));

      const exit = run(oldProject, ["-e", "process.exit(7)"], env);
      assert.equal(exit.status, 7, JSON.stringify(env));
    }

    // Layouts TOML reads differently from how a quick line-by-line reader might: the quick path and
    // sof's own resolver must end up running the same thing for every one of them.
    const parityCases = {
      "[TOOLS] is another table": '[TOOLS]\nwidget = "acme/widget@1.0.0"\n',
      "bare dotted key": '[tools]\nwidget.extra = "acme/widget@1.0.0"\n',
      "quoted key with a dot": '[tools]\n"widget.extra" = "acme/widget@1.0.0"\n',
      "quoted table name": '["tools"]\nwidget = "acme/widget@1.0.0"\n',
      "spaces in the header": '[ tools ]\nwidget = "acme/widget@1.0.0"\n',
      "same name twice": '[tools]\nwidget = "acme/widget@1.0.0"\nwidget = "acme/widget@2.0.0"\n',
    };
    for (const [name, text] of Object.entries(parityCases)) {
      const folder = path.join(root, "new", `parity-${Object.keys(parityCases).indexOf(name)}`);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "sof.toml"), text);

      const quick = run(folder, ["-p", "process.argv0"]);
      const slow = run(folder, ["-p", "process.argv0"], { SOF_SHIM_SLOW: "1" });
      assert.deepEqual(
        { status: quick.status, stdout: quick.stdout, stderr: quick.stderr },
        { status: slow.status, stdout: slow.stdout, stderr: slow.stderr },
        name
      );
    }

    if (process.platform === "win32") {
      // A tool file that isn't a program must be reported, not crash the shim.
      const broken = path.join(home, "tools", "acme", "widget", "5.0.0");
      fs.mkdirSync(broken, { recursive: true });
      fs.writeFileSync(path.join(broken, "widget.exe"), "this is not a program");
      const project = path.join(root, "broken");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "acme/widget@5.0.0"\n');

      for (const env of [{}, { SOF_SHIM_SLOW: "1" }]) {
        const result = run(project, ["-p", "1"], env);
        assert.equal(result.status, 126, JSON.stringify(env));
        assert.match(result.stderr, /sof: couldn't start/, JSON.stringify(env));
      }
    }

    const outside = run(root, ["-p", "1"]);
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /"widget" isn't listed under \[tools\]/);

    fs.writeFileSync(path.join(oldProject, "sof.toml"), '[tools]\nwidget = "acme/widget@3.0.0"\n');
    const missing = run(oldProject, ["-p", "1"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /widget 3\.0\.0 isn't installed yet/);
  });
});

test("setup points every existing shim at the current sof, and rebuilding is idempotent", { skip: !SHIMS_AVAILABLE && "no C# compiler" }, async () => {
  const home = tempDir();
  await withEnv({ SOF_HOME: home }, async () => {
    assert.deepEqual(ensureShims(["rojo", "selene"]).changed.sort(), ["rojo", "selene"]);
    assert.deepEqual(ensureShims(["rojo", "selene"]).changed, []);

    const added = ensureShims(["stylua"]);
    assert.deepEqual(added.changed, ["stylua"]);
    assert.deepEqual(ensureShims([]).changed, [], "setup with nothing new keeps the existing shims");
    assert.match(fs.readFileSync(path.join(home, "bin", "sof-shim.cfg"), "utf8"), /rojo\nselene\nstylua\n$/);

    const entries = fs.readdirSync(path.join(home, "bin")).sort();
    assert.ok(entries.some((name) => name.startsWith("rojo")) && entries.some((name) => name.startsWith("stylua")));
  });
});

test("a shim that is running can still be replaced, and the leftover is cleared later", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const system = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const source = path.join(system, "whoami.exe");
  const running = path.join(system, "ping.exe");
  if (!fs.existsSync(source) || !fs.existsSync(running)) {
    return;
  }

  const bin = tempDir();
  const target = path.join(bin, "widget.exe");
  fs.copyFileSync(running, target);

  const child = childProcess.spawn(target, ["-n", "4", "127.0.0.1"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("close", resolve));
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => fs.copyFileSync(source, target), "a running .exe can't be overwritten (the premise of this test)");

    replaceFile(source, target);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source));
    assert.equal(fs.readdirSync(bin).filter((name) => /\.old-/.test(name)).length, 1, "the running copy is parked, not lost");
    clearReplacedShims(bin);
    assert.equal(fs.readdirSync(bin).filter((name) => /\.old-/.test(name)).length, 1, "it can't be deleted while it runs");
  } finally {
    await exited;
  }

  clearReplacedShims(bin);
  assert.deepEqual(fs.readdirSync(bin), ["widget.exe"]);
});

test("the sh shim reads its config next to itself and passes arguments through", () => {
  const script = shScript("widget");
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /exec "\$node" "\$entry" run tools exec widget "\$@"\n$/);
  assert.doesNotMatch(script, /dirname|\bcat\b|\bhead\b/, "no external programs: a tool named like one must not be able to intercept them");

  const sh = childProcess.spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  if (!sh.error) {
    assert.equal(sh.status, 0, sh.stderr);
  }
});

test("the sh shim finds its own folder however it is started", (t) => {
  const probe = childProcess.spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("no sh on this machine");
    return;
  }

  // Everything before the final exec, then print the folder the script thinks it is in.
  const lines = shScript("widget").trimEnd().split("\n");
  const body = lines.slice(0, -1).join("\n").replace(/^.*\[ -f "\$entry" \].*$/m, ":");
  const root = tempDir();
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "widget"), `${body}\necho "$dir"\n`);

  const run = (args) => childProcess.spawnSync("sh", args, { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.equal(run(["sub/widget"]), "sub");
  assert.equal(run(["./sub/widget"]), "./sub");
  assert.equal(childProcess.spawnSync("sh", ["widget"], { cwd: path.join(root, "sub"), encoding: "utf8" }).stdout.trim(), ".", "started by bare name, from its own folder");
});
