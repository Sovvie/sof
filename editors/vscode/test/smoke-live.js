"use strict";

// Runs the extension's real registry client and tag logic against the live registry
// (https://sof.sov.gg by default; SOF_REGISTRY_URL overrides). Needs network.
//   npm run smoke

const { Registry, resolveRegistryUrl } = require("../src/registry");
const { parseDependencies, analyze, tagFor } = require("../src/model");
const { planUpdates } = require("../src/updates");

const SAMPLE = `[[dependencies]]
path = "src/ReplicatedStorage/Packages"
Router = "sovvie/router@^1.0.0"
Async = "sovvie/async@1.0.0"
Fsm = "sovvie/bufferfsm@1.0.0"
Pinned = "sovvie/bufferfsm@^9.0.0"
Promise = "evaera/promise@^3.0.0"
Nope = "definitely/not-a-package@^1.0.0"
`;

async function main() {
  const settings = { registryUrl: resolveRegistryUrl(""), wallyEnabled: true, cacheMs: 60000 };
  const registry = new Registry({ getSettings: () => settings, userAgent: "sof-vscode-smoke" });
  console.log(`Registry: ${settings.registryUrl}`);

  const started = Date.now();
  const list = await registry.getList();
  console.log(`Package list: ${list.length} packages in ${Date.now() - started} ms`);
  console.log(`  e.g. ${list.slice(0, 3).map((p) => `${p.name}@${p.latest}`).join(", ")}`);

  const dependencies = parseDependencies(SAMPLE);
  const names = dependencies.map((d) => d.spec.name).filter(Boolean);
  const lookupStarted = Date.now();
  await registry.ensure(names);
  console.log(`Looked up ${names.length} packages in ${Date.now() - lookupStarted} ms\n`);

  const analyzed = analyze(dependencies, { getState: (name) => registry.getState(name) });
  for (const entry of analyzed) {
    const tag = tagFor(entry);
    const state = entry.state;
    const where = state && state.data ? state.data.source : state ? state.status : "?";
    console.log(
      `${entry.dep.alias.padEnd(8)} ${entry.dep.raw.padEnd(34)} [${where}]`.padEnd(60) + ` -> ${tag ? tag.text : "(no tag)"}`
    );
  }

  console.log("\nPlanned updates:");
  for (const plan of planUpdates(analyzed)) {
    console.log(`  ${plan.name}: ${plan.from} -> ${plan.to} (${plan.kind})`);
  }

  // Revalidation: a second pass after expiry should be answered with 304s.
  registry.expire();
  const revalidateStarted = Date.now();
  await registry.ensure(names);
  console.log(`\nRevalidated in ${Date.now() - revalidateStarted} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
