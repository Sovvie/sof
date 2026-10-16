"use strict";

const HELP_TEXT = `sof run bundle - zip or tar.gz a project (or folder)

Usage:
  sof run bundle [folder] [options]

folder defaults to the current directory.

Options:
  -o, --out <file>       Output file; the extension decides the format (.zip, .tar.gz, .tgz).
                         Default: ./dist/<name>-<version-or-date>.zip
      --format <fmt>     zip or tar.gz (overrides the extension)
      --include <glob>   Only bundle matching files (gitignore-style pattern, repeatable). Default: everything
      --exclude <glob>   Leave out matching files (repeatable), on top of the defaults
      --no-gitignore     Do not honor .gitignore files (root and nested)
      --name <name>      Name used for the default file name and the --root-folder folder
      --version <v>      Version used for the default file name
      --root-folder      Put everything under <name>/ inside the archive
      --list             Print the files that would be bundled and their sizes; write nothing
      --reproducible     Sorted entries, fixed times and modes (default)
      --no-reproducible  Keep real file times and modes
      --json             Machine-readable output
  -h, --help             Show this help

Always left out: .git, node_modules, the output file and the folder's own dist/ folder.
Symlinks are skipped. Defaults can be set in a [bundle] table of the nearest sof.toml:
include, exclude, out, format, name, version, root_folder, gitignore.`;

const VALUE_FLAGS = new Map([
  ["-o", "out"],
  ["--out", "out"],
  ["--format", "format"],
  ["--include", "include"],
  ["--exclude", "exclude"],
  ["--name", "name"],
  ["--version", "version"],
]);

const SWITCHES = new Map([
  ["--no-gitignore", ["gitignore", false]],
  ["--gitignore", ["gitignore", true]],
  ["--root-folder", ["rootFolder", true]],
  ["--list", ["list", true]],
  ["--reproducible", ["reproducible", true]],
  ["--no-reproducible", ["reproducible", false]],
  ["--json", ["json", true]],
  ["-h", ["help", true]],
  ["--help", ["help", true]],
]);

// Options left undefined here were not given on the command line, so [bundle] in sof.toml can fill them.
function parseArgs(argv) {
  const opts = { folder: undefined, include: [], exclude: [], reproducible: true };
  for (let i = 0; i < argv.length; i++) {
    let arg = String(argv[i]);
    let inline;
    if (arg.startsWith("--") && arg.includes("=")) {
      inline = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    if (VALUE_FLAGS.has(arg)) {
      const key = VALUE_FLAGS.get(arg);
      let value = inline;
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) {
          throw new Error(`${arg} needs a value.`);
        }
      }
      if (key === "include" || key === "exclude") {
        opts[key].push(String(value));
      } else {
        opts[key] = String(value);
      }
    } else if (SWITCHES.has(arg) && inline === undefined) {
      const [key, value] = SWITCHES.get(arg);
      opts[key] = value;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`Unknown option ${arg}. Try --help.`);
    } else {
      if (opts.folder !== undefined) {
        throw new Error(`Unexpected argument "${arg}": only one folder can be bundled.`);
      }
      opts.folder = arg;
    }
  }
  if (opts.format !== undefined && !["zip", "tar.gz", "tgz"].includes(opts.format)) {
    throw new Error(`Unknown format "${opts.format}". Use zip or tar.gz.`);
  }
  return opts;
}

module.exports = { HELP_TEXT, parseArgs };
