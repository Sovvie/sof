# sof

A command-line package manager and toolchain manager for Roblox projects (it installs Rojo, Selene and the rest per project). Everything else (docs generation, uploaders, video spritesheets, ...) is an optional add-on you install from inside sof.

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

Packages come from the sof registry at <https://sof.sov.gg> (point `SOF_REGISTRY_URL` somewhere else to use another one). Installing and searching need no account and no token. A package the registry doesn't have is looked up on [Wally](https://wally.run) instead, so a Wally dependency such as `evaera/promise@^4.0.0` is written and installed the same way.

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
- A `path` in `sof.toml` or `sof.lock` has to be a folder inside the project (relative, no `..`), and a package name has to be one plain file or folder name: install refuses anything else, and checks again, links followed, before it writes or deletes anything, so a repository you just cloned can't make `sof run install` touch files outside it.
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

**Using sof from an AI agent or a script.** Every command works without a terminal prompt: failures say what to do, `--json` is available on `account whoami` and `account grants`, and exit codes are non-zero on failure. Signing in (`account login`) and granting an add-on (`account grant`) are decisions for you: an agent should ask you to run them. So is trusting a project's `[scripts]` (`sof run script trust`): without a terminal an untrusted script is refused. An agent running sandboxed add-ons through sof never receives the login. An agent that can run arbitrary shell commands as you could still read `~/.sof/account.json` directly, so sof adds deny rules for `~/.sof` to Claude Code (`~/.claude/settings.json`) and the Cursor CLI (`~/.cursor/cli-config.json`) when it installs, updates itself or you sign in (`sof run account guard` does it by hand, `--status` shows it, `--off` removes the rules and stops sof adding them, as does `SOF_AI_GUARD=off`). It only touches tools that are already installed, only adds its own entries, and leaves a file it cannot parse alone. This blocks those tools' file reading and editing; it does not stop shell commands an agent is allowed to run, and other AI tools are not covered yet.

| Variable | Purpose |
| --- | --- |
| `SOF_REGISTRY_URL` | Registry to use instead of `https://sof.sov.gg` |
| `SOF_REGISTRY_TOKEN` | Registry token for CI (see above) |
| `SOF_AI_GUARD` | Set to `off` so sof does not add its deny rules for `~/.sof` to AI tools' settings |
| `SOF_ACCOUNT_PROTECTION` | Set to `off` to keep the sov.gg refresh token in `account.json` instead of the OS secret store |
| `SOF_NO_BROWSER` | Set to `1` to print the `sof run account login` address instead of opening a browser |
| `SOF_HOME` | Where sof keeps `auth.json`, add-ons, tools and their shims (default `~/.sof`) |
| `GITHUB_TOKEN` / `GH_TOKEN` | Raises GitHub's rate limit for tool downloads (sent to the GitHub API only) |
| `SOF_GITHUB_API_URL` | GitHub API to read tool releases from instead of `https://api.github.com` (GitHub Enterprise, a mirror) |
| `ROKIT_ROOT` | Where to look for tools Rokit already downloaded (default `~/.rokit`) |
| `SOF_OFFLINE` | Set to `1` to download nothing: installs use what is installed or kept in `~/.sof/cache` (same as `--offline`) |
| `SOF_REQUIRE_SANDBOX` | Set to `1` to refuse to run any add-on that doesn't declare `"sandbox": true` |
| `SOF_TRUST_SCRIPTS` | Set to `1` in a CI job you control to run `[scripts]` without having trusted them first |
| `SOF_WALLY_CLIENT_VERSION` | `Wally-Version` header sent when downloading from Wally (default `0.3.2`; Wally accepts 0.3.0 and newer) |

## Tools

sof installs and runs a project's tools (Rojo, Selene, StyLua, Wally, Lune, ...) itself, the way [Rokit](https://github.com/rojo-rbx/rokit), Aftman and Foreman do, so nobody on the project installs a separate toolchain manager and there is no `rokit.toml`. List the tools under `[tools]` in `sof.toml`, as `owner/repo@version` (a GitHub release):

