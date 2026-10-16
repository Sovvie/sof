"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDependencies, analyze } = require("../src/model");
const { planUpdate, planUpdates } = require("../src/updates");
const { problemsFor } = require("../src/problems");
const { buildHover, escapeMarkdown } = require("../src/hover-content");

function data(versions, extra = {}) {
  return {
    source: "sof",
    name: "sovvie/router",
    versions: versions.map((v) => (typeof v === "string" ? { version: v, yanked: false, dependencies: {} } : { yanked: false, dependencies: {}, ...v })),
    ...extra,
  };
}

function analyzeText(text, states, lockEntries = null) {
  return analyze(parseDependencies(text), { getState: (name) => states[name] || null, lockEntries });
}

const HEAD = '[[dependencies]]\npath = "src/Packages"\n';
const hoverOptions = {
  packageUrl: (name) => `https://registry.test/p/${name}`,
  updateCommand: (plan) => `command:sof.applyEdit?${encodeURIComponent(JSON.stringify([plan.to]))}`,
  refreshCommand: "command:sof.refresh",
  installCommand: "command:sof.runInstall?%5B%22file%3A%2F%2F%2Fx%22%5D",
  wallyEnabled: true,
};

test("planUpdate bumps simple ranges and records the exact characters to replace", () => {
  const text = `${HEAD}Router = "sovvie/router@^1.0.0"\n`;
  const [entry] = analyzeText(text, { "sovvie/router": { status: "ok", data: data(["1.0.0", "2.1.0"]) } });
  const plan = planUpdate(entry);
  assert.equal(plan.to, "^2.1.0");
  assert.equal(plan.kind, "major");
  assert.equal(text.slice(plan.span.start, plan.span.end), "^1.0.0");
});

test("planUpdate leaves a range that already allows the newer version alone", () => {
  const text = `${HEAD}Router = "sovvie/router@>=1.0.0"\nOther = "sovvie/router@*"\n`;
  const states = { "sovvie/router": { status: "ok", data: data(["1.0.0", "1.4.0"]) } };
  const lockEntries = [
    { name: "sovvie/router", alias: "Router", version: "1.0.0", path: "src/Packages" },
    { name: "sovvie/router", alias: "Other", version: "1.0.0", path: "src/Packages" },
  ];
  const analyzed = analyzeText(text, states, lockEntries);
  assert.equal(analyzed[0].evaluation.status, "outdated");
  assert.equal(planUpdate(analyzed[0]), null);
  assert.equal(planUpdate(analyzed[1]), null);
});

test("planUpdate raises a caret range even when the lock is simply behind it", () => {
  const text = `${HEAD}Router = "sovvie/router@^1.0.0"\n`;
  const lockEntries = [{ name: "sovvie/router", alias: "Router", version: "1.0.0", path: "src/Packages" }];
  const [entry] = analyzeText(text, { "sovvie/router": { status: "ok", data: data(["1.0.0", "1.4.0"]) } }, lockEntries);
  assert.equal(planUpdate(entry).to, "^1.4.0");
});

test("planUpdate suggests a working range when none matches, and nothing when up to date", () => {
  const text = `${HEAD}A = "sovvie/router@^9.0.0"\nB = "sovvie/router@1.0.0"\n`;
  const [a, b] = analyzeText(text, { "sovvie/router": { status: "ok", data: data(["1.0.0"]) } });
  const fix = planUpdate(a);
  assert.equal(fix.to, "^1.0.0");
  assert.equal(fix.kind, "fix");
  assert.equal(planUpdate(b), null);
});

test("planUpdates collects only the dependencies that can move", () => {
  const text = `${HEAD}A = "x/a@1.0.0"\nB = "x/b@1.0.0"\nC = "x/c@1.0.0"\n`;
  const analyzed = analyzeText(text, {
    "x/a": { status: "ok", data: data(["1.0.0", "1.1.0"]) },
    "x/b": { status: "ok", data: data(["1.0.0"]) },
    "x/c": { status: "notfound" },
  });
  assert.deepEqual(
    planUpdates(analyzed).map((p) => [p.name, p.to]),
    [["x/a", "1.1.0"]]
  );
});

