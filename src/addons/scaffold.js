"use strict";

// `sof run addon new <name>`: a working add-on to start from.

const fs = require("fs");
const path = require("path");

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const { RESERVED_COMMANDS } = require("./descriptor");

function files(name, sandbox) {
  const manifest = {
    name,
    version: "0.1.0",
    command: name,
    entry: `src/commands/${name}.js`,
    export: "run",
    usage: `${name} [options] <input>`,
    description: `Describe what ${name} does`,
    sandbox,
  };

  return {
    "sof-addon.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "package.json": `${JSON.stringify(
      { name: `sof-addon-${name}`, version: "0.1.0", private: true, license: "MIT", description: manifest.description, scripts: { test: "node --test" }, dependencies: {} },
      null,
      2
    )}\n`,
    [`src/commands/${name}.js`]: `"use strict";

// sof calls run(argv, host). host brings what most add-ons need:
//   host.args.parse(argv, spec)   options and positional arguments, with errors a person can read
//   host.args.help(name, spec)    a help text built from the same spec
//   host.log.info/success/warn/error/step/json
//   host.format.bytes/duration
//   host.confirm(question)        asks on a terminal; false without one
//   host.config()                 the [addons.${name}] table of the project's sof.toml
//   host.addons.run(command, argv) call an add-on listed under "requires.addons"
//   host.sandboxed                ${sandbox ? "true: files are limited to the project, no programs can be started" : "false: this add-on has all your permissions"}
// (in-process add-ons also get host.tempDir() and host.tools.path(alias))

const SPEC = {
  positional: { name: "input", min: 1 },
  flags: {
    "--shout": { key: "shout", description: "Print in capitals" },
    "--times": { key: "times", type: "integer", min: 1, max: 100, default: 1, description: "How many times" },
  },
};

async function run(argv, host) {
  const { options, positional } = host.args.parse(argv, SPEC);
  if (options.help) {
    console.log(host.args.help("${name}", SPEC, "Describe what ${name} does"));
    return;
  }

  const text = options.shout ? positional.join(" ").toUpperCase() : positional.join(" ");
  for (let count = 0; count < options.times; count += 1) {
    host.log.info(text);
  }
}

module.exports = { run };
`,
    [`test/${name}.test.js`]: `"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// "sof run addon test" sets SOF_ADDON_KIT to sof's host kit, so a test can call run() without a terminal.
const kit = process.env.SOF_ADDON_KIT ? require(process.env.SOF_ADDON_KIT) : null;
const { run } = require("../src/commands/${name}");

test("says what it was given", { skip: !kit && "run this with: sof run addon test" }, async () => {
  const { host, output } = kit.createTestHost();
  await run(["--shout", "--times", "2", "hello", "world"], host);
  assert.equal(output(), "HELLO WORLD\\nHELLO WORLD");
});

test("explains a missing argument", { skip: !kit && "run this with: sof run addon test" }, async () => {
  const { host } = kit.createTestHost();
  await assert.rejects(() => run([], host), /Missing input/);
});
`,
    "README.md": `# ${name}

Describe what ${name} does.

\`\`\`bash
sof run addon add --path .     # install this folder while you develop it
sof run ${name} --help
sof run addon test             # checks sof-addon.json and runs npm test
\`\`\`

Publishing: bump "version" in sof-addon.json, then \`sof run addon publish .\`.
`,
  };
}

function scaffoldAddon({ name, directory, sandbox = true }) {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`"${name}" isn't a good add-on name: use lowercase letters, numbers and "-", starting with a letter.`);
  }
  if (RESERVED_COMMANDS.has(name)) {
    throw new Error(`"${name}" is a built-in sof command, so an add-on can't be called that.`);
  }
  if (fs.existsSync(directory) && fs.readdirSync(directory).length > 0) {
    throw new Error(`${directory} already exists and isn't empty.`);
  }

  const written = [];
  for (const [relative, content] of Object.entries(files(name, sandbox))) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    written.push(relative);
  }
  return { directory, files: written };
}

module.exports = { scaffoldAddon };
