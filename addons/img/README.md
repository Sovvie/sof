## `sof run img`

Batch image optimize, resize and convert (uses `sharp`).

```
sof run img <input...> [options]
```

Inputs are files, folders or globs. Folders are walked for png, jpg, jpeg, webp, avif, gif and tiff files.

| Option | Meaning |
| --- | --- |
| `--out <dir>` | Write results into this folder, mirroring the relative layout. Default: next to each input with a `.min` suffix (or the new extension when converting). The source is never overwritten unless `--in-place`. |
| `--in-place` | Overwrite the sources. The result is kept only if it is smaller. With `--format` that changes the extension, the source is left alone unless `--delete-source`. |
| `--delete-source` | With `--in-place` and a changed extension: remove the source after a successful conversion. |
| `--format <png\|jpeg\|webp\|avif>` | Convert. |
| `--quality <1-100>` | Encoder quality (default 80). PNG quality below 100 uses a palette. |
| `--width <px>` `--height <px>` | Resize; the aspect ratio is kept when only one is given. |
| `--fit <inside\|cover\|contain\|fill>` | Resize mode (default `inside`). |
| `--enlarge` | Allow upscaling (default: never upscale; `--no-enlarge` is the default). |
| `--strip` / `--keep-metadata` | Drop (default) or keep metadata. |
| `--lossless` | Lossless webp / png / avif. |
| `--recursive` / `--no-recursive` | Walk folders deeply (default) or only the top level. |
| `--dry-run` | Show what would happen and the estimated savings without writing. |
| `--json` | Machine-readable report. |

Optional defaults in the nearest `sof.toml` (flags win; `out` is relative to that file):

```toml
[img]
format = "webp"
quality = 75
width = 1024
out = "dist/img"
```

Output is one line per file, e.g. `src/a.png -> out/a.webp  120 KB -> 31 KB (-74%)`, then a total line. The exit code is 1 if any file failed; the others are still processed.

Install the dependencies once with `npm install --omit=dev` inside the add-on folder. The add-on is not sandboxed because `sharp` is a native module.