test("problems: invalid specifiers point at the exact part that is wrong", () => {
  const text = `${HEAD}A = "router@^1.0.0"\nB = "sovvie/router@nope"\nC = ""\nD = "sovvie/router"\n`;
  const problems = problemsFor(analyzeText(text, {}), { wallyEnabled: true });
  const byAlias = Object.fromEntries(problems.map((p) => [p.dep.alias, p]));

  assert.equal(text.slice(byAlias.A.span.start, byAlias.A.span.end), "router");
  assert.equal(byAlias.A.code, "sof.bad-name");
  assert.equal(text.slice(byAlias.B.span.start, byAlias.B.span.end), "nope");
  assert.equal(byAlias.B.code, "sof.bad-range");
  assert.equal(text.slice(byAlias.C.span.start, byAlias.C.span.end), '""', "an empty string underlines the quotes");
  assert.equal(byAlias.D.code, "sof.missing-range");
  assert.ok(problems.every((p) => p.severity === "error"));
});

test("problems: unknown, unmatched, yanked and outdated", () => {
  const text = `${HEAD}Gone = "s/gone@^1.0.0"\nNone = "s/none@^9.0.0"\nYanked = "s/yanked@1.0.0"\nOld = "s/old@1.0.0"\nFine = "s/fine@1.0.0"\n`;
  const problems = problemsFor(
    analyzeText(text, {
      "s/gone": { status: "notfound" },
      "s/none": { status: "ok", data: data(["1.0.0"]) },
      "s/yanked": { status: "ok", data: data([{ version: "1.0.0", yanked: true }]) },
      "s/old": { status: "ok", data: data(["1.0.0", "2.0.0"]) },
      "s/fine": { status: "ok", data: data(["1.0.0"]) },
    }),
    { wallyEnabled: true }
  );
  const byAlias = Object.fromEntries(problems.map((p) => [p.dep.alias, p]));

  assert.equal(byAlias.Gone.code, "sof.not-found");
  assert.equal(byAlias.Gone.severity, "warning");
  assert.match(byAlias.Gone.message, /sof index or the Wally index/);
  assert.equal(text.slice(byAlias.Gone.span.start, byAlias.Gone.span.end), "s/gone");

  assert.equal(byAlias.None.code, "sof.no-match");
  assert.match(byAlias.None.message, /latest version is 1\.0\.0/);
  assert.equal(byAlias.Yanked.code, "sof.yanked");
  assert.equal(byAlias.Old.code, "sof.outdated");
  assert.equal(byAlias.Old.severity, "outdated");
  assert.equal(byAlias.Fine, undefined);

  const noWally = problemsFor(analyzeText(`${HEAD}Gone = "s/gone@^1.0.0"\n`, { "s/gone": { status: "notfound" } }), {
    wallyEnabled: false,
  });
  assert.doesNotMatch(noWally[0].message, /Wally/);
});

test("problems: an unterminated string is reported, and a registry outage is not a problem", () => {
  const text = `${HEAD}Router = "sovvie/router@^1.0.0\n`;
  const problems = problemsFor(analyzeText(text, { "sovvie/router": { status: "error", error: "down" } }), {
    wallyEnabled: true,
  });
  assert.deepEqual(
    problems.map((p) => p.code),
    ["sof.unterminated"]
  );
});

