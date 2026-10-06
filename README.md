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

Packages come from the sof registry at <https://sov.gg/sof-index> (point `SOF_REGISTRY_URL` somewhere else to use another one). Installing and searching need no account and no token. A package the registry doesn't have is looked up on [Wally](https://wally.run) instead, so a Wally dependency such as `evaera/promise@^4.0.0` is written and installed the same way.

In a game repo, list dependencies in `sof.toml`:

```toml
[[dependencies]]
path = "src/ReplicatedStorage/Packages"
Router = "sovvie/router@^1.0.0"
Stream = "sovvie/stream@^2.0.0"
Promise = "evaera/promise@^4.0.0"   # not in the sof registry, so installed from Wally
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
- Installs are incremental. sof remembers what it installed (in `~/.sof/state`, nothing is added to your project) and on the next run only downloads packages that are new, changed version, or missing/edited on disk. When nothing changed it doesn't even contact the registry. `sof run package install --force` reinstalls everything.
- A yanked version (see below) is never chosen by a fresh install or update, but stays downloadable, so a project whose `sof.lock` pins it keeps working.

## Publishing

Publishing to the sof registry needs a GitHub sign-in (GitHub's device flow, like Wally; no password ever touches sof). The scope you publish to is your lowercased GitHub username, and your first publish claims it.

```bash
sof run package login          # shows a code to enter at github.com/login/device, saves ~/.sof/auth.json
sof run package whoami         # who you are, the scopes you own, the scope a first publish would claim
sof run package publish        # packages described in packages.sof.toml / sof.toml
sof run package owner add sovvie friend      # let another GitHub user publish to a scope you own (or: remove)
sof run package yank sovvie/router 1.0.0     # hide a version from new installs (or: unyank)
sof run package logout
```

Describe packages in `packages.sof.toml` (or `sof.toml`):

```toml
[[package]]
name = "sovvie/router"
version = "1.0.0"
description = "UI navigation with animated transitions"
include = "src/Router"
exclude = ["**/README.md"]

[package.dependencies]
Stream = "sovvie/stream@^2.0.0"
Butler = "sovvie/butler@^1.0.0"
```

- **Versions are immutable.** A published version can't be changed, deleted or published again; bump `version` to ship a fix. Yank a bad version instead.
- **CI:** set `SOF_REGISTRY_TOKEN` rather than running `login`; it wins over the saved sign-in. Only tokens issued by the registry's own GitHub app work: `GITHUB_TOKEN` and `SOF_TOKEN` are not used.
- `sof run package publish` checks the package against the registry's rules before uploading (allowed file types `.luau .lua .json .toml .md .txt .yml .yaml` plus `LICENSE`/`README`/..., no symlinks, `.git` or `node_modules`, size and path limits, name and version formats), so most rejections show up locally with a list. The registry checks again on upload.
- **Held for review.** Code that loads remote assets (`require(<asset id>)`, `loadstring`, `InsertService:LoadAsset`) is accepted but held: publish reports it as held for review, with the findings, and it goes live once a registry admin approves it.
`sof run package check` validates that every `require(script.Parent.X)` in a package matches a declared dependency.

## Your sov.gg account, and private add-ons

`sof run account` is your sign-in to the company's Authentik (sov.gg). It is separate from `sof run package login`, which is the GitHub sign-in used to publish packages.

```
sof run account login      # opens your browser for the normal sign-in (SSO, MFA included)
sof run account whoami     # who you are signed in as ("--json" for scripts)
sof run account logout     # forget it
sof run account grants     # which add-ons may use your account ("--json" for scripts)
sof run account grant <addon>    # allow an add-on to use it (you, in your own terminal)
sof run account revoke <addon>
```

Nothing to copy or paste: the browser returns to a local port on your own machine (OAuth authorization code with PKCE), and sof keeps a short-lived token (10 minutes, refreshed automatically for about 30 days) in `~/.sof/account.json`, mode 0600. The long-lived refresh token is not stored in that file in the clear: it is protected by your operating system (Windows DPAPI, bound to your Windows user; macOS Keychain; Linux `secret-tool`/libsecret), so a copied or casually read `account.json` is not enough to use the login. This stops file reads, backups and other users; it does not stop a program running as you that asks the OS to decrypt, which is why add-ons are sandboxed. Where no store exists, sof says so and keeps the 0600 file. `SOF_ACCOUNT_PROTECTION=off` turns this off (containers, CI). Access ends within about 10 minutes of being removed from the staff group. On a machine with no browser, set `SOF_NO_BROWSER=1` to get the address to open elsewhere (the browser must be on the same machine, because it returns to `127.0.0.1`).

**Private add-ons.** Some add-ons are private to the company: the registry answers them exactly like a package that doesn't exist, unless you are signed in. After `sof run account login`, `sof run addon add <name>` and `sof run addon list` include them. A private add-on is put on the registry through the registry website's upload page, not with `sof run addon publish` (which publishes publicly). Upload it as `sofaddon/<name>`, marked staff-only.

**Add-ons use the account without seeing it.** An add-on that sets `"sandbox": true` in `sof-addon.json` runs in a child process under Node's permission model (Node 22.13 or newer): it can only read and write the project folder you run it from (plus paths you pass as arguments) and its own folder, it cannot read `~/.sof` (where the login lives), start programs, or see secrets in the environment. To reach sov.gg it asks sof, which attaches the login itself and only talks to the hosts the add-on declared under `"account": { "hosts": [...] }` and you granted, and only to hosts sof allows at all (the registry and `roblox-sync.sov.gg`). The first time such an add-on needs the account, sof asks you; `sof run account grants` and `revoke` manage that. The token is only ever sent to the registry it was issued for.

Add-ons without `"sandbox": true` still run inside sof's own process, trusted like sof itself, so they could read the login file. Sandboxing is opt-in per add-on for now (many add-ons start programs or servers, which the sandbox forbids).

**Using sof from an AI agent or a script.** Every command works without a terminal prompt: failures say what to do, `--json` is available on `account whoami` and `account grants`, and exit codes are non-zero on failure. Signing in (`account login`) and granting an add-on (`account grant`) are decisions for you: an agent should ask you to run them. An agent running sandboxed add-ons through sof never receives the login. An agent that can run arbitrary shell commands as you could still read `~/.sof/account.json` directly, so sof adds deny rules for `~/.sof` to Claude Code (`~/.claude/settings.json`) and the Cursor CLI (`~/.cursor/cli-config.json`) when it installs, updates itself or you sign in (`sof run account guard` does it by hand, `--status` shows it, `--off` removes the rules and stops sof adding them, as does `SOF_AI_GUARD=off`). It only touches tools that are already installed, only adds its own entries, and leaves a file it cannot parse alone. This blocks those tools' file reading and editing; it does not stop shell commands an agent is allowed to run, and other AI tools are not covered yet.

| Variable | Purpose |
| --- | --- |
| `SOF_REGISTRY_URL` | Registry to use instead of `https://sov.gg/sof-index` |
| `SOF_REGISTRY_TOKEN` | Registry token for CI (see above) |
| `SOF_AI_GUARD` | Set to `off` so sof does not add its deny rules for `~/.sof` to AI tools' settings |
| `SOF_ACCOUNT_PROTECTION` | Set to `off` to keep the sov.gg refresh token in `account.json` instead of the OS secret store |
| `SOF_NO_BROWSER` | Set to `1` to print the `sof run account login` address instead of opening a browser |
| `SOF_HOME` | Where sof keeps `auth.json`, add-ons and its Rokit (default `~/.sof`) |
| `SOF_WALLY_CLIENT_VERSION` | `Wally-Version` header sent when downloading from Wally (default `0.3.2`; Wally accepts 0.3.0 and newer) |