```toml
[tools]
rojo = "rojo-rbx/rojo@7.6.1"
selene = "Kampfkarren/selene@0.30.1"
```

```bash
sof run install                       # packages + tools; only what is new or changed
sof run install --force               # reinstall everything
sof run tools install                 # tools only
sof run tools add rojo-rbx/rojo       # add the latest release to [tools] and install it
sof run tools add Kampfkarren/selene@0.28.0 --alias selene28   # a specific version, under another command name
sof run tools remove selene28
sof run tools outdated                # which tools have a newer release
sof run tools update                  # move all of them to the latest release (or: update rojo; --check only reports)
sof run tools list
sof run tools import                  # bring in the tools of a rokit.toml / aftman.toml / foreman.toml
sof run tools x JohnnyMorganz/StyLua --check src    # run a tool once, without adding it to a project
sof run tools which rojo              # the program "rojo" runs from this folder
sof run tools doctor                  # check shims, PATH and tools that something else shadows
sof run tools verify                  # installed tools vs sof.tools.lock, and unchanged since sof installed them
```

Each version is downloaded once into `~/.sof/tools/<owner>/<repo>/<version>`. A small shim named after each tool goes in `~/.sof/bin` (the folder the `sof` command itself lives in, already on your PATH), and running `rojo` there starts the version pinned in the nearest `sof.toml`, looking from the current folder upwards; a nearer file wins only for the tools it lists. Two projects can pin different versions of the same tool with nothing to switch. `sof run tools setup` prepares the folder (the installer and `sof run self update` run it for you). On Windows the shim is a real `.exe`, built once with the C# compiler that ships with Windows, because editors and other programs start tools without a shell and can't run `.cmd` files; on macOS and Linux it is a `sh` script. If another copy of a tool comes first on PATH (a Rokit, Aftman or Foreman link, a `cargo install`), `sof run tools install` and `doctor` warn about it. A few names can't be tool aliases (`node`, `npm`, `git`, `sh`, `curl`, anything starting with `sof`, and similar): a `sof.toml` from a repository you just cloned must not be able to put a program of that name first on your PATH.

sof picks the release file for your platform by name (`windows-x86_64`, `win64`, `macos-aarch64`, `linux-x86_64-musl`, ... all work; Windows on Arm and Apple silicon use an x64 build when there is no native one), opens `.zip`, `.tar.gz`, `.tar` and `.gz` files (and `.tar.xz`, with the `tar` program your system already has) or takes a bare executable, and keeps just the tool's executable. It checks the download against the size and sha256 GitHub lists for it. Set `GITHUB_TOKEN` (or `GH_TOKEN`) to raise GitHub's rate limit or reach a private repository's releases; it is only ever sent to `api.github.com`.

**Global tools.** `--global` on `install`, `add`, `remove`, `update`, `outdated`, `list` and `import` uses `~/.sof/tools.toml` (the same `[tools]` table) instead of `sof.toml`. Those tools work in every folder that doesn't pin its own version.

**Lockfile.** `sof run tools lock` writes `sof.tools.lock` next to `sof.toml`: the sha256 of the release file each tool was installed from, for your platform. Commit it. From then on every install checks its download against it, so a release that was swapped after you locked it is refused instead of run. Each platform adds its own lines the first time it installs, `sof run tools install --locked` fails unless the lock already covers every tool (for CI), and `lock --refresh` records this platform's checksums again. The file only exists once you ask for it.

**Verifying.** `sof run tools verify` reads files only: every tool in `[tools]` is installed, came from the file `sof.tools.lock` lists, and the program on disk is still byte for byte the one sof extracted (sof records a checksum of it at install time; tools installed by an older sof or copied from Rokit have none and are reported as such). It exits with 1 when something is wrong, so CI can run it.