test("hover: an outdated package shows range, resolution, update link, versions and facts", () => {
  const text = `${HEAD}Router = "sovvie/router@^1.0.0"\n`;
  const [entry] = analyzeText(text, {
    "sovvie/router": {
      status: "ok",
      data: data([
        "1.0.0",
        { version: "1.4.0", description: "UI navigation", license: "MIT", realm: "shared", authors: ["Sov"], published: "2026-09-26T11:00:20.901Z", dependencies: { Stream: "sovvie/stream@^2.0.0" } },
        "2.0.0",
        { version: "1.5.0", yanked: true },
      ]),
    },
  });
  const md = buildHover(entry, hoverOptions);

  assert.match(md, /^\*\*sovvie\/router\*\* · sof index · \[Open ↗\]\(https:\/\/registry\.test\/p\/sovvie\/router\)/);
  assert.match(md, /UI navigation/);
  // One coloured verdict line, in the major (amber) family, then what to do about it.
  assert.match(
    md,
    /<span style="color:var\(--vscode-sof-tag-majorForeground\);">\*\*↑ 2\.0\.0 available\*\*<\/span> · major update, outside `\^1\.0\.0`/
  );
  assert.match(md, /\[Update to `\^2\.0\.0`\]\(command:sof\.applyEdit/);
  assert.match(md, /`\^1\.0\.0` → `1\.4\.0`/);
  assert.match(md, /~~`1\.5\.0`~~ \(yanked\)/);
  assert.match(md, /published 2026-09-26/);
  assert.match(md, /Depends on: Stream `sovvie\/stream@\^2\.0\.0`/);
});

test("hover: up to date, loading, not found and error states", () => {
  const text = `${HEAD}A = "x/a@1.0.0"\nB = "x/b@1.0.0"\nC = "x/c@1.0.0"\nD = "x/d@1.0.0"\n`;
  const [a, b, c, d] = analyzeText(text, {
    "x/a": { status: "ok", data: data(["1.0.0"]) },
    "x/b": { status: "loading" },
    "x/c": { status: "notfound" },
    "x/d": { status: "error", error: "Could not reach registry" },
  });
  assert.match(buildHover(a, hoverOptions), /sof-tag-upToDateForeground\);">\*\*✓ Up to date\*\*/);
  assert.match(buildHover(b, hoverOptions), /Checking the registry/);
  assert.match(buildHover(c, hoverOptions), /not in index.* not found in the sof index or the Wally index/);
  const error = buildHover(d, hoverOptions);
  assert.match(error, /unavailable/);
  assert.match(error, /Could not reach registry/);
  assert.match(error, /command:sof\.refresh/);
});

test("hover: each fact appears once", () => {
  const [entry] = analyzeText(`${HEAD}Stream = "sovvie/stream@^2.1.0"\n`, {
    "sovvie/stream": { status: "ok", data: data(["2.0.0", { version: "2.1.0", description: "Reactive values", published: "2026-10-01T00:00:00Z" }]) },
  }, [{ name: "sovvie/stream", alias: "Stream", version: "2.1.0", path: "src/Packages" }]);
  const md = buildHover(entry, hoverOptions);
  const visible = md.replace(/\]\([^)]*\)/g, "]"); // what a reader sees: link targets are not text
  const count = (pattern) => (visible.match(pattern) || []).length;

  assert.equal(count(/sovvie\/stream/g), 1, "the name is in the header only");
  assert.equal(count(/sof index/g), 1);
  assert.equal(count(/Up to date/g), 1);
  assert.equal(count(/Reactive values/g), 1);
  assert.equal(count(/Open ↗/g), 1);
  assert.match(md, /installed `2\.1\.0`/);
});

