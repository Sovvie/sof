# bundle

Zip or tar.gz a project (or any folder) from include/exclude rules. General purpose, pure JavaScript, runs in sof's add-on sandbox.

```
sof run bundle [folder] [options]
```

`folder` defaults to the current directory. With no options you get `./dist/<folder name>-<version-or-date>.zip`
(the version comes from `--version`, `[bundle] version`, or the folder's `package.json`; otherwise today's date).

| Option | Meaning |
| --- | --- |
| `-o, --out <file>` | Output file. `.zip`, `.tar.gz` or `.tgz` decides the format. Parent folders are created. |
| `--format <zip\|tar.gz>` | Format, when the file name doesn't say. |
| `--include <glob>` | Only bundle matching files. Repeatable. Default: everything. |
| `--exclude <glob>` | Leave out matching files. Repeatable; added on top of the defaults. |
| `--no-gitignore` | Don't honor `.gitignore` files (root and nested). |
| `--name <name>`, `--version <v>` | Used for the default file name, and for the `--root-folder` folder name. |
| `--root-folder` | Put everything under `<name>/` inside the archive. |
| `--list` | Print the files (with sizes and a total) that would be bundled; write nothing. |
| `--reproducible` / `--no-reproducible` | On by default: sorted entries, fixed times (`SOURCE_DATE_EPOCH`, else 2020-01-01 UTC) and fixed modes (644, or 755 for executables), so the same input gives the same bytes. Off keeps real times and modes. |
| `--json` | Machine-readable result. |
| `-h, --help` | Help. |

Patterns are gitignore-style (`src/`, `*.log`, `docs/**/*.md`, `!keep.me`). `--include` filters files but never hides folders from the walk.

Always left out: `.git`, `node_modules`, the output file (and its `.part` file), and the folder's own `dist/`.

When it's done it prints the output path, file count, size and SHA-256.

## sof.toml

The nearest `sof.toml` at or above the folder may have a `[bundle]` table. Command-line flags win (a list given on the command line replaces the table's list).

```toml
[bundle]
include = ["src", "assets", "README.md"]
exclude = ["*.psd"]
out = "dist/game.zip"      # relative to the bundled folder
format = "zip"
name = "game"
version = "1.4.0"
root_folder = true
gitignore = true
```

## Safety

- Symlinks are never followed; they are skipped and listed in the output.
- The archive is never written into itself.
- `--out` refuses an existing file inside the folder unless it's an earlier archive being re-created, and refuses folders and symlinks.
- Files are written to `<out>.part` first and moved into place when complete.

## Notes

- `.zip` has no zip64 support here (4 GB / 65535 files); use `.tar.gz` for bigger bundles. Archives are written by this add-on itself (ZIP with deflate, ustar tar with GNU long names), so output doesn't depend on a native tool.
- Reproducible output assumes the same Node/zlib build; the gzip header is pinned (no time, fixed OS byte).
