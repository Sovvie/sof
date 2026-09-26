# sof

A command-line package manager for Roblox projects, plus Rokit tool setup. Everything else (docs generation, uploaders, video spritesheets, ...) is an optional add-on you install from inside sof.

## Install

Needs [Node.js](https://nodejs.org) 20.19 or newer.

**Windows** (PowerShell):

```powershell
irm https://github.com/sovvie/sof/releases/latest/download/install.ps1 | iex
```

**macOS / Linux**:

```bash
curl -fsSL https://github.com/sovvie/sof/releases/latest/download/install.sh | sh
```

Both install into `~/.sof` and add `~/.sof/bin` to your PATH. Open a new terminal afterwards and run `sof --help`.

Update with `sof run self update`. Uninstall by deleting `~/.sof` and removing `~/.sof/bin` from your PATH.

## Packages

In a game repo, list dependencies in `sof.toml`:

```toml
[[dependencies]]
path = "src/ReplicatedStorage/Packages"
Router = "sovvie/router@^2.0.0"
Stream = "sovvie/stream@^2.0.0"
```

```bash
sof run package install     # installs into the path above and writes sof.lock
sof run package install --frozen   # exactly what sof.lock says (CI, fresh clones)
sof run package outdated
sof run package search router
```

- Dependencies of your dependencies are installed too, next to them, once each. If two packages need the same library, sof picks the newest version that satisfies both and fails with a list of who asked for what when none does.
- A package that refers to a dependency by another name (say `DataSyncer` for `sovvie/nexus`) gets its requires pointed at the copy you already have, instead of a second copy.
- Packages you remove from `sof.toml` are deleted on the next install.
- Commit `sof.lock`; the installed folder can be gitignored.

To publish, describe packages in `packages.sof.toml` (or `sof.toml`) and run `sof run package publish` (needs push access to the index, `sovvie/sof-index`):

```toml
[[package]]
name = "sovvie/router"
version = "2.0.0"
description = "UI navigation with animated transitions"
include = "src/Router"
exclude = ["**/README.md"]

[package.dependencies]
Stream = "sovvie/stream@^2.0.0"
Butler = "sovvie/butler@^1.0.0"
```

`sof run package check` validates that every `require(script.Parent.X)` in a package matches a declared dependency.

## Tools

`sof run tools install|list|add` manages external tools (rojo, selene, luau-lsp, ...) declared under `[tools]` in `sof.toml`, through Rokit. `sof run install` installs packages and tools in one go.

## Add-ons

```bash
sof run addon list             # installed and available add-ons
sof run addon add docs         # then: sof run docs
sof run addon remove docs
sof run addon update
```

Available: auto-types, docs, depgraph, atlas, spritesheet, html-luau, template, init, pix, asset, place, uploader, mesh-service, video, webserver, remote-exec, obfuscate, editable-mesh-bypasser.

Each add-on is a folder in `addons/` with a `sof-addon.json` (`name`, `version`, `command`, `entry`, `export`) and its own `package.json`, so its heavy dependencies (canvas, sharp, ffmpeg, ...) are only installed when you add it. Develop one with `sof run addon add --path addons/<name>`, publish it with `sof run addon publish addons/<name>` (bump its version first).

## Developing sof

```bash
npm install
npm test                 # resolver/linker tests
node bin/sof.js --help
npm run release          # dist/sof-<version>.zip
```

A release is a GitHub release tagged `v<version>` with `sof-<version>.zip`, `install.ps1` and `install.sh` attached. To try a build before releasing, run `install.ps1` with `$env:SOF_RELEASE_ZIP` pointing at the zip (and `$env:SOF_HOME` at a scratch folder).