test("hover: a lock that has not caught up with a bumped range says so, with a way to fix it", () => {
  const states = { "sovvie/stream": { status: "ok", data: data(["2.0.0", "2.1.0"]) } };
  const lockEntries = [{ name: "sovvie/stream", alias: "Stream", version: "2.0.0", path: "src/Packages" }];
  const [entry] = analyzeText(`${HEAD}Stream = "sovvie/stream@^2.1.0"\n`, states, lockEntries);
  const md = buildHover(entry, hoverOptions);

  assert.match(md, /sof-tag-installForeground\);">\*\*⟳ Not installed at 2\.1\.0\*\*<\/span> · sof\.lock still pins `2\.0\.0`, which `\^2\.1\.0` does not allow/);
  assert.match(md, /\[Run sof run package install\]\(command:sof\.runInstall\?/);
  assert.match(md, /✓ Up to date/, "the declaration itself is current");
  assert.doesNotMatch(md, /installed `2\.0\.0`/, "a stale lock is not reported as what is installed");
});

test("hover: a dependency the lock does not list, and a missing lockfile", () => {
  const states = { "x/a": { status: "ok", data: data(["1.0.0"]) } };
  const text = `${HEAD}A = "x/a@^1.0.0"\n`;

  const [missing] = analyzeText(text, states, []);
  assert.match(buildHover(missing, hoverOptions), /\*\*⟳ Not installed\*\*<\/span> · sof\.lock has no entry for this dependency/);

  const [noLock] = analyzeText(text, states, null);
  const md = buildHover(noLock, hoverOptions);
  assert.match(md, /No sof\.lock next to this file yet/);
  assert.doesNotMatch(md, /runInstall/);
});

test("hover: the only HTML is the colour span VS Code lets through", () => {
  const states = {
    "x/a": { status: "ok", data: data(["1.0.0", "2.0.0"]) },
    "x/b": { status: "ok", data: data([{ version: "1.0.0", yanked: true }]) },
    "x/c": { status: "ok", data: data(["1.0.0"]) },
    "x/d": { status: "notfound" },
    "x/e": { status: "error", error: "down" },
  };
  const lockEntries = [{ name: "x/a", alias: "A", version: "0.9.0", path: "p" }];
  const text = `[[dependencies]]\npath = "p"\nA = "x/a@1.0.0"\nB = "x/b@1.0.0"\nC = "x/c@^9.0.0"\nD = "x/d@1.0.0"\nE = "x/e@1.0.0"\n`;
  for (const entry of analyzeText(text, states, lockEntries)) {
    const md = buildHover(entry, hoverOptions);
    const live = md.replace(/`[^`]*`/g, "``").replace(/\\[\s\S]/g, "");
    for (const tag of live.match(/<[^>]*>/g) || []) {
      assert.match(tag, /^(<span style="color:var\(--vscode(-[a-zA-Z0-9]+)+\);">|<\/span>)$/, `${entry.dep.alias}: ${tag}`);
    }
  }
});

test("hover: nothing for a specifier without a name", () => {
  const [entry] = analyzeText(`${HEAD}A = "nope"\n`, {});
  assert.equal(buildHover(entry, hoverOptions), null);
});

test("hover: registry text cannot inject links, images or commands", () => {
  const evil = "[click](command:workbench.action.reloadWindow) ![x](https://evil.test/p.png) <img src=x> `code` **bold**";
  const [entry] = analyzeText(`${HEAD}A = "x/a@1.0.0"\n`, {
    "x/a": {
      status: "ok",
      data: data([
        {
          version: "1.0.0",
          description: evil,
          license: evil,
          authors: [evil],
          dependencies: { [evil]: "x/y@1.0.0`](command:evil)" },
        },
      ]),
    },
  });
  const md = buildHover(entry, hoverOptions);

  // What a Markdown renderer would treat as live: drop code spans (inert) and backslash-escaped
  // characters (rendered literally), then nothing hostile may remain.
  const live = md.replace(/`[^`]*`/g, "``").replace(/\\[\s\S]/g, "");
  assert.doesNotMatch(live, /\]\((command:|https:\/\/evil)/);
  assert.doesNotMatch(live, /!\[/);
  assert.doesNotMatch(live, /<img/);

  // ...and the registry's text is still there, as text.
  assert.match(md, /\\\[click\\\]\\\(command:workbench/);
  // This entry is up to date, so none of our own command links are present either.
  assert.equal((live.match(/\]\(command:/g) || []).length, 0);
});

test("escapeMarkdown escapes every control character and flattens newlines", () => {
  assert.equal(escapeMarkdown("a_b*c[d](e)`f`"), "a\\_b\\*c\\[d\\]\\(e\\)\\`f\\`");
  assert.equal(escapeMarkdown("line1\nline2"), "line1 line2");
});
