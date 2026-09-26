"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolveDependencyGraph } = require("../src/packages/resolver");
const { parseDependencySpecifier } = require("../src/packages/config");
const { rewriteSource, pruneRemovedPackages } = require("../src/packages/linker");

const PATH = "src/ReplicatedStorage/Packages";

// packages: { "scope/name": { "1.0.0": { Alias: "scope/dep@^1.0.0" } } }
function fakeRegistry(packages) {
  const queries = [];
  return {
    queries,
    async queryPackage(name) {
      queries.push(name);
      const versions = packages[name];
      if (!versions) {
        return null;
      }
      return {
        source: "sof",
        packageName: name,
        versions: Object.entries(versions).map(([version, dependencies]) => ({
          version,
          metadata: {},
          dependencies,
        })),
      };
    },
  };
}

function group(dependencies) {
  return [
    {
      path: PATH,
      dependencies: Object.entries(dependencies).map(([alias, specifier]) =>
        parseDependencySpecifier(alias, specifier, "config")
      ),
    },
  ];
}

function byName(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry]));
}

test("a dependency shared by several packages is installed once", async () => {
  const registry = fakeRegistry({
    "sovvie/router": { "2.0.0": { Stream: "sovvie/stream@^2.0.0", Butler: "sovvie/butler@^1.0.0" } },
    "sovvie/schematica": { "1.1.0": { Stream: "sovvie/stream@^2.0.0", Butler: "sovvie/butler@^1.0.0" } },
    "sovvie/stream": { "2.0.0": {}, "2.1.0": {} },
    "sovvie/butler": { "1.1.1": {} },
  });

  const { entries } = await resolveDependencyGraph({
    groups: group({ Router: "sovvie/router@^2.0.0", Schematica: "sovvie/schematica@^1.0.0" }),
    registry,
  });

  assert.deepEqual(entries.map((entry) => entry.alias), ["Butler", "Router", "Schematica", "Stream"]);
  const resolved = byName(entries);
  assert.equal(resolved["sovvie/stream"].version, "2.1.0");
  assert.equal(resolved["sovvie/stream"].isDirect, false);
  assert.equal(registry.queries.filter((name) => name === "sovvie/stream").length, 1);
});

test("a package installed directly is not installed again for a dependent", async () => {
  const registry = fakeRegistry({
    "sovvie/router": { "2.0.0": { Stream: "sovvie/stream@^2.0.0" } },
    "sovvie/stream": { "2.0.0": {} },
  });

  const { entries } = await resolveDependencyGraph({
    groups: group({ Router: "sovvie/router@^2.0.0", Stream: "sovvie/stream@^2.0.0" }),
    registry,
  });

  assert.equal(entries.length, 2);
  assert.equal(byName(entries)["sovvie/stream"].isDirect, true);
});

test("a package asked for under another alias is installed once, and requires are rewritten", async () => {
  const registry = fakeRegistry({
    "sovvie/schematica": { "1.1.0": { DataSyncer: "sovvie/nexus@^5.0.0" } },
    "sovvie/nexus": { "5.0.0": {} },
  });

  const { entries } = await resolveDependencyGraph({
    groups: group({ Nexus: "sovvie/nexus@^5.0.0", Schematica: "sovvie/schematica@^1.0.0" }),
    registry,
  });

  const resolved = byName(entries);
  assert.equal(entries.length, 2);
  assert.equal(resolved["sovvie/nexus"].alias, "Nexus");
  assert.deepEqual(resolved["sovvie/schematica"].aliasRewrites, { DataSyncer: "Nexus" });
});

test("the chosen version satisfies every range, not just the first one seen", async () => {
  const registry = fakeRegistry({
    "sovvie/a": { "1.0.0": { Signal: "sovvie/signal@>=1.0.0" } },
    "sovvie/signal": { "1.0.0": {}, "1.4.0": {}, "2.0.0": {} },
  });

  const { entries } = await resolveDependencyGraph({
    groups: group({ A: "sovvie/a@^1.0.0", Signal: "sovvie/signal@^1.2.0" }),
    registry,
  });

  assert.equal(byName(entries)["sovvie/signal"].version, "1.4.0");
});

