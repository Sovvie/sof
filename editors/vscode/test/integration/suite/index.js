"use strict";

// Runs inside a real VS Code (see ../run.js). Drives the extension through the same provider
// commands VS Code uses for hover, completion and quick fixes, against a mock registry.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { startRegistry } = require("./mock-registry");

// ---- a mock sof registry ---------------------------------------------------------------------

const PACKAGES = {
  "acme/router": {
    description: "UI navigation",
    versions: { "1.0.0": {}, "1.4.0": {}, "2.0.0": {} },
  },
  "acme/stream": { description: "Streams", versions: { "1.0.0": {}, "1.2.0": {} } },
  "acme/late": { description: "Only the typing test asks for this one", versions: { "1.0.0": {} } },
  "acme/old": {
    description: "Has a yanked release",
    versions: { "1.0.0": {}, "1.0.5": {}, "1.1.0": { yanked: true } },
  },
};

const startRegistryWith = () => startRegistry(PACKAGES);

// ---- helpers ---------------------------------------------------------------------------------

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sof-it-"));
let counter = 0;

/** Writes a file in its own folder (so each sof.toml gets its own sof.lock) and opens it. */
async function openFile(name, text, extraFiles = {}) {
  const dir = path.join(workdir, `case${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, fileName), content);
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document);
  return { document, editor };
}

async function waitFor(check, what, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

// The main tag of each dependency, and (separately) the install tag shown after it.
const drawnOf = (api, document) => api.decorations.drawn.get(document.uri.toString()) || [];
const tagsOf = (api, document) =>
  Object.fromEntries(drawnOf(api, document).filter((tag) => tag.kind !== "install").map((tag) => [tag.alias, tag.text]));
const installTagsOf = (api, document) =>
  Object.fromEntries(drawnOf(api, document).filter((tag) => tag.kind === "install").map((tag) => [tag.alias, tag.text]));

function positionIn(document, needle, offsetInNeedle = 0) {
  const text = document.getText();
  const index = text.indexOf(needle);
  assert.ok(index !== -1, `"${needle}" not found in the document`);
  return document.positionAt(index + offsetInNeedle);
}

const labelOf = (item) => (typeof item.label === "string" ? item.label : item.label.label);

const MAIN_TOML = `[[dependencies]]
path = "src/Packages"
Router = "acme/router@^1.0.0"
Stream = "acme/stream@^1.0.0"
Old = "acme/old@1.0.0"
Gone = "acme/gone@^1.0.0"
Nothing = "acme/router@^9.0.0"
Broken = "nope"

[tools]
rojo = "rojo-rbx/rojo@7.6.1"
`;

// ---- the tests -------------------------------------------------------------------------------

async function run() {
  const registry = await startRegistryWith();
  // Some VS Code forks finish scanning extensions after the test host has started.
  const extension = await waitFor(() => vscode.extensions.getExtension("sovvie.sof"), "extension sovvie.sof to be installed", 20000);
  const api = await extension.activate();
  assert.ok(api && api.service, "activate() returned no test API");

  const settings = vscode.workspace.getConfiguration("sof");
  await settings.update("registryUrl", registry.url, vscode.ConfigurationTarget.Global);
  await settings.update("wally.enabled", false, vscode.ConfigurationTarget.Global);
  await waitFor(() => api.service.config.registryUrl === registry.url, "the registry URL setting to apply");

  /** @type {[string, () => Promise<void>][]} */
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);

  test("tags show what each dependency is doing", async () => {
    const { document } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);

    assert.deepStrictEqual(tagsOf(api, document), {
      Router: "↑ 2.0.0",
      Stream: "✓ latest",
      Old: "↑ 1.0.5",
      Gone: "not in index",
      Nothing: "✗ no match",
    });
    assert.ok(registry.hits.some((hit) => hit === "/index/acme/router.json"));
    assert.ok(!registry.hits.some((hit) => hit.includes("rojo")), "[tools] entries must not be looked up");
  });

  test("the tag lands right after the closing quote", async () => {
    const { document } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);
    const drawn = api.decorations.drawn.get(document.uri.toString());
    const router = drawn.find((tag) => tag.alias === "Router");
    assert.strictEqual(router.line, 2);
    assert.strictEqual(router.kind, "major");
    assert.strictEqual(drawn.find((tag) => tag.alias === "Old").kind, "minor");
    assert.strictEqual(drawn.find((tag) => tag.alias === "Stream").kind, "current");
  });

  test(".sof.toml and packages.sof.toml are handled too", async () => {
    for (const name of [".sof.toml", "packages.sof.toml"]) {
      const { document } = await openFile(name, `[[dependencies]]\npath = "p"\nRouter = "acme/router@^1.0.0"\n`);
      await api.refresh(document);
      assert.deepStrictEqual(tagsOf(api, document), { Router: "↑ 2.0.0" }, name);
    }
  });

  test("other files are left completely alone", async () => {
    const { document } = await openFile("rokit.toml", MAIN_TOML);
    await api.refresh(document);
    assert.strictEqual(api.decorations.drawn.has(document.uri.toString()), false);
    assert.deepStrictEqual(vscode.languages.getDiagnostics(document.uri), []);
    const hovers = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      document.uri,
      positionIn(document, "acme/router", 3)
    );
    assert.strictEqual(hovers.length, 0);
  });

  test("diagnostics underline exactly what is wrong", async () => {
    const { document } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    const by = Object.fromEntries(diagnostics.map((d) => [d.code, d]));

    assert.ok(by["sof.missing-range"], "a specifier that is not scope/name@range");
    assert.strictEqual(document.getText(by["sof.missing-range"].range), "nope");
    assert.strictEqual(by["sof.missing-range"].severity, vscode.DiagnosticSeverity.Error);
    assert.ok(by["sof.not-found"], "unknown package");
    assert.strictEqual(document.getText(by["sof.not-found"].range), "acme/gone");
    assert.strictEqual(by["sof.not-found"].severity, vscode.DiagnosticSeverity.Warning);
    assert.ok(by["sof.no-match"], "unsatisfiable range");
    assert.strictEqual(document.getText(by["sof.no-match"].range), "^9.0.0");
    assert.strictEqual(by["sof.no-match"].severity, vscode.DiagnosticSeverity.Error);
    assert.ok(diagnostics.every((d) => d.source === "sof"));
    assert.ok(!by["sof.outdated"], "outdated reporting is off by default");
  });

  test("outdated can be reported as a diagnostic when asked", async () => {
    await settings.update("diagnostics.outdated", "information", vscode.ConfigurationTarget.Global);
    try {
      const { document } = await openFile("sof.toml", MAIN_TOML);
      await waitFor(() => api.service.config.outdatedSeverity === "information", "setting");
      await api.refresh(document);
      const outdated = vscode.languages.getDiagnostics(document.uri).filter((d) => d.code === "sof.outdated");
      assert.strictEqual(outdated.length, 2);
      assert.ok(outdated.every((d) => d.severity === vscode.DiagnosticSeverity.Information));
    } finally {
      await settings.update("diagnostics.outdated", undefined, vscode.ConfigurationTarget.Global);
      await waitFor(() => api.service.config.outdatedSeverity === "off", "setting reset");
    }
  });

  test("hover shows the package card with a working update link", async () => {
    const { document } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);
    const hovers = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      document.uri,
      positionIn(document, "acme/router", 3)
    );
    const text = hovers.flatMap((h) => h.contents.map((c) => c.value)).join("\n");

    assert.match(text, /acme\/router/);
    assert.match(text, /UI navigation/);
    assert.match(text, /`\^1\.0\.0` → `1\.4\.0`/);
    assert.match(text, /\*\*↑ 2\.0\.0 available\*\*<\/span> · major update, outside `\^1\.0\.0`/);
    assert.match(text, /\[Update to `\^2\.0\.0`\]\(command:sof\.applyEdit\?/);

    // Follow the link the way VS Code would: run the command with the encoded arguments.
    const link = /\(command:sof\.applyEdit\?([^)]+)\)/.exec(text);
    await vscode.commands.executeCommand("sof.applyEdit", ...JSON.parse(decodeURIComponent(link[1])));
    assert.match(document.getText(), /Router = "acme\/router@\^2\.0\.0"/);
  });

  test("a stale hover link refuses to edit a file that has since changed", async () => {
    const { document, editor } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);
    const hovers = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      document.uri,
      positionIn(document, "acme/router", 3)
    );
    const text = hovers.flatMap((h) => h.contents.map((c) => c.value)).join("\n");
    const args = JSON.parse(decodeURIComponent(/\(command:sof\.applyEdit\?([^)]+)\)/.exec(text)[1]));

    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "# a comment\n"));
    const before = document.getText();
    await vscode.commands.executeCommand("sof.applyEdit", ...args);
    assert.strictEqual(document.getText(), before);
  });

  test("hover on a package nobody has says so", async () => {
    const { document } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);
    const hovers = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      document.uri,
      positionIn(document, "acme/gone", 3)
    );
    assert.match(hovers.flatMap((h) => h.contents.map((c) => c.value)).join("\n"), /not in index.*not found in the sof index/);
  });

  test("completion: package names inside the quotes", async () => {
    const { document } = await openFile("sof.toml", `[[dependencies]]\npath = "p"\nRouter = "acme/ro"\n`);
    const position = positionIn(document, 'acme/ro"', "acme/ro".length);
    const list = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, position);
    const names = list.items.map(labelOf);
    assert.deepStrictEqual(names.sort(), ["acme/late", "acme/old", "acme/router", "acme/stream"]);

    const router = list.items.find((item) => labelOf(item) === "acme/router");
    assert.strictEqual(router.insertText, "acme/router@^2.0.0");
    assert.strictEqual(document.getText(router.range), "acme/ro");
  });

  test("completion: versions after the @, newest first, yanked struck out", async () => {
    const { document } = await openFile("sof.toml", `[[dependencies]]\npath = "p"\nOld = "acme/old@"\n`);
    const position = positionIn(document, 'old@"', "old@".length);
    const list = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, position);
    const labels = list.items.map(labelOf);

    assert.deepStrictEqual(labels.slice(0, 2), ["^1.0.5", "~1.0.5"], "styles for the latest installable version");
    assert.deepStrictEqual(labels.slice(2), ["1.1.0", "1.0.5", "1.0.0"]);
    const yanked = list.items.find((item) => labelOf(item) === "1.1.0");
    assert.deepStrictEqual(yanked.tags, [vscode.CompletionItemTag.Deprecated]);
  });

  test("completion: a typed operator is kept for every version", async () => {
    const { document } = await openFile("sof.toml", `[[dependencies]]\npath = "p"\nRouter = "acme/router@~1"\n`);
    const position = positionIn(document, '~1"', 2);
    const list = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, position);
    assert.deepStrictEqual(list.items.map(labelOf), ["~2.0.0", "~1.4.0", "~1.0.0"]);
    assert.strictEqual(document.getText(list.items[0].range), "~1");
  });

  test("completion: a whole dependency line at the start of a line", async () => {
    const { document } = await openFile("sof.toml", `[[dependencies]]\npath = "p"\nStream = "acme/stream@^1.0.0"\nrou\n`);
    const position = new vscode.Position(3, 3);
    const list = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, position);
    const names = list.items.map(labelOf);

    assert.ok(names.includes("acme/router"));
    assert.ok(!names.includes("acme/stream"), "already a dependency of this table");
    const router = list.items.find((item) => labelOf(item) === "acme/router");
    assert.strictEqual(router.insertText, 'Router = "acme/router@^2.0.0"');
    assert.strictEqual(document.getText(router.range), "rou");
  });

  test("completion: nothing in [tools]", async () => {
    const { document } = await openFile("sof.toml", `[tools]\nrojo = "rojo-rbx/ro"\n`);
    const position = positionIn(document, 'ro"', 2);
    const list = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, position);
    // When no provider has anything, VS Code adds its own word-based suggestions (kind Text);
    // only what this extension offers (Module / Value) counts.
    const ours = list.items.filter(
      (item) => item.kind === vscode.CompletionItemKind.Module || item.kind === vscode.CompletionItemKind.Value
    );
    assert.deepStrictEqual(ours.map(labelOf), []);
  });

  test("quick fixes update one dependency, or everything at once", async () => {
    const { document } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);
    const line = positionIn(document, "Router");
    const found = await vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider",
      document.uri,
      new vscode.Range(line, line),
      vscode.CodeActionKind.QuickFix.value
    );
    const titles = found.map((action) => action.title);
    assert.ok(titles.includes("Update acme/router to ^2.0.0 (major)"), titles.join(" | "));
    assert.ok(titles.includes("Update all 2 dependencies in this file"), titles.join(" | "));

    const single = found.find((action) => action.title.startsWith("Update acme/router"));
    await vscode.workspace.applyEdit(single.edit);
    assert.match(document.getText(), /Router = "acme\/router@\^2\.0\.0"/);
    assert.match(document.getText(), /Old = "acme\/old@1\.0\.0"/, "only the chosen dependency moved");
  });

  test("a range nothing satisfies is offered a working one", async () => {
    const { document } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);
    const line = positionIn(document, "Nothing");
    const found = await vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider",
      document.uri,
      new vscode.Range(line, line),
      vscode.CodeActionKind.QuickFix.value
    );
    const fix = found.find((action) => action.title === "Use acme/router@^2.0.0");
    assert.ok(fix, found.map((a) => a.title).join(" | "));
    assert.strictEqual(fix.isPreferred, true);
    await vscode.workspace.applyEdit(fix.edit);
    assert.match(document.getText(), /Nothing = "acme\/router@\^2\.0\.0"/);
  });

  test("no quick fix where nothing can be updated", async () => {
    const { document } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);
    const line = positionIn(document, "Stream");
    const found = await vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider",
      document.uri,
      new vscode.Range(line, line),
      vscode.CodeActionKind.QuickFix.value
    );
    assert.strictEqual(found.length, 0);
  });

  test("sof.updateAll moves every outdated dependency and leaves the rest", async () => {
    const { document } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);
    await vscode.commands.executeCommand("sof.updateAll");
    const text = document.getText();
    assert.match(text, /Router = "acme\/router@\^2\.0\.0"/);
    assert.match(text, /Old = "acme\/old@1\.0\.5"/);
    assert.match(text, /Stream = "acme\/stream@\^1\.0\.0"/);
    assert.match(text, /Nothing = "acme\/router@\^9\.0\.0"/, "a broken range is not an update");
    assert.match(text, /rojo = "rojo-rbx\/rojo@7\.6\.1"/);
  });

  test("sof.lock decides what a dependency is on", async () => {
    const lock = `[[package]]\nname = "acme/stream"\nalias = "Stream"\nversion = "1.0.0"\nsource = "sof"\npath = "src/Packages"\nchecksum = "x"\n`;
    const toml = `[[dependencies]]\npath = "src/Packages"\nStream = "acme/stream@^1.0.0"\n`;

    const without = await openFile("sof.toml", toml);
    await api.refresh(without.document);
    assert.deepStrictEqual(tagsOf(api, without.document), { Stream: "✓ latest" });

    const locked = await openFile("sof.toml", toml, { "sof.lock": lock });
    await api.refresh(locked.document);
    assert.deepStrictEqual(tagsOf(api, locked.document), { Stream: "↑ 1.2.0" });
    assert.deepStrictEqual(installTagsOf(api, locked.document), {}, "the lock agrees with the range: nothing to install");
  });

  test("a bumped range that sof.lock has not caught up with gets an install tag", async () => {
    const lock = (version) =>
      `[[package]]\nname = "acme/stream"\nalias = "Stream"\nversion = "${version}"\nsource = "sof"\npath = "src/Packages"\nchecksum = "x"\n`;
    const toml = `[[dependencies]]\npath = "src/Packages"\nStream = "acme/stream@^1.2.0"\nRouter = "acme/router@^2.0.0"\n`;

    // Stream: bumped to ^1.2.0, the lock still pins 1.0.0. Router: not in the lock at all.
    const { document, editor } = await openFile("sof.toml", toml, { "sof.lock": lock("1.0.0") });
    await api.refresh(document);
    assert.deepStrictEqual(tagsOf(api, document), { Stream: "✓ latest", Router: "✓ latest" });
    assert.deepStrictEqual(installTagsOf(api, document), {
      Stream: "⟳ installed 1.0.0",
      Router: "⟳ not installed",
    });

    // Both pills belong to one decoration, drawn in a fixed order: install tag, then main tag.
    const drawn = drawnOf(api, document).filter((tag) => tag.alias === "Stream");
    assert.deepStrictEqual(drawn.map((tag) => tag.kind), ["install", "current"]);

    // An install ran: sof.lock now has both. (The watcher only covers workspace folders, so the
    // lock is re-read the way a focus change would.)
    const fixed = lock("1.2.0") + `\n[[package]]\nname = "acme/router"\nalias = "Router"\nversion = "2.0.0"\nsource = "sof"\npath = "src/Packages"\nchecksum = "x"\n`;
    fs.writeFileSync(path.join(path.dirname(document.uri.fsPath), "sof.lock"), fixed);
    api.service.locks.forget(vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), "sof.lock")));
    await api.refresh(document);
    assert.deepStrictEqual(installTagsOf(api, document), {});
    void editor;
  });

  test("the hover says what is installed, in colour, and links to the install", async () => {
    const lock = `[[package]]\nname = "acme/stream"\nalias = "Stream"\nversion = "1.0.0"\nsource = "sof"\npath = "src/Packages"\nchecksum = "x"\n`;
    const { document } = await openFile(
      "sof.toml",
      `[[dependencies]]\npath = "src/Packages"\nStream = "acme/stream@^1.2.0"\n`,
      { "sof.lock": lock }
    );
    await api.refresh(document);
    const hovers = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      document.uri,
      positionIn(document, "acme/stream", 3)
    );
    assert.strictEqual(hovers.length, 1, "one card, not one per source");
    const markdown = hovers[0].contents[0];
    assert.strictEqual(markdown.supportHtml, true, "the colour spans need HTML support");
    assert.match(markdown.value, /<span style="color:var\(--vscode-sof-tag-upToDateForeground\);">\*\*✓ Up to date\*\*<\/span>/);
    assert.match(markdown.value, /<span style="color:var\(--vscode-sof-tag-installForeground\);">\*\*⟳ Not installed at 1\.2\.0\*\*<\/span>/);
    assert.match(markdown.value, /sof\.lock still pins `1\.0\.0`, which `\^1\.2\.0` does not allow/);
    assert.match(markdown.value, /\[Run sof run package install\]\(command:sof\.runInstall\?/);
  });

  test("hovering where the tag sits shows the card once", async () => {
    const { document } = await openFile("sof.toml", MAIN_TOML);
    await api.refresh(document);
    // The tag is drawn at the end of the string: that position must give exactly one card.
    const end = document.positionAt(document.getText().indexOf('acme/router@^1.0.0"') + 'acme/router@^1.0.0"'.length);
    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", document.uri, end);
    assert.strictEqual(hovers.length, 1);
    assert.strictEqual(hovers[0].contents.length, 1);
  });

  test("run install refuses a file name a shell would misread", async () => {
    const { document } = await openFile("weird name.sof.toml", `[[dependencies]]\npath = "p"\nX = "acme/stream@^1.0.0"\n`);
    await api.refresh(document);
    const terminals = vscode.window.terminals.length;
    await vscode.commands.executeCommand("sof.runInstall", document.uri.toString());
    assert.strictEqual(vscode.window.terminals.length, terminals, "no terminal was opened");
  });

  test("editing a dependency redraws its tag without another lookup", async () => {
    const { document, editor } = await openFile("sof.toml", `[[dependencies]]\npath = "p"\nRouter = "acme/router@^1.0.0"\n`);
    await api.refresh(document);
    assert.deepStrictEqual(tagsOf(api, document), { Router: "↑ 2.0.0" });
    const lookups = registry.hits.length;

    const at = positionIn(document, "^1.0.0");
    await editor.edit((edit) => edit.replace(new vscode.Range(at, at.translate(0, 6)), "^2.0.0"));
    await waitFor(() => tagsOf(api, document).Router === "✓ latest", "the tag to follow the edit");

    // Wait out the delayed lookup too: the package is cached, so it must not hit the network.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.strictEqual(registry.hits.length, lookups, "no request for an edit to a cached package");
  });

  test("typing a new package name looks it up once typing pauses, not before", async () => {
    const { document, editor } = await openFile("sof.toml", `[[dependencies]]\npath = "p"\nX = "acme/la"\n`);
    await api.refresh(document);
    assert.strictEqual(tagsOf(api, document).X, "not in index");
    assert.ok(registry.hits.includes("/index/acme/la.json"));

    const at = positionIn(document, 'acme/la"', "acme/la".length);
    const hitsBefore = registry.hits.length;
    await editor.edit((edit) => edit.insert(at, "te@^1.0.0"));

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.strictEqual(registry.hits.length, hitsBefore, "nothing is looked up while the edit is fresh");

    await waitFor(() => tagsOf(api, document).X === "✓ latest", "the lookup after the pause", 10000);
    assert.ok(registry.hits.includes("/index/acme/late.json"));
  });

  test("the up-to-date tag can be turned off", async () => {
    await settings.update("inlineTags.showUpToDate", false, vscode.ConfigurationTarget.Global);
    try {
      const { document } = await openFile("sof.toml", MAIN_TOML);
      await waitFor(() => api.service.config.showUpToDate === false, "setting");
      await api.refresh(document);
      const tags = tagsOf(api, document);
      assert.strictEqual(tags.Stream, undefined);
      assert.strictEqual(tags.Router, "↑ 2.0.0");
    } finally {
      await settings.update("inlineTags.showUpToDate", undefined, vscode.ConfigurationTarget.Global);
      await waitFor(() => api.service.config.showUpToDate === true, "setting reset");
    }
  });

  test("tags can be turned off entirely", async () => {
    await settings.update("inlineTags.enabled", false, vscode.ConfigurationTarget.Global);
    try {
      const { document } = await openFile("sof.toml", MAIN_TOML);
      await waitFor(() => api.service.config.inlineTags === false, "setting");
      await api.refresh(document);
      assert.deepStrictEqual(tagsOf(api, document), {});
    } finally {
      await settings.update("inlineTags.enabled", undefined, vscode.ConfigurationTarget.Global);
      await waitFor(() => api.service.config.inlineTags === true, "setting reset");
    }
  });

  test("a half-typed file never breaks anything", async () => {
    const { document } = await openFile(
      "sof.toml",
      `[[dependencies\npath = "p"\nRouter = "acme/router@^1.0.0\nStream = [\n[[dependencies]]\nX = "acme/stream@^1.0.0"\n`
    );
    await api.refresh(document);
    assert.deepStrictEqual(tagsOf(api, document), { Router: "↑ 2.0.0", X: "✓ latest" });
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    assert.ok(diagnostics.some((d) => d.code === "sof.unterminated"));
  });

  test("an unreachable registry shows as such, and recovers", async () => {
    const dead = await startRegistryWith();
    const deadUrl = dead.url;
    dead.close();
    await settings.update("registryUrl", deadUrl, vscode.ConfigurationTarget.Global);
    try {
      await waitFor(() => api.service.config.registryUrl === deadUrl, "setting");
      const { document } = await openFile("sof.toml", `[[dependencies]]\npath = "p"\nRouter = "acme/router@^1.0.0"\n`);
      await api.refresh(document);
      assert.deepStrictEqual(tagsOf(api, document), { Router: "⚠ unavailable" });
      assert.deepStrictEqual(vscode.languages.getDiagnostics(document.uri), [], "an outage is not a problem in the file");

      await settings.update("registryUrl", registry.url, vscode.ConfigurationTarget.Global);
      await waitFor(() => api.service.config.registryUrl === registry.url, "setting back");
      await api.refresh(document);
      assert.deepStrictEqual(tagsOf(api, document), { Router: "↑ 2.0.0" });
    } finally {
      await settings.update("registryUrl", registry.url, vscode.ConfigurationTarget.Global);
    }
  });

  // ---- run them ------------------------------------------------------------------------------

  const failures = [];
  for (const [name, fn] of tests) {
    const started = Date.now();
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("test timed out after 30s")), 30000)),
      ]);
      console.log(`  ✔ ${name} (${Date.now() - started} ms)`);
    } catch (err) {
      failures.push([name, err]);
      console.log(`  ✖ ${name}\n      ${err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n      ") : err}`);
    }
  }

  registry.close();
  fs.rmSync(workdir, { recursive: true, force: true });
  console.log(`\n${tests.length - failures.length}/${tests.length} integration tests passed`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} integration test(s) failed`);
  }
}

module.exports = { run };