## Tools

sof has [Rokit](https://github.com/rojo-rbx/rokit) built in, so nobody on the project installs or runs Rokit (or Aftman/Foreman) themselves. List a project's tools under `[tools]` in `sof.toml`:

```toml
[tools]
rojo = "rojo-rbx/rojo@7.6.1"
selene = "Kampfkarren/selene@0.30.1"
```

```bash
sof run install                       # packages + tools; only what is new or changed
sof run install --force               # reinstall everything
sof run tools install                 # tools only (skips tools Rokit already has)
sof run tools add rojo-rbx/rojo       # add the latest release to [tools] and install it
sof run tools list
```

sof downloads its own Rokit into `~/.sof/rokit` and sets it up the first time (the installer does this too, or run `sof run tools setup`): tools are linked into `~/.rokit/bin`, which is added to your PATH, and each tool runs at the version pinned in the nearest `rokit.toml`. sof writes that `rokit.toml` from `[tools]`, so `sof.toml` is the only file you edit; gitignore the generated `rokit.toml`. If another toolchain manager's copy of a tool comes first on PATH, `sof run tools install` warns about it. `sof run tools rokit <args>` runs the built-in Rokit directly for anything else.

## Add-ons

```bash
sof run addon list             # installed and available add-ons
sof run addon add docs         # then: sof run docs
sof run addon remove docs
sof run addon update
```

Available: auto-types, docs, depgraph, atlas, spritesheet, html-luau, template, init, pix, asset, place, uploader, mesh-service, video, webserver, remote-exec, obfuscate, editable-mesh-bypasser.

Each add-on is a folder in `addons/` with a `sof-addon.json` (`name`, `version`, `command`, `entry`, `export`) and its own `package.json`, so its heavy dependencies (canvas, sharp, ffmpeg, ...) are only installed when you add it. Develop one with `sof run addon add --path addons/<name>`, publish it with `sof run addon publish addons/<name>` (bump its version first; it goes to the registry's admin-only `sofaddon` scope, so it needs `sof run package login` as a registry admin).

## Developing sof

```bash
npm install
npm test                 # resolver/linker tests
node bin/sof.js --help
npm run release          # dist/sof-<version>.zip
```

A release is a GitHub release tagged `v<version>` with `sof-<version>.zip`, `install.ps1` and `install.sh` attached. To try a build before releasing, run `install.ps1` with `$env:SOF_RELEASE_ZIP` pointing at the zip (and `$env:SOF_HOME` at a scratch folder).