**Moving from Rokit, Aftman or Foreman.** In a project that still has a `rokit.toml`, `aftman.toml` or `foreman.toml`, run `sof run tools import`: it adds that file's tools to `sof.toml` (creating it if needed), installs them and leaves the old file alone. Foreman tools from GitLab and version ranges can't be imported (sof pins one exact version); they are listed so you can add them by hand. For the machine itself, there is nothing to do but run `sof run install`: sof copies any version Rokit already downloaded (`~/.rokit/tool-storage`), deletes the `rokit.toml` that earlier sof versions generated in each project (one you wrote yourself is left alone) and the Rokit copy it kept in `~/.sof/rokit`. If `~/.rokit/bin` is still earlier on your PATH than `~/.sof/bin`, Rokit's links run first and no longer know your versions: take it off your PATH (`doctor` says so). `sof run tools rokit` is gone; its commands are built in.

## Scripts

Give a project its own named commands under `[scripts]` in `sof.toml`, so building, checking and publishing are the same on every machine and in CI:

```toml
[scripts]
build = "rojo build -o game.rbxl"
check = ["stylua --check src", "selene src"]      # in order, stopping at the first that fails
```

```bash
sof run script build                  # runs it from the folder of that sof.toml
sof run script check src/Server       # extra arguments go on the end of the last command
sof run script list                   # every script, and whether you have trusted it
sof run script --watch lint           # run it, then again whenever a watched file changes
```