test("incompatible ranges explain who asked for what", async () => {
  const registry = fakeRegistry({
    "sovvie/a": { "1.0.0": { Signal: "sovvie/signal@^2.0.0" } },
    "sovvie/signal": { "1.0.0": {}, "2.0.0": {} },
  });

  await assert.rejects(
    resolveDependencyGraph({
      groups: group({ A: "sovvie/a@^1.0.0", Signal: "sovvie/signal@^1.0.0" }),
      registry,
    }),
    (error) => {
      assert.match(error.message, /No version of sovvie\/signal satisfies every requirement/);
      assert.match(error.message, /"\^1\.0\.0" \(as Signal, from config\)/);
      assert.match(error.message, /"\^2\.0\.0" \(as Signal, from sovvie\/a@1\.0\.0\)/);
      return true;
    }
  );
});

test("dependencies that change with the chosen version are re-resolved", async () => {
  const registry = fakeRegistry({
    "sovvie/a": { "1.0.0": { Old: "sovvie/old@^1.0.0" }, "1.1.0": { New: "sovvie/new@^1.0.0" } },
    "sovvie/old": { "1.0.0": {} },
    "sovvie/new": { "1.0.0": {} },
  });

  const { entries } = await resolveDependencyGraph({
    groups: group({ A: "sovvie/a@^1.0.0" }),
    registry,
  });

  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["sovvie/a", "sovvie/new"]);
});

test("a locked version is kept while it still satisfies every range", async () => {
  const registry = fakeRegistry({ "sovvie/stream": { "2.0.0": {}, "2.1.0": {} } });

  const { entries } = await resolveDependencyGraph({
    groups: group({ Stream: "sovvie/stream@^2.0.0" }),
    registry,
    lockEntries: [{ name: "sovvie/stream", alias: "Stream", version: "2.0.0", source: "sof", path: PATH }],
  });

  assert.equal(entries[0].version, "2.0.0");
});

test("frozen mode refuses packages missing from the lockfile", async () => {
  const registry = fakeRegistry({ "sovvie/stream": { "2.0.0": {} } });

  await assert.rejects(
    resolveDependencyGraph({ groups: group({ Stream: "sovvie/stream@^2.0.0" }), registry, frozen: true }),
    /--frozen failed/
  );
});

test("two different packages can't share an alias", async () => {
  const registry = fakeRegistry({
    "sovvie/a": { "1.0.0": { Util: "sovvie/other@^1.0.0" } },
    "sovvie/util": { "1.0.0": {} },
    "sovvie/other": { "1.0.0": {} },
  });

  await assert.rejects(
    resolveDependencyGraph({ groups: group({ A: "sovvie/a@^1.0.0", Util: "sovvie/util@^1.0.0" }), registry }),
    /alias collision/
  );
});

test("rewriteSource points sibling requires at the installed alias", () => {
  const source = [
    "local A = require(script.Parent.DataSyncer)",
    "local B = require(script.Parent.Parent.DataSyncer.Net)",
    'local C = require(script.Parent:WaitForChild("DataSyncer"))',
    "local D = require(script.Parent.DataSyncerExtra)",
  ].join("\n");

  assert.equal(
    rewriteSource(source, { DataSyncer: "Nexus" }),
    [
      "local A = require(script.Parent.Nexus)",
      "local B = require(script.Parent.Parent.Nexus.Net)",
      'local C = require(script.Parent:WaitForChild("Nexus"))',
      "local D = require(script.Parent.DataSyncerExtra)",
    ].join("\n")
  );
});

test("pruneRemovedPackages deletes packages dropped from the graph", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sof-prune-"));
  const packages = path.join(root, PATH);
  fs.mkdirSync(path.join(packages, "Old"), { recursive: true });
  fs.writeFileSync(path.join(packages, "Gone.luau"), "return nil");
  fs.writeFileSync(path.join(packages, "Kept.luau"), "return nil");

  const previous = [
    { name: "sovvie/old", alias: "Old", version: "1.0.0", path: PATH },
    { name: "sovvie/gone", alias: "Gone", version: "1.0.0", path: PATH },
    { name: "sovvie/kept", alias: "Kept", version: "1.0.0", path: PATH },
  ];

  const removed = pruneRemovedPackages(previous, [previous[2]], root);

  assert.deepEqual(removed.map((entry) => entry.alias).sort(), ["Gone", "Old"]);
  assert.equal(fs.existsSync(path.join(packages, "Old")), false);
  assert.equal(fs.existsSync(path.join(packages, "Kept.luau")), true);

  fs.rmSync(root, { recursive: true, force: true });
});
