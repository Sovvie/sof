"use strict";

const vscode = require("vscode");
const { Config } = require("./config");
const { Service, isSofDocument, SELECTOR } = require("./service");
const { registerCommands } = require("./commands");
const { debounce } = require("./util");
const { summarize } = require("./summary");
const { HoverFeature } = require("./features/hover");
const { DecorationsFeature } = require("./features/decorations");
const { DiagnosticsFeature } = require("./features/diagnostics");
const { CompletionFeature } = require("./features/completion");
const { CodeActionsFeature } = require("./features/codeactions");
const { StatusBarFeature } = require("./features/statusbar");

// After an edit: redraw quickly (the text moved), but wait for a pause in typing before asking
// the registry about what was typed, so half-written names are not looked up.
const REDRAW_DELAY_MS = 120;
const LOOKUP_DELAY_MS = 1200;
const RECHECK_INTERVAL_MS = 60 * 1000;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const config = new Config();
  const service = new Service(config);
  const decorations = new DecorationsFeature(service);
  const diagnostics = new DiagnosticsFeature(service);
  const statusBar = new StatusBarFeature(service);

  // "Output > sof": what was found in each file, and why the registry could not be reached.
  const log = vscode.window.createOutputChannel("sof", { log: true });
  const version = context.extension.packageJSON.version;
  log.info(`sof ${version} activated. Registry ${config.registryUrl}${config.wallyEnabled ? ", Wally fallback on" : ""}.`);

  /** @type {Map<string, string>} */
  const lastSummary = new Map();
  const reportedErrors = new Set();
  function logSummary(document) {
    const { text, errors, pending } = summarize(service.analyze(document));
    const key = document.uri.toString();
    if (lastSummary.get(key) !== text) {
      lastSummary.set(key, text);
      const line = `${document.uri.path.split("/").pop()}: ${text}`;
      if (pending > 0) log.debug(line);
      else log.info(line);
    }
    for (const error of errors) {
      if (!reportedErrors.has(error)) {
        reportedErrors.add(error);
        log.warn(error);
      }
    }
  }

  const sofDocuments = () => vscode.workspace.textDocuments.filter(isSofDocument);
  const visibleSofEditors = () => vscode.window.visibleTextEditors.filter((editor) => isSofDocument(editor.document));

  function redraw(document) {
    for (const editor of visibleSofEditors()) {
      if (editor.document === document) decorations.render(editor);
    }
    diagnostics.update(document);
    statusBar.update();
    logSummary(document);
  }

  function redrawAll() {
    for (const editor of visibleSofEditors()) decorations.render(editor);
    for (const document of sofDocuments()) {
      diagnostics.update(document);
      logSummary(document);
    }
    statusBar.update();
  }
  const redrawAllSoon = debounce(redrawAll, 60);

  // Fetch what a document needs (cached answers are not refetched), then redraw.
  async function lookup(document, options) {
    try {
      await service.ensure(document, options);
    } finally {
      redrawAllSoon();
    }
  }

  /** @type {Map<string, ReturnType<typeof debounce>>} */
  const redrawers = new Map();
  /** @type {Map<string, ReturnType<typeof debounce>>} */
  const lookups = new Map();
  function perDocument(map, document, make) {
    const key = document.uri.toString();
    let fn = map.get(key);
    if (!fn) {
      fn = make();
      map.set(key, fn);
    }
    return fn;
  }

  function track(document) {
    if (!isSofDocument(document)) return;
    redraw(document);
    void lookup(document);
  }

  context.subscriptions.push(
    log,
    decorations,
    diagnostics,
    statusBar,
    service.registry.onDidChange(() => redrawAllSoon()),

    vscode.languages.registerHoverProvider(SELECTOR, new HoverFeature(service)),
    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      new CompletionFeature(service),
      '"',
      "'",
      "/",
      "@",
      "^",
      "~"
    ),
    vscode.languages.registerCodeActionsProvider(SELECTOR, new CodeActionsFeature(service), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),

    ...registerCommands(service, redrawAll),

    vscode.workspace.onDidOpenTextDocument(track),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const { document } = event;
      if (!isSofDocument(document) || event.contentChanges.length === 0) return;
      perDocument(redrawers, document, () => debounce(() => redraw(document), REDRAW_DELAY_MS))();
      perDocument(lookups, document, () => debounce(() => void lookup(document), LOOKUP_DELAY_MS))();
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (!isSofDocument(document)) return;
      const key = document.uri.toString();
      for (const map of [redrawers, lookups]) {
        const pending = map.get(key);
        if (pending) pending.cancel();
        map.delete(key);
      }
      diagnostics.clear(document.uri);
      decorations.forget(document);
      service.forget(document);
      statusBar.update();
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const editor of visibleSofEditors()) track(editor.document);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => statusBar.update()),
    vscode.window.onDidChangeWindowState((state) => {
      // Back in the window after a while: let stale package info refresh.
      if (state.focused) for (const editor of visibleSofEditors()) void lookup(editor.document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!config.update(event)) return;
      redrawAll();
      for (const document of sofDocuments()) void lookup(document);
    }),
  );

  // A sof.lock changing (an install ran) changes what each dependency is "on".
  const lockWatcher = vscode.workspace.createFileSystemWatcher("**/sof.lock");
  const onLockChanged = (uri) => {
    service.locks.forget(uri);
    for (const document of sofDocuments()) void lookup(document);
  };
  context.subscriptions.push(
    lockWatcher,
    lockWatcher.onDidCreate(onLockChanged),
    lockWatcher.onDidChange(onLockChanged),
    lockWatcher.onDidDelete(onLockChanged)
  );

  // Long-open editors: the registry's own TTL decides whether anything is actually fetched.
  const timer = setInterval(() => {
    for (const editor of visibleSofEditors()) void lookup(editor.document);
  }, RECHECK_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  for (const document of sofDocuments()) track(document);

  // What the integration tests drive. Not a public API.
  return {
    service,
    decorations,
    diagnostics,
    /** Fetch everything a document needs and draw it, resolving when done. */
    async refresh(document) {
      await service.ensure(document);
      redrawAll();
    },
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
