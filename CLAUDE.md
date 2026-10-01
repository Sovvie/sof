# CLAUDE.md

Guidance for AI agents working in this repo (the sof CLI).

## Finishing a change means pushing and releasing it

The owner wants shipped work, not local work. When a change to sof is done and tested, do **all** of this without waiting to be asked again. "Release it" / "ship it" / "push it" all mean the full sequence:

1. `npm test` must pass.
2. Bump the version in `package.json` and `package-lock.json` with `npm version <patch|minor|major> --no-git-tag-version` (patch for fixes, minor for features, major for breaking changes).
3. Commit only the files that belong to the change, then tag it `v<version>`. The working tree often holds the owner's unrelated uncommitted work (for example `addons/` changes or README sections for other features): never `git add -A` or `git commit -a`. Stage files by name, and use `git apply --cached` with a trimmed patch when one file mixes your hunks with theirs.
4. Push the branch and the tag: `git push origin main v<version>`.
5. Build the release zip: `npm run release` (writes `dist/sof-<version>.zip`).
6. Publish the GitHub release: `npm run publish-release`. It creates release `v<version>` and uploads `dist/sof-<version>.zip`, `install.ps1` and `install.sh`, which is what the installers and `sof run self update` download. It is safe to re-run. It uses `GITHUB_TOKEN`/`GH_TOKEN`, or else the token git already has stored for github.com; never print or log that token.
7. Confirm with `sof run self update` (or by opening the printed release URL) and tell the owner the version and link.

A push without a release leaves `sof run self update` on the old version, so never stop after step 4.

## Keep docs in step with the code

`README.md` documents every command and flag. When a change alters a command, option or behavior, update the README in the same commit.

## Notes

- sof's per-project install record lives in `~/.sof/state`, not in the project. Bump `STATE_VERSION` in `src/packages/state.js` whenever the linker's output changes, so older installs are redone once.
- The repo moved to `github.com/Sovvie/sof`; git still accepts the old `sovvie/sof` URL.
- Packages live on the sof registry, `https://sov.gg/sof-index` (override with `SOF_REGISTRY_URL`), no longer in the `sovvie/sof-index` GitHub repo. Reading and searching need no token. Publishing uses a GitHub device-flow sign-in (`sof run package login`, saved in `~/.sof/auth.json`) or `SOF_REGISTRY_TOKEN`; `SOF_TOKEN` and `GITHUB_TOKEN` are deliberately not used, since the registry only accepts tokens from its own GitHub app. Never print or commit a token.
- **Published versions are permanent**: a version can be yanked but never deleted, and its number can never be reused. Never `sof run package publish` or `sof run addon publish` against the live registry as a test, and not at all without the owner's go-ahead. Tests use a local fake registry (`test/helpers.js`), and `SOF_REGISTRY_URL` can point manual checks at a stub. `sof run addon publish` puts the add-on on the public registry, so only run it for add-ons that are meant to be public.
- The registry validates uploads server-side; `src/packages/validate.js` is a local copy of its rules that publish runs first. When the registry's rules change, update that file and the README's Publishing section together.
- `addons/depgraph/src/packages/` carries its own copy of the package code (it still reads the old index repo); it is not part of the CLI's registry client.
