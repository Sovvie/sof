"use strict";

const path = require("path");

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
  const mb = kb / 1024;
  return `${Math.round(mb * 10) / 10} MB`;
}

function formatPercent(before, after) {
  if (!before) return "0%";
  const pct = Math.round(((after - before) / before) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function displayPath(file, cwd) {
  const rel = path.relative(cwd, file);
  const shown = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
  return shown.split(path.sep).join("/");
}

/** result: { src, dest, status: ok|skipped|failed, inBytes, outBytes, error } */
function formatLine(result, cwd) {
  const src = displayPath(result.src, cwd);
  if (result.status === "failed") return `${src} -> FAILED: ${result.error}`;
  const dest = displayPath(result.dest, cwd);
  const sizes = `${formatBytes(result.inBytes)} -> ${formatBytes(result.outBytes)} (${formatPercent(result.inBytes, result.outBytes)})`;
  if (result.status === "skipped") return `${src} -> ${dest}  ${sizes}  kept original (${result.reason || "not smaller"})`;
  return `${src} -> ${dest}  ${sizes}`;
}

function summarize(results) {
  const s = { files: results.length, ok: 0, skipped: 0, failed: 0, inBytes: 0, outBytes: 0 };
  for (const r of results) {
    if (r.status === "failed") {
      s.failed += 1;
      continue;
    }
    s[r.status] += 1;
    s.inBytes += r.inBytes;
    s.outBytes += r.status === "skipped" ? r.inBytes : r.outBytes;
  }
  s.savedBytes = s.inBytes - s.outBytes;
  return s;
}

function formatTotal(summary, dryRun) {
  const parts = [
    `${dryRun ? "Would process" : "Processed"} ${summary.files} file${summary.files === 1 ? "" : "s"}`,
    `${formatBytes(summary.inBytes)} -> ${formatBytes(summary.outBytes)} (${formatPercent(summary.inBytes, summary.outBytes)})`,
  ];
  if (summary.skipped) parts.push(`${summary.skipped} kept`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  return `Total: ${parts.join(", ")}`;
}

function buildJson(results, options, cwd) {
  const summary = summarize(results);
  return {
    dryRun: Boolean(options.dryRun),
    files: results.map((r) => ({
      src: displayPath(r.src, cwd),
      dest: r.dest ? displayPath(r.dest, cwd) : null,
      status: r.status,
      inBytes: r.inBytes ?? null,
      outBytes: r.status === "failed" ? null : r.status === "skipped" ? r.inBytes : r.outBytes,
      ...(r.error ? { error: r.error } : {}),
    })),
    summary,
  };
}

module.exports = { formatBytes, formatPercent, displayPath, formatLine, summarize, formatTotal, buildJson };
