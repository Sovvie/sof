"use strict";

const vscode = require("vscode");
const { planUpdates } = require("./updates");
const { installCommandFor } = require("./install");
const { rangeOf, withTimeout } = require("./util");
const { isSofDocument } = require("./service");

/** @returns {vscode.TextEditor | undefined} The active editor, if it shows a sof file. */
function activeSofEditor() {
  const editor = vscode.window.activeTextEditor;
  return editor && isSofDocument(editor.document) ? editor : undefined;
}

/**
 * @param {vscode.TextDocument} document
 * @param {import("./updates").PlannedUpdate[]} plans
 */
async function applyPlans(document, plans) {
  const edit = new vscode.WorkspaceEdit();
  for (const plan of plans) {
    edit.replace(document.uri, rangeOf(document, plan.span), plan.to);
  }
  return vscode.workspace.applyEdit(edit);
}

/**
 * @param {import("./service").Service} service
 * @param {() => void} renderAll
 * @returns {vscode.Disposable[]}
 */
function registerCommands(service, renderAll) {
  /** One terminal per folder, reused for later installs. @type {Map<string, vscode.Terminal>} */
  const installTerminals = new Map();

  return [
    // Used by the "Update to ..." links in hover cards. The arguments are exactly what the
    // hover saw: if the file has changed since, the offsets cannot be trusted.
    vscode.commands.registerCommand("sof.applyEdit", async (uriText, version, start, end, expected, replacement) => {
      const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uriText);
      if (!document || !isSofDocument(document)) return;

      const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
      if (document.version !== version || document.getText(range) !== expected) {
        void vscode.window.showInformationMessage("sof: the file changed since this hover was shown. Hover again to update.");
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, range, String(replacement));
      await vscode.workspace.applyEdit(edit);
    }),

    // "Run sof run package install" for this file, in a terminal you can see. sof reads the file
    // from disk, so unsaved edits are saved first: the install must see what the editor shows.
    vscode.commands.registerCommand("sof.runInstall", async (uriText) => {
      const document = uriText
        ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uriText)
        : (activeSofEditor() || { document: undefined }).document;
      if (!document || !isSofDocument(document)) return;

      const fileName = document.uri.path.split("/").pop() || "sof.toml";
      const command = installCommandFor(fileName);
      if (!command) {
        void vscode.window.showWarningMessage(
          `sof: run "sof run package install" for ${fileName} in a terminal yourself (its name has characters this command will not pass to a shell).`
        );
        return;
      }
      if (document.isDirty && !(await document.save())) return;

      const directory = vscode.Uri.joinPath(document.uri, "..");
      let terminal = installTerminals.get(directory.toString());
      if (!terminal || terminal.exitStatus !== undefined) {
        terminal = vscode.window.createTerminal({ name: "sof", cwd: directory });
        installTerminals.set(directory.toString(), terminal);
      }
      terminal.show(true);
      terminal.sendText(command);
    }),

    vscode.commands.registerCommand("sof.refresh", async () => {
      service.registry.expire();
      const documents = vscode.workspace.textDocuments.filter(isSofDocument);
      await Promise.all(documents.map((document) => service.ensure(document, { force: true })));
      renderAll();
      void vscode.window.setStatusBarMessage("sof: package info refreshed", 3000);
    }),

    vscode.commands.registerCommand("sof.updateAll", async () => {
      const editor = activeSofEditor();
      if (!editor) return;

      const plans = planUpdates(service.analyze(editor.document)).filter((plan) => plan.kind !== "fix");
      if (plans.length === 0) {
        void vscode.window.showInformationMessage("sof: every dependency is already up to date.");
        return;
      }
      await applyPlans(editor.document, plans);
    }),

    vscode.commands.registerCommand("sof.updateDependencies", async () => {
      const editor = activeSofEditor();
      if (!editor) return;
      const { document } = editor;

      const plans = planUpdates(service.analyze(document));
      if (plans.length === 0) {
        void vscode.window.showInformationMessage("sof: every dependency is up to date.");
        return;
      }

      const items = plans.map((plan) => ({
        label: `${plan.kind === "fix" ? "$(warning)" : "$(arrow-up)"} ${plan.dep.alias}`,
        description: `${plan.from} → ${plan.to}`,
        detail: plan.kind === "fix" ? `${plan.name} · cannot be installed as written` : `${plan.name} · ${plan.kind} update`,
        picked: plan.kind !== "major",
        plan,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: "Update dependencies",
        placeHolder: "Choose what to update (major updates start unchecked)",
      });
      if (!picked || picked.length === 0) return;

      await applyPlans(document, picked.map((item) => item.plan));
    }),

    vscode.commands.registerCommand("sof.openOnRegistry", async () => {
      const editor = activeSofEditor();
      if (!editor) return;
      const { document } = editor;

      const analyzed = service.analyze(document).filter((entry) => entry.dep.spec.name);
      const offset = document.offsetAt(editor.selection.active);
      let target = analyzed.find(
        (entry) => offset >= entry.dep.keySpan.start && offset <= entry.dep.valueSpan.end
      );

      if (!target) {
        if (analyzed.length === 0) {
          const list = await withTimeout(service.registry.getList(), 4000, null);
          const picked =
            list &&
            (await vscode.window.showQuickPick(
              list.map((entry) => ({ label: entry.name, description: entry.latest, detail: entry.description })),
              { title: "Open a package on the index", matchOnDetail: true }
            ));
          if (picked) await vscode.env.openExternal(vscode.Uri.parse(service.registry.packageUrl(picked.label)));
          return;
        }

        const picked = await vscode.window.showQuickPick(
          analyzed.map((entry) => ({ label: /** @type {string} */ (entry.dep.spec.name), description: entry.dep.alias, entry })),
          { title: "Open a dependency on the package index" }
        );
        if (!picked) return;
        target = picked.entry;
      }

      const name = /** @type {string} */ (target.dep.spec.name);
      const source = target.state && target.state.data ? target.state.data.source : "sof";
      await vscode.env.openExternal(vscode.Uri.parse(service.registry.packageUrl(name, source)));
    }),
  ];
}

module.exports = { registerCommands };