**Pipelines.** A script can also be a table: `depends` lists scripts that run first (each once per run, even when several scripts need it), `run` is its own command or commands, `parallel = true` runs the `depends` at the same time (the others finish even if one fails, and the script's own commands only start when all of them succeeded), `watch` lists the globs `--watch` polls, and `description` shows in `list`.

```toml
[scripts]
lint  = { run = "selene src", watch = ["src/**", "selene.toml"] }
test  = { run = "lune run tests", watch = ["src/**", "tests/**"] }
ci    = { depends = ["lint", "test"], parallel = true, run = "rojo build -o game.rbxl", description = "what CI runs" }
```

One yes covers the whole pipeline: the prompt lists every script in the order it first runs, with all of its commands, and changing a script anywhere in it (or how they depend on each other) asks again. The size limit (25 commands, 3000 characters) counts the pipeline as a whole. `--watch` re-reads `sof.toml` before every run and stops if the pipeline is no longer the one you trusted. Arguments on the command line go on the last command of the script you named, which has to have a `run` of its own for that.

A script runs the versions pinned in `[tools]`, and a tool that starts another tool finds the pinned version of that one too. Scripts are built to be safe to keep in a repository you didn't write:

- **No shell.** A command is split into arguments and started directly, so there are no pipes, redirects, `&&`, `$VARIABLES` or backticks. An unquoted `| & ; < > ( ), a `#` that starts a word, a backtick or `%` is refused with an explanation instead of being guessed at: quote it (`"a && b"`) if you mean it as text, and use an array to run several commands. Globs and `~` are not expanded, and a backslash is just a backslash, so Windows paths work.
- **Only your tools.** The first word of a command is a tool from `[tools]` (at the version pinned there) or `sof`. It runs from where sof installed it and is never found through PATH; a path or any other program (`sh`, `powershell`, `curl`, `./something`) is refused. A script may ask sof only to set the project up (`sof run install`, `sof run package install|check|outdated|search`, `sof run tools install|list|outdated|doctor|which|lock|verify`), and then only with flags like `--force`: never a path, so it can't be pointed at another project's files (or a network share), and not to publish, sign in, add an add-on or run a tool you haven't pinned. Everything is checked before the first command starts, and if `sof.tools.lock` has a checksum for the tool, the installed copy has to match it.
- **You say yes first.** The first time a script runs, sof shows its commands, exactly as they will run, and the tool versions they use, and asks (a script is limited to 25 commands and 3000 characters so all of it fits on the screen; control and invisible characters are refused, and a question that ends without an answer, such as Ctrl-D, is a no). Your yes covers that script in that folder, exactly as shown: if a command changes, or `[tools]` starts pointing at another repository or version, sof asks again. It does not cover files a command reads (a script you hand to `lune`), so read those yourself. `sof run script trust` and `untrust` manage the list, which lives in `~/.sof/script-trust.json`.
- **Never on its own.** No install, update or other sof command runs a script.
- **Not without a person.** Without a terminal (CI, an AI agent) a script that isn't trusted is refused, and trusting one needs a terminal. For a CI job you control, `SOF_TRUST_SCRIPTS=1` skips the check.

## Offline installs and CI

```bash
sof run install --frozen      # CI: fail unless sof.lock and sof.tools.lock already pin everything
sof run install --offline     # download nothing; use what is installed or in the cache
sof run cache info            # where the cache is and how big it is
sof run cache clear [index|packages|tools]
```

Every install keeps what it downloaded in `~/.sof/cache` (the registry's answers, package archives, tool downloads), so an install that must work without a network just needs to have run once online. `--offline` (or `SOF_OFFLINE=1`) makes `sof run install`, `package install` and `tools install` use only what is installed or cached and say exactly what is missing instead of failing on a connection. `--frozen` is for CI and fresh clones: packages must match `sof.lock` (nothing is re-resolved) and every tool must have a checksum for your platform in `sof.tools.lock` (`sof run tools lock` creates it), so a build can't quietly pick up a different version. Cached archives are checked against the sha256 stored next to them each time they are read, and a package archive is also checked against `sof.lock` and the registry's checksum as always; a tool download is taken from the cache while online only when `sof.tools.lock` names exactly that file.

## Checking your setup

```bash
sof run doctor            # sof, tools, packages, scripts, add-ons, registry, account
sof run doctor --fix      # also do what is safe: shims, an add-on's npm dependencies, add-ons another one needs
sof run doctor --json     # for scripts; exits 1 when there is a problem
```

Doctor only reads (and, with `--fix`, repairs sof's own setup): it never downloads tools or packages and never touches your files. For those it prints the command to run (`sof run install`, `sof run tools install --force`, ...). Warnings and notes don't change the exit code.

## Copying a project

```bash
sof run copy ../MyGame-copy              # the project in the current folder
sof run copy Games/MyGame D:/Backups/MyGame# another project
sof run copy ../copy --dry-run                    # list what would be copied and skipped
```

Copies a project without what can be recreated there: files ignored by git (every `.gitignore`, `.git/info/exclude`, your global ignore), packages sof installed (each `<path>/<alias>` from `[[dependencies]]` and `sof.lock`), and whatever installed add-ons declare as generated, such as the modules a data-sync add-on writes. The `.git` folder is left out too (`--with-git` keeps it). `--exclude <glob>` skips more, `--force` copies into a folder that is not empty. `--all` copies everything, ignored and generated files and `.git` included.

It works on any folder or file, not only sof projects: outside a git repository the `.gitignore` files in the folder are read directly, a single file is copied as it is (into the destination if that is a folder), and symlinks are recreated (where the OS allows it; the summary counts any it could not). Run `sof run install` in the copy to get the packages back.

An add-on says what it generates in its `sof-addon.json`, as data, so sandboxed add-ons are covered too:

```json
"generated": ["table-sync.targets.output"],
"generatedPaths": ["table-sync/cache/**"]
```

`generated` lists keys of `sof.toml` whose values are paths (dotted, going through arrays of tables); `generatedPaths` lists globs relative to the project. Paths outside the project are ignored.

## Add-ons

```bash
sof run addon list             # installed and available add-ons
sof run addon search image     # search the registry's add-ons
sof run addon info img         # what it does and what it is allowed to do, before you install it
sof run addon add docs         # then: sof run docs   (add-ons it requires are installed too)
sof run addon outdated         # installed add-ons with a newer version
sof run addon remove docs      # refused while another installed add-on requires it (--force)
sof run addon update
```

Available: auto-types, docs, depgraph, atlas, spritesheet, html-luau, template, init, pix, asset, place, uploader, mesh-service, video, webserver, remote-exec, obfuscate, editable-mesh-bypasser, img, bundle.

- `sof run img <files|folders|globs> [--format webp] [--quality 80] [--width 1024] [--out dir]` batch-optimizes, resizes and converts images (PNG, JPEG, WebP, AVIF) with sharp; `--dry-run` shows the savings first. Defaults can live in an `[img]` table of `sof.toml`. See `addons/img/README.md`.
- `sof run bundle [folder] [-o file.zip|file.tar.gz] [--include glob] [--exclude glob] [--list]` packs a folder honoring `.gitignore`, always without `.git` and `node_modules`, with sorted entries and fixed timestamps so the same input gives the same bytes. It is sandboxed. Defaults can live in a `[bundle]` table. See `addons/bundle/README.md`.

Each add-on is a folder in `addons/` with a `sof-addon.json` and its own `package.json`, so its heavy dependencies (canvas, sharp, ffmpeg, ...) are only installed when you add it. The registry's add-ons are published to its admin-only `sofaddon` scope (`sof run addon publish addons/<name>` after bumping its version; it needs `sof run package login` as a registry admin).

### What an add-on may do

`sof run addon add` and `info` list what an add-on is allowed to do: whether it is **sandboxed** (`"sandbox": true`: it runs in a child process under Node's permission model, with no access to your sign-in, to files outside the project, or to other programs), which environment variables it reads, which sov.gg hosts it may ask to use (you are asked first), and what it requires. An add-on that isn't sandboxed runs with all your permissions. `SOF_REQUIRE_SANDBOX=1` makes sof refuse to run those. New add-ons from `addon new` are sandboxed; `addon test` and `publish` warn when `sandbox` isn't declared either way.

### Writing an add-on

```bash
sof run addon new hello               # scaffolds hello/ (sandboxed; --no-sandbox if it must start programs)
sof run addon add --path hello        # install the folder while you develop it
sof run addon test hello              # checks sof-addon.json, loads the entry, runs `npm test`
```

`sof-addon.json`: `name`, `version`, `command`, `entry`, `export` (default `run`), `usage`, `description`, `sandbox`, `env` (variables a sandboxed add-on may read), `account` (sov.gg hosts), and `requires`:

```json
"requires": {
  "sof": ">=2.7.3",
  "addons": { "docs": "^1.0.0" },
  "tools": ["ffmpeg"]
}
```

`requires.addons` are installed with the add-on (and it can only call those), `requires.tools` are aliases that must be pinned in `[tools]` of the project it runs in, and `requires.sof` is the sof version. An add-on whose requirements aren't met doesn't start and says which command fixes each.

The entry exports `run(argv, host)`. `host` (also available to sandboxed add-ons) has:

| | |
| --- | --- |
| `host.args.parse(argv, spec)` | Options and positional arguments from a spec (`flags`: type `boolean`/`string`/`number`/`integer`, `alias`, `repeat`, `default`, `min`/`max`, `choices`; `positional`: `{ name, min, max }`) with readable errors; `--help`, `--no-flag`, `--flag=value` and `--` work |
| `host.args.help(name, spec, summary)` | A help text built from the same spec |
| `host.log.info/success/warn/error/step/json`, `host.format.bytes/duration` | Output: results to stdout, progress and errors to stderr |
| `host.confirm(question)` | Asks on a terminal; `false` without one |
| `host.config()` | The `[addons.<name>]` table of the project's `sof.toml` |
| `host.addons.run(command, argv)` | Runs another add-on listed under `requires.addons` and resolves to its exit code. A sandboxed add-on can only call sandboxed ones |
| `host.tempDir()`, `host.tools.path(alias)` | Not sandboxed add-ons only: a scratch folder; the program a `requires.tools` alias runs |
| `host.sandboxed`, `host.name`, `host.version` | |

In a test, `createTestHost()` from sof's kit gives a host that records output and answers prompts; `sof run addon test` sets `SOF_ADDON_KIT` to its path (the scaffold's test shows how).

## Developing sof

```bash
npm install
npm test                 # resolver/linker tests
node bin/sof.js --help
npm run release          # dist/sof-<version>.zip
```

A release is a GitHub release tagged `v<version>` with `sof-<version>.zip`, `install.ps1` and `install.sh` attached. To try a build before releasing, run `install.ps1` with `$env:SOF_RELEASE_ZIP` pointing at the zip (and `$env:SOF_HOME` at a scratch folder).
