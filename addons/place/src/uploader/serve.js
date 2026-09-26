"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  DEFAULT_REMOTE_EXEC_PORT,
  DEFAULT_REMOTE_EXEC_TIMEOUT_MS,
  uploadMeshesViaRemoteExec,
} = require("./remote-exec-mesh");
const {
  loadUploaderEnv,
  writeUploaderEnv,
  LOCAL_UPLOADER_ENV_PATH,
  sanitizeApiKey,
  sanitizeRoblosecurity,
} = require("./env");

// ============================================================
// Utilities
// ============================================================

function readRawBody(req, maxSize = 500 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req, 10 * 1024 * 1024);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function parseMultipart(body, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const crlfcrlf = Buffer.from("\r\n\r\n");
  const crlf = Buffer.from("\r\n");

  const files = [];
  const fields = {};
  let pos = 0;

  while (true) {
    const bStart = body.indexOf(boundaryBuf, pos);
    if (bStart === -1) break;

    const afterBoundary = bStart + boundaryBuf.length;
    if (
      body[afterBoundary] === 0x2d &&
      body[afterBoundary + 1] === 0x2d
    ) {
      break;
    }

    const headerStart = afterBoundary + crlf.length;
    const headerEnd = body.indexOf(crlfcrlf, headerStart);
    if (headerEnd === -1) break;

    const headers = body.slice(headerStart, headerEnd).toString("utf8");
    const contentStart = headerEnd + crlfcrlf.length;
    const nextBoundary = body.indexOf(boundaryBuf, contentStart);
    const contentEnd =
      nextBoundary === -1 ? body.length : nextBoundary - crlf.length;
    const content = body.slice(contentStart, contentEnd);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    if (filenameMatch) {
      files.push({
        fieldName: nameMatch ? nameMatch[1] : "file",
        filename: filenameMatch[1],
        data: content,
      });
    } else if (nameMatch) {
      fields[nameMatch[1]] = content.toString("utf8");
    }

    pos = nextBoundary === -1 ? body.length : nextBoundary;
  }

  return { files, fields };
}

async function receiveMultipart(req) {
  const contentType = req.headers["content-type"] || "";
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  if (!match) throw new Error("Missing multipart boundary.");
  const boundary = match[1] || match[2];
  const body = await readRawBody(req);
  return parseMultipart(body, boundary);
}

function createJobTempDir() {
  const dir = path.join(
    os.tmpdir(),
    `sof-uploader-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanJobTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function createStream(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  return {
    progress(done, total, message) {
      res.write(
        JSON.stringify({ type: "progress", done, total, message }) + "\n"
      );
    },
    complete(report) {
      res.write(JSON.stringify({ type: "complete", ...report }) + "\n");
      res.end();
    },
    error(message) {
      res.write(JSON.stringify({ type: "error", message }) + "\n");
      res.end();
    },
  };
}

function friendlyError(err) {
  const msg = err.message || String(err);
  if (/apiKey required/i.test(msg) || /ROBLOX_API_KEY/i.test(msg)) {
    return "Your Roblox API key is missing. Please set it up on the Setup page before uploading.";
  }
  if (/cookie not found/i.test(msg) || /ROBLOSECURITY/i.test(msg)) {
    return "Your Roblox cookie is missing or expired. Please update it on the Setup page.";
  }
  if (/status 401/i.test(msg)) {
    return "Roblox rejected your credentials. They may have expired \u2014 please update them on the Setup page.";
  }
  if (/status 403/i.test(msg)) {
    return "You don\u2019t have permission to upload to this account. Double-check your Creator ID and credentials.";
  }
  if (/status 429/i.test(msg) || /rate limit/i.test(msg)) {
    return "Too many requests sent to Roblox. The uploader will wait and retry automatically.";
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return "Couldn\u2019t reach Roblox servers. Please check your internet connection and try again.";
  }
  if (/Timed out waiting for Roblox plugin connection/i.test(msg)) {
    return "Remote Exec mesh upload timed out waiting for the Studio plugin. Make sure Studio is open, the Remote Exec plugin is enabled, and the port matches.";
  }
  if (/No Roblox plugin is connected/i.test(msg)) {
    return "Remote Exec mesh upload requires an active Studio plugin connection.";
  }
  return msg;
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function hasConfiguredCreatorId(value) {
  return /^\d+$/.test(String(value || "").trim());
}

// ============================================================
// API Handlers
// ============================================================

function handleCredentialsStatus(_req, res) {
  loadUploaderEnv();
  const hasApiKey = !!sanitizeApiKey(process.env.ROBLOX_API_KEY);
  const hasCookie = !!sanitizeRoblosecurity(process.env.ROBLOSECURITY);
  const hasCreatorId = hasConfiguredCreatorId(process.env.ROBLOX_CREATOR_ID);

  jsonResponse(res, 200, {
    configured: hasApiKey && hasCookie && hasCreatorId,
    hasApiKey,
    hasCookie,
    hasCreatorId,
    envPath: LOCAL_UPLOADER_ENV_PATH,
    envExists: fs.existsSync(LOCAL_UPLOADER_ENV_PATH),
  });
}

async function handleSaveCredentials(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return jsonResponse(res, 400, { success: false, message: err.message });
  }

  try {
    const savedPath = writeUploaderEnv({
      apiKey: body.apiKey,
      roblosecurity: body.roblosecurity,
      creatorId: body.creatorId,
    });

    process.env.ROBLOX_API_KEY = String(body.apiKey || "").trim();
    process.env.ROBLOSECURITY = String(body.roblosecurity || "").trim();
    process.env.ROBLOX_CREATOR_ID = String(body.creatorId || "").trim();

    jsonResponse(res, 200, {
      success: true,
      message: `Credentials saved to ${savedPath}`,
    });
  } catch (err) {
    jsonResponse(res, 400, { success: false, message: err.message });
  }
}

async function handleUploadFiles(req, res, mode) {
  const stream = createStream(res);
  let tempDir;

  try {
    const { files, fields } = await receiveMultipart(req);
    if (files.length === 0) {
      return stream.error("No files were selected. Please choose at least one file to upload.");
    }

    tempDir = createJobTempDir();
    const filePaths = [];
    for (const file of files) {
      const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const savePath = path.join(tempDir, `${Date.now()}-${safeName}`);
      fs.writeFileSync(savePath, file.data);
      filePaths.push(savePath);
    }

    const {
      uploadImageFiles,
      uploadModelFiles,
      resolveCreatorId,
    } = require("./asset-upload");

    const creatorId = await resolveCreatorId({
      creatorID: fields.creatorId || null,
      isGroup: fields.isGroup === "true",
    });

    const onProgress = (done, total, message) => {
      stream.progress(done, total, message);
    };

    let report;
    if (mode === "image-files") {
      report = await uploadImageFiles({
        filePaths,
        creatorID: creatorId,
        isGroup: fields.isGroup === "true",
        apiKey: fields.apiKey || undefined,
        onProgress,
      });
    } else {
      report = await uploadModelFiles({
        filePaths,
        creatorID: creatorId,
        isGroup: fields.isGroup === "true",
        apiKey: fields.apiKey || undefined,
        onProgress,
      });
    }

    stream.complete({
      results: report.results || [],
      moderated: report.moderated || [],
      failures: report.failures || [],
    });
  } catch (err) {
    stream.error(friendlyError(err));
  } finally {
    if (tempDir) cleanJobTempDir(tempDir);
  }
}

async function handleReupload(req, res, mode) {
  const stream = createStream(res);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return stream.error(err.message);
  }

  const assetIds = (body.assetIds || []).filter(Boolean);
  if (assetIds.length === 0) {
    return stream.error(
      "No asset IDs were provided. Enter at least one Roblox asset ID to continue."
    );
  }

  try {
    const {
      uploadImages,
      uploadAnimations,
      uploadMeshes,
      resolveCreatorId,
    } = require("./asset-upload");

    const onProgress = (done, total, message) => {
      stream.progress(done, total, message);
    };

    const useRemoteExec =
      mode === "meshes" && (body.useRemoteExec === true || body.useRemoteExec === "true");

    if (useRemoteExec) {
      const report = await uploadMeshesViaRemoteExec({
        assetIDs: assetIds,
        creatorID: body.creatorId || null,
        cookie: body.cookie || undefined,
        isGroup: !!body.isGroup,
        remotePort: body.remotePort ?? DEFAULT_REMOTE_EXEC_PORT,
        remoteTimeout: body.remoteTimeout ?? DEFAULT_REMOTE_EXEC_TIMEOUT_MS,
        onProgress,
      });

      stream.complete({
        results: report.results || [],
        moderated: report.moderated || [],
        failures: report.failures || [],
      });
      return;
    }

    const creatorId = await resolveCreatorId({
      creatorID: body.creatorId || null,
      isGroup: !!body.isGroup,
    });

    const common = {
      assetIDs: assetIds,
      creatorID: creatorId,
      isGroup: !!body.isGroup,
      cookie: body.cookie || undefined,
      onProgress,
    };

    let report;
    if (mode === "images") {
      report = await uploadImages({
        ...common,
        apiKey: body.apiKey || undefined,
      });
    } else if (mode === "animations") {
      report = await uploadAnimations(common);
    } else {
      report = await uploadMeshes({
        ...common,
        apiKey: body.apiKey || undefined,
      });
    }

    stream.complete({
      results: report.results || [],
      moderated: report.moderated || [],
      failures: report.failures || [],
    });
  } catch (err) {
    stream.error(friendlyError(err));
  }
}

// ============================================================
// Router
// ============================================================

async function handleRequest(req, res, port) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const pathname = url.pathname;

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getDashboardHTML(port));
    return;
  }

  if (req.method === "GET" && pathname === "/api/credentials/status") {
    return handleCredentialsStatus(req, res);
  }
  if (req.method === "POST" && pathname === "/api/credentials") {
    return handleSaveCredentials(req, res);
  }
  if (req.method === "POST" && pathname === "/api/upload/image-files") {
    return handleUploadFiles(req, res, "image-files");
  }
  if (req.method === "POST" && pathname === "/api/upload/model-files") {
    return handleUploadFiles(req, res, "model-files");
  }
  if (req.method === "POST" && pathname === "/api/upload/images") {
    return handleReupload(req, res, "images");
  }
  if (req.method === "POST" && pathname === "/api/upload/animations") {
    return handleReupload(req, res, "animations");
  }
  if (req.method === "POST" && pathname === "/api/upload/meshes") {
    return handleReupload(req, res, "meshes");
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// ============================================================
// Dashboard HTML
// ============================================================

function getDashboardHTML(port) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sof Uploader</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --sidebar-w:240px;
  --primary:#3b82f6;--primary-h:#2563eb;
  --success:#22c55e;--success-bg:#f0fdf4;
  --warn:#f59e0b;--warn-bg:#fffbeb;
  --error:#ef4444;--error-bg:#fef2f2;
  --bg:#f8fafc;--surface:#fff;
  --sidebar:#0f172a;--sidebar-h:#1e293b;--sidebar-a:#334155;
  --text:#1e293b;--text2:#64748b;--text3:#94a3b8;
  --border:#e2e8f0;
  --radius:8px;--radius-lg:12px;
  --shadow:0 1px 3px rgba(0,0,0,.1),0 1px 2px rgba(0,0,0,.06);
  --shadow-lg:0 10px 15px rgba(0,0,0,.1),0 4px 6px rgba(0,0,0,.05);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh}
.app{display:flex;min-height:100vh}
.sidebar{width:var(--sidebar-w);background:var(--sidebar);color:#fff;display:flex;flex-direction:column;position:fixed;top:0;bottom:0;left:0;z-index:10}
.sidebar-brand{padding:22px 20px;font-size:17px;font-weight:700;border-bottom:1px solid rgba(255,255,255,.08);letter-spacing:.3px}
.sidebar-brand span{color:var(--primary);margin-right:2px}
.sidebar nav{flex:1;padding:12px 0}
.nav-link{display:flex;align-items:center;gap:12px;padding:11px 20px;color:rgba(255,255,255,.6);text-decoration:none;cursor:pointer;transition:all .15s;font-size:14px;font-weight:500;border-left:3px solid transparent}
.nav-link:hover{background:var(--sidebar-h);color:#fff}
.nav-link.active{background:var(--sidebar-a);color:#fff;border-left-color:var(--primary)}
.nav-link svg{width:18px;height:18px;flex-shrink:0;opacity:.7}
.nav-link.active svg{opacity:1}
.sidebar-footer{padding:16px 20px;font-size:12px;color:rgba(255,255,255,.35);border-top:1px solid rgba(255,255,255,.08)}
.main{flex:1;margin-left:var(--sidebar-w);padding:32px 40px;max-width:900px}
.tab-panel{display:none}.tab-panel.active{display:block}
.section-hdr h2{font-size:22px;font-weight:700;margin-bottom:4px}
.section-hdr p{color:var(--text2);font-size:14px;margin-bottom:24px;line-height:1.5}
.card{background:var(--surface);border-radius:var(--radius-lg);box-shadow:var(--shadow);padding:24px;margin-bottom:20px}
.form-group{margin-bottom:18px}
.form-group label{display:block;font-size:13px;font-weight:600;color:var(--text);margin-bottom:5px}
.form-group input,.form-group textarea{width:100%;padding:9px 13px;border:1px solid var(--border);border-radius:6px;font-size:14px;font-family:var(--font);transition:border-color .15s;background:var(--surface)}
.form-group input:focus,.form-group textarea:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(59,130,246,.1)}
.form-group textarea{min-height:100px;resize:vertical}
.hint{font-size:12px;color:var(--text2);margin-top:4px;line-height:1.4}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:9px 20px;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s;font-family:var(--font)}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover{background:var(--primary-h)}
.btn-primary:disabled{opacity:.55;cursor:not-allowed}
.btn-secondary{background:var(--bg);color:var(--text);border:1px solid var(--border)}
.btn-secondary:hover{background:var(--border)}
.toggle-group{display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:20px;width:fit-content}
.toggle-btn{padding:8px 18px;border:none;background:var(--surface);color:var(--text2);font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:var(--font)}
.toggle-btn+.toggle-btn{border-left:1px solid var(--border)}
.toggle-btn.active{background:var(--primary);color:#fff}
.drop-zone{border:2px dashed var(--border);border-radius:var(--radius-lg);padding:44px 24px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:16px}
.drop-zone:hover,.drop-zone.drag-over{border-color:var(--primary);background:rgba(59,130,246,.03)}
.drop-zone svg{margin-bottom:10px;color:var(--text3)}
.drop-zone .dz-title{font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px}
.drop-zone .dz-sub{font-size:13px;color:var(--text2)}
.drop-zone .dz-formats{font-size:12px;color:var(--text3);margin-top:10px}
.file-list{margin-bottom:16px}
.file-item{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:var(--bg);border-radius:6px;margin-bottom:6px;font-size:14px}
.file-item .fi-name{font-weight:500;word-break:break-all}
.file-item .fi-size{color:var(--text2);font-size:13px;margin-left:12px;white-space:nowrap}
.file-item .fi-remove{background:none;border:none;color:var(--text3);cursor:pointer;font-size:18px;padding:0 4px;line-height:1;transition:color .15s}
.file-item .fi-remove:hover{color:var(--error)}
.advanced-toggle{font-size:13px;color:var(--primary);cursor:pointer;font-weight:600;margin-bottom:12px;display:inline-flex;align-items:center;gap:4px;user-select:none}
.advanced-toggle:hover{text-decoration:underline}
.advanced-body{margin-bottom:16px}
.advanced-body.collapsed{display:none}
.checkbox-row{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.checkbox-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--primary)}
.checkbox-row label{font-size:13px;font-weight:500;cursor:pointer}
.progress-section{margin-top:20px}
.progress-bar{width:100%;height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:8px}
.progress-fill{height:100%;background:var(--primary);border-radius:3px;transition:width .3s;width:0%}
.progress-text{font-size:13px;color:var(--text2)}
.results-section{margin-top:20px}
.result-summary{padding:14px 18px;border-radius:var(--radius);margin-bottom:16px;font-size:14px;line-height:1.5}
.result-summary.all-ok{background:var(--success-bg);color:#166534;border:1px solid #bbf7d0}
.result-summary.has-issues{background:var(--warn-bg);color:#92400e;border:1px solid #fde68a}
.result-summary.all-fail{background:var(--error-bg);color:#991b1b;border:1px solid #fecaca}
.results-table{width:100%;border-collapse:collapse;font-size:13px}
.results-table th{text-align:left;padding:8px 12px;color:var(--text2);font-weight:600;border-bottom:2px solid var(--border);font-size:12px;text-transform:uppercase;letter-spacing:.5px}
.results-table td{padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:top}
.results-table td.mono{font-family:"SF Mono",SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace;font-size:12px;word-break:break-all}
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}
.badge-ok{background:var(--success-bg);color:var(--success)}
.badge-warn{background:var(--warn-bg);color:var(--warn)}
.badge-fail{background:var(--error-bg);color:var(--error)}
.status-list{list-style:none}
.status-item{display:flex;align-items:center;gap:10px;padding:10px 0;font-size:14px}
.status-item+.status-item{border-top:1px solid var(--border)}
.status-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.status-dot.ok{background:var(--success)}
.status-dot.miss{background:var(--error)}
.status-label{font-weight:600}
.status-hint{color:var(--text2);font-size:13px}
.toast-container{position:fixed;top:20px;right:20px;z-index:1000;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.toast{padding:13px 18px;border-radius:var(--radius);font-size:14px;box-shadow:var(--shadow-lg);animation:toast-in .3s ease;max-width:420px;pointer-events:auto;line-height:1.4}
.toast-ok{background:var(--success-bg);color:#166534;border:1px solid #bbf7d0}
.toast-err{background:var(--error-bg);color:#991b1b;border:1px solid #fecaca}
.toast-info{background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe}
@keyframes toast-in{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty-hint{text-align:center;color:var(--text3);font-size:14px;padding:32px 16px}
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-brand"><span>sof</span> uploader</div>
    <nav>
      <a class="nav-link active" data-tab="setup" onclick="switchTab('setup')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        Setup
      </a>
      <a class="nav-link" data-tab="upload" onclick="switchTab('upload')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        Upload Files
      </a>
      <a class="nav-link" data-tab="reupload" onclick="switchTab('reupload')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
        Re-upload by ID
      </a>
    </nav>
    <div class="sidebar-footer">Listening on port ${port}<br>Press Ctrl+C in terminal to stop</div>
  </aside>
  <main class="main">

    <!-- ===================== SETUP TAB ===================== -->
    <section id="tab-setup" class="tab-panel active">
      <div class="section-hdr">
        <h2>Credential Setup</h2>
        <p>Before uploading assets, connect your Roblox account. These credentials are stored locally on your computer and are never sent anywhere except to Roblox.</p>
      </div>
      <div class="card" id="status-card">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px">Current Status</h3>
        <ul class="status-list" id="status-list">
          <li class="status-item"><div class="status-dot miss"></div><span class="status-label">Checking...</span></li>
        </ul>
      </div>
      <div class="card">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:16px">Update Credentials</h3>
        <form id="cred-form" onsubmit="saveCredentials(event)">
          <div class="form-group">
            <label for="f-api-key">Roblox API Key</label>
            <input type="password" id="f-api-key" placeholder="Enter your Open Cloud API key" autocomplete="off">
            <div class="hint">Create one at <strong>create.roblox.com &rarr; Open Cloud &rarr; API Keys</strong>. The key needs the <em>Assets</em> permission.</div>
          </div>
          <div class="form-group">
            <label for="f-cookie">.ROBLOSECURITY Cookie</label>
            <input type="password" id="f-cookie" placeholder="Paste your .ROBLOSECURITY cookie value" autocomplete="off">
            <div class="hint">This is your Roblox login cookie. You can find it in your browser&rsquo;s developer tools under Application &rarr; Cookies. Do <strong>not</strong> include the &ldquo;.ROBLOSECURITY=&rdquo; prefix.</div>
          </div>
          <div class="form-group">
            <label for="f-creator-id">Creator ID</label>
            <input type="text" id="f-creator-id" placeholder="Your Roblox User ID or Group ID" autocomplete="off">
            <div class="hint">This is the numeric ID of your Roblox account or group. You can find it in your profile URL (e.g. roblox.com/users/<strong>12345</strong>/profile).</div>
          </div>
          <button type="submit" class="btn btn-primary" id="cred-save-btn">Save Credentials</button>
        </form>
      </div>
    </section>

    <!-- ===================== UPLOAD TAB ===================== -->
    <section id="tab-upload" class="tab-panel">
      <div class="section-hdr">
        <h2>Upload Files</h2>
        <p>Upload images or 3D models from your computer directly to your Roblox account.</p>
      </div>
      <div class="card">
        <div class="toggle-group" id="upload-type-toggle">
          <button type="button" class="toggle-btn active" data-type="image" onclick="setUploadType('image')">Images</button>
          <button type="button" class="toggle-btn" data-type="model" onclick="setUploadType('model')">3D Models</button>
        </div>
        <div class="drop-zone" id="drop-zone" onclick="document.getElementById('file-input').click()">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <div class="dz-title">Drag &amp; drop files here</div>
          <div class="dz-sub">or click to browse your computer</div>
          <div class="dz-formats" id="dz-formats">Supported: PNG, JPG, JPEG, TGA, BMP, WebP, SVG, TIFF, GIF, AVIF, HEIF</div>
        </div>
        <input type="file" id="file-input" multiple hidden>
        <div class="file-list" id="file-list"></div>
        <div class="advanced-toggle" onclick="toggleAdvanced('upload')">
          <span id="upload-adv-arrow">&#9654;</span> Advanced options
        </div>
        <div class="advanced-body collapsed" id="upload-adv">
          <div class="form-group">
            <label for="up-creator-id">Creator ID override</label>
            <input type="text" id="up-creator-id" placeholder="Leave blank to use saved credentials">
          </div>
          <div class="checkbox-row">
            <input type="checkbox" id="up-is-group">
            <label for="up-is-group">Upload to a group account (Creator ID is a Group ID)</label>
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="upload-btn" onclick="startFileUpload()" disabled>Upload Files</button>
        <div class="progress-section" id="upload-progress" style="display:none">
          <div class="progress-bar"><div class="progress-fill" id="upload-progress-fill"></div></div>
          <div class="progress-text" id="upload-progress-text"></div>
        </div>
        <div class="results-section" id="upload-results"></div>
      </div>
    </section>

    <!-- ===================== RE-UPLOAD TAB ===================== -->
    <section id="tab-reupload" class="tab-panel">
      <div class="section-hdr">
        <h2>Re-upload by Asset ID</h2>
        <p>Download existing Roblox assets and re-upload them to your account. This is useful for transferring assets between accounts or refreshing moderated content.</p>
      </div>
      <div class="card">
        <div class="toggle-group" id="reupload-type-toggle">
          <button type="button" class="toggle-btn active" data-type="images" onclick="setReuploadType('images')">Images</button>
          <button type="button" class="toggle-btn" data-type="animations" onclick="setReuploadType('animations')">Animations</button>
          <button type="button" class="toggle-btn" data-type="meshes" onclick="setReuploadType('meshes')">Meshes</button>
        </div>
        <div class="form-group">
          <label for="re-ids">Asset IDs</label>
          <textarea id="re-ids" placeholder="Enter Roblox asset IDs, separated by commas or new lines.&#10;&#10;Example:&#10;123456789&#10;987654321&#10;rbxassetid://555555555"></textarea>
          <div class="hint">You can paste full rbxassetid:// URLs or just the numeric IDs. One per line or separated by commas.</div>
        </div>
        <div class="advanced-toggle" onclick="toggleAdvanced('reupload')">
          <span id="reupload-adv-arrow">&#9654;</span> Advanced options
        </div>
        <div class="advanced-body collapsed" id="reupload-adv">
          <div class="form-group">
            <label for="re-creator-id">Creator ID override</label>
            <input type="text" id="re-creator-id" placeholder="Leave blank to use saved credentials">
          </div>
          <div class="form-group">
            <label for="re-api-key">API key override (optional)</label>
            <input type="password" id="re-api-key" placeholder="Leave blank to use saved API key" autocomplete="off">
          </div>
          <div class="form-group">
            <label for="re-cookie">.ROBLOSECURITY override (optional)</label>
            <input type="password" id="re-cookie" placeholder="Leave blank to use saved cookie" autocomplete="off">
          </div>
          <div class="checkbox-row">
            <input type="checkbox" id="re-is-group">
            <label for="re-is-group">Upload to a group account (Creator ID is a Group ID)</label>
          </div>
          <div class="checkbox-row" id="re-remote-row">
            <input type="checkbox" id="re-use-remote-exec">
            <label for="re-use-remote-exec">For mesh re-uploads, use Studio Remote Exec (AssetService)</label>
          </div>
          <div id="re-remote-options" style="display:none">
            <div class="form-group">
              <label for="re-remote-port">Remote Exec port</label>
              <input type="text" id="re-remote-port" placeholder="${DEFAULT_REMOTE_EXEC_PORT}" autocomplete="off">
            </div>
            <div class="form-group">
              <label for="re-remote-timeout">Remote timeout (ms)</label>
              <input type="text" id="re-remote-timeout" placeholder="${DEFAULT_REMOTE_EXEC_TIMEOUT_MS}" autocomplete="off">
              <div class="hint">Requires Roblox Studio + Remote Exec plugin connected to the same port.</div>
            </div>
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="reupload-btn" onclick="startReupload()">Re-upload Assets</button>
        <div class="progress-section" id="reupload-progress" style="display:none">
          <div class="progress-bar"><div class="progress-fill" id="reupload-progress-fill"></div></div>
          <div class="progress-text" id="reupload-progress-text"></div>
        </div>
        <div class="results-section" id="reupload-results"></div>
      </div>
    </section>
  </main>
</div>
<div class="toast-container" id="toast-container"></div>
<script>
(function(){
"use strict";

var selectedFiles = [];
var uploadType = "image";
var reuploadType = "images";
var uploading = false;

var IMAGE_ACCEPT = ".png,.jpg,.jpeg,.tga,.bmp,.webp,.svg,.tiff,.tif,.gif,.avif,.heif,.heic";
var MODEL_ACCEPT = ".obj,.fbx,.gltf,.glb,.stl,.mesh,.rbxmesh";

window.switchTab = function(tab) {
  document.querySelectorAll(".tab-panel").forEach(function(el){ el.classList.remove("active"); });
  document.querySelectorAll(".nav-link").forEach(function(el){ el.classList.remove("active"); });
  var panel = document.getElementById("tab-" + tab);
  if (panel) panel.classList.add("active");
  var link = document.querySelector('.nav-link[data-tab="' + tab + '"]');
  if (link) link.classList.add("active");
  if (tab === "setup") checkCredentials();
};

function checkCredentials() {
  fetch("/api/credentials/status").then(function(r){ return r.json(); }).then(function(data){
    var list = document.getElementById("status-list");
    list.innerHTML = statusItem(data.hasApiKey, "API Key", data.hasApiKey ? "Configured and ready" : "Not set \\u2014 required for image/model uploads and mesh re-uploads")
      + statusItem(data.hasCookie, "Cookie", data.hasCookie ? "Configured and ready" : "Not set \\u2014 required for re-uploading and animation/mesh uploads")
      + statusItem(data.hasCreatorId, "Creator ID", data.hasCreatorId ? "Configured and ready" : "Not set \\u2014 required so Roblox knows which account to upload to");
  }).catch(function(){
    document.getElementById("status-list").innerHTML = '<li class="status-item"><div class="status-dot miss"></div><span>Could not check credentials</span></li>';
  });
}

function statusItem(ok, label, hint) {
  return '<li class="status-item"><div class="status-dot ' + (ok ? "ok" : "miss") + '"></div><div><div class="status-label">' + label + '</div><div class="status-hint">' + hint + '</div></div></li>';
}

window.saveCredentials = function(e) {
  e.preventDefault();
  var btn = document.getElementById("cred-save-btn");
  var apiKey = document.getElementById("f-api-key").value.trim();
  var cookie = document.getElementById("f-cookie").value.trim();
  var creatorId = document.getElementById("f-creator-id").value.trim();
  if (!apiKey || !cookie || !creatorId) { showToast("Please fill in all three fields before saving.", "err"); return; }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving...';
  fetch("/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: apiKey, roblosecurity: cookie, creatorId: creatorId })
  }).then(function(r){ return r.json(); }).then(function(data){
    btn.disabled = false;
    btn.textContent = "Save Credentials";
    if (data.success) {
      showToast("Credentials saved! You\\u2019re all set to start uploading.", "ok");
      document.getElementById("f-api-key").value = "";
      document.getElementById("f-cookie").value = "";
      document.getElementById("f-creator-id").value = "";
      checkCredentials();
    } else {
      showToast(data.message || "Could not save credentials. Please check your values and try again.", "err");
    }
  }).catch(function(){
    btn.disabled = false;
    btn.textContent = "Save Credentials";
    showToast("Something went wrong while saving. Please try again.", "err");
  });
};

window.setUploadType = function(type) {
  uploadType = type;
  document.querySelectorAll("#upload-type-toggle .toggle-btn").forEach(function(el){
    el.classList.toggle("active", el.dataset.type === type);
  });
  var input = document.getElementById("file-input");
  input.accept = type === "image" ? IMAGE_ACCEPT : MODEL_ACCEPT;
  document.getElementById("dz-formats").textContent = type === "image"
    ? "Supported: PNG, JPG, JPEG, TGA, BMP, WebP, SVG, TIFF, GIF, AVIF, HEIF"
    : "Supported: OBJ, FBX, GLTF, GLB, STL, MESH, RBXMESH";
  selectedFiles = [];
  renderFileList();
};

window.setReuploadType = function(type) {
  reuploadType = type;
  document.querySelectorAll("#reupload-type-toggle .toggle-btn").forEach(function(el){
    el.classList.toggle("active", el.dataset.type === type);
  });
  syncRemoteExecControls();
};

function syncRemoteExecControls() {
  var remoteRow = document.getElementById("re-remote-row");
  var remoteOptions = document.getElementById("re-remote-options");
  var remoteCheckbox = document.getElementById("re-use-remote-exec");
  if (!remoteRow || !remoteOptions || !remoteCheckbox) return;

  var isMeshMode = reuploadType === "meshes";
  remoteRow.style.display = isMeshMode ? "flex" : "none";
  if (!isMeshMode) {
    remoteCheckbox.checked = false;
  }
  remoteOptions.style.display = isMeshMode && remoteCheckbox.checked ? "block" : "none";
}

var dropZone = null;
function setupDropZone() {
  dropZone = document.getElementById("drop-zone");
  var input = document.getElementById("file-input");
  input.accept = IMAGE_ACCEPT;
  dropZone.addEventListener("dragover", function(e){ e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", function(){ dropZone.classList.remove("drag-over"); });
  dropZone.addEventListener("drop", function(e){
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    addFiles(e.dataTransfer.files);
  });
  input.addEventListener("change", function(){ addFiles(input.files); input.value = ""; });
}

function addFiles(fileList) {
  var validExts = uploadType === "image"
    ? new Set(IMAGE_ACCEPT.split(","))
    : new Set(MODEL_ACCEPT.split(","));
  var skipped = 0;
  for (var i = 0; i < fileList.length; i++) {
    var file = fileList[i];
    var ext = "." + file.name.split(".").pop().toLowerCase();
    if (validExts.has(ext)) {
      selectedFiles.push(file);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) {
    showToast(skipped + " file(s) were skipped because their format isn\\u2019t supported for " + (uploadType === "image" ? "image" : "model") + " uploads.", "info");
  }
  renderFileList();
}

function renderFileList() {
  var container = document.getElementById("file-list");
  var btn = document.getElementById("upload-btn");
  if (selectedFiles.length === 0) {
    container.innerHTML = "";
    btn.disabled = true;
    return;
  }
  btn.disabled = uploading;
  container.innerHTML = selectedFiles.map(function(f, i){
    return '<div class="file-item"><span class="fi-name">' + esc(f.name) + '</span><span class="fi-size">' + formatSize(f.size) + '</span><button class="fi-remove" onclick="removeFile(' + i + ')" title="Remove">&times;</button></div>';
  }).join("");
}

window.removeFile = function(idx) {
  selectedFiles.splice(idx, 1);
  renderFileList();
};

window.toggleAdvanced = function(section) {
  var body = document.getElementById(section + "-adv");
  var arrow = document.getElementById(section + "-adv-arrow");
  var collapsed = body.classList.toggle("collapsed");
  arrow.innerHTML = collapsed ? "&#9654;" : "&#9660;";
};

window.startFileUpload = function() {
  if (selectedFiles.length === 0 || uploading) return;
  uploading = true;
  document.getElementById("upload-btn").disabled = true;
  document.getElementById("upload-btn").innerHTML = '<span class="spinner"></span> Uploading...';
  document.getElementById("upload-progress").style.display = "block";
  document.getElementById("upload-results").innerHTML = "";

  var fd = new FormData();
  for (var i = 0; i < selectedFiles.length; i++) fd.append("files", selectedFiles[i]);
  var creatorId = document.getElementById("up-creator-id").value.trim();
  var isGroup = document.getElementById("up-is-group").checked;
  if (creatorId) fd.append("creatorId", creatorId);
  if (isGroup) fd.append("isGroup", "true");

  var endpoint = uploadType === "image" ? "/api/upload/image-files" : "/api/upload/model-files";
  streamRequest(endpoint, fd, null, "upload");
};

window.startReupload = function() {
  var raw = document.getElementById("re-ids").value.trim();
  if (!raw || uploading) return;
  var ids = raw.split(/[,\\n\\r]+/).map(function(s){ return s.trim(); }).filter(Boolean);
  if (ids.length === 0) { showToast("Please enter at least one asset ID.", "err"); return; }
  uploading = true;
  document.getElementById("reupload-btn").disabled = true;
  document.getElementById("reupload-btn").innerHTML = '<span class="spinner"></span> Re-uploading...';
  document.getElementById("reupload-progress").style.display = "block";
  document.getElementById("reupload-results").innerHTML = "";

  var creatorId = document.getElementById("re-creator-id").value.trim();
  var apiKey = document.getElementById("re-api-key").value.trim();
  var cookie = document.getElementById("re-cookie").value.trim();
  var isGroup = document.getElementById("re-is-group").checked;
  var useRemoteExec = reuploadType === "meshes" && document.getElementById("re-use-remote-exec").checked;
  var remotePort = document.getElementById("re-remote-port").value.trim();
  var remoteTimeout = document.getElementById("re-remote-timeout").value.trim();

  var payload = {
    assetIds: ids,
    creatorId: creatorId || undefined,
    apiKey: apiKey || undefined,
    cookie: cookie || undefined,
    isGroup: isGroup,
    useRemoteExec: useRemoteExec
  };

  if (useRemoteExec) {
    payload.remotePort = remotePort || undefined;
    payload.remoteTimeout = remoteTimeout || undefined;
  }

  var body = JSON.stringify(payload);
  streamRequest("/api/upload/" + reuploadType, body, { "Content-Type": "application/json" }, "reupload");
};

function streamRequest(url, body, headers, prefix) {
  var progressFill = document.getElementById(prefix + "-progress-fill");
  var progressText = document.getElementById(prefix + "-progress-text");
  var resultsEl = document.getElementById(prefix + "-results");
  progressFill.style.width = "0%";
  progressText.textContent = "Starting...";

  var opts = { method: "POST", body: body };
  if (headers) opts.headers = headers;

  fetch(url, opts).then(function(response) {
    if (!response.body) {
      return response.text().then(function(t){
        try { var d = JSON.parse(t); finishUpload(prefix, d); } catch(e) { finishUpload(prefix, { type:"error", message: t }); }
      });
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    function pump() {
      return reader.read().then(function(result) {
        if (result.done) {
          if (buf.trim()) { try { handleEvent(JSON.parse(buf), progressFill, progressText, resultsEl, prefix); } catch(e){} }
          return;
        }
        buf += decoder.decode(result.value, { stream: true });
        var lines = buf.split("\\n");
        buf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try { handleEvent(JSON.parse(lines[i]), progressFill, progressText, resultsEl, prefix); } catch(e){}
        }
        return pump();
      });
    }
    return pump();
  }).catch(function(err){
    finishUpload(prefix, { type: "error", message: "Connection lost. Please check your internet connection and try again." });
  });
}

function handleEvent(ev, fill, text, resultsEl, prefix) {
  if (ev.type === "progress") {
    var pct = ev.total > 0 ? Math.round((ev.done / ev.total) * 100) : 0;
    fill.style.width = pct + "%";
    text.textContent = ev.message || (ev.done + " / " + ev.total);
  } else if (ev.type === "complete") {
    fill.style.width = "100%";
    text.textContent = "Done!";
    renderResults(ev, resultsEl);
    finishUpload(prefix);
  } else if (ev.type === "error") {
    finishUpload(prefix, ev);
  }
}

function finishUpload(prefix, errorEvent) {
  uploading = false;
  var btnId = prefix === "upload" ? "upload-btn" : "reupload-btn";
  var btn = document.getElementById(btnId);
  btn.disabled = false;
  btn.textContent = prefix === "upload" ? "Upload Files" : "Re-upload Assets";
  if (errorEvent && errorEvent.message) {
    document.getElementById(prefix + "-results").innerHTML = '<div class="result-summary all-fail">' + esc(errorEvent.message) + '</div>';
    document.getElementById(prefix + "-progress").style.display = "none";
    showToast(errorEvent.message, "err");
  }
  if (prefix === "upload") { selectedFiles = []; renderFileList(); }
}

function renderResults(report, container) {
  var ok = (report.results || []).length;
  var mod = (report.moderated || []).length;
  var fail = (report.failures || []).length;
  var total = ok + mod + fail;
  var html = "";

  if (fail === 0 && mod === 0 && ok > 0) {
    html += '<div class="result-summary all-ok">All ' + ok + " asset(s) were uploaded successfully!</div>";
  } else if (ok === 0 && fail > 0 && mod === 0) {
    html += '<div class="result-summary all-fail">None of the ' + total + " asset(s) could be uploaded. Check the details below for more information.</div>";
  } else {
    var parts = [];
    if (ok > 0) parts.push(ok + " succeeded");
    if (mod > 0) parts.push(mod + " flagged for moderation review");
    if (fail > 0) parts.push(fail + " failed");
    html += '<div class="result-summary has-issues">Upload finished: ' + parts.join(", ") + ".</div>";
  }

  if (mod > 0) {
    html += '<p style="font-size:13px;color:var(--text2);margin-bottom:8px">Assets flagged for moderation may take time before they become available in Roblox.</p>';
  }

  if (total > 0) {
    html += '<table class="results-table"><thead><tr><th>Source</th><th>New Asset ID</th><th>Status</th></tr></thead><tbody>';
    (report.results || []).forEach(function(r){
      html += '<tr><td class="mono">' + esc(r.oldId) + '</td><td class="mono">' + esc(r.newId) + '</td><td><span class="badge badge-ok">Success</span></td></tr>';
    });
    (report.moderated || []).forEach(function(r){
      html += '<tr><td class="mono">' + esc(r.oldId) + '</td><td class="mono">' + esc(r.newId) + '</td><td><span class="badge badge-warn">' + esc(r.state || "Review") + '</span></td></tr>';
    });
    (report.failures || []).forEach(function(r){
      html += '<tr><td class="mono">' + esc(r.assetId) + '</td><td style="color:var(--text2)">' + esc(r.error || "Unknown error") + '</td><td><span class="badge badge-fail">Failed</span></td></tr>';
    });
    html += "</tbody></table>";
  }

  container.innerHTML = html;
}

function showToast(msg, type) {
  var el = document.createElement("div");
  el.className = "toast toast-" + (type || "info");
  el.textContent = msg;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(function(){ el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(function(){ el.remove(); }, 300); }, 5000);
}
window.showToast = showToast;

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function esc(s) {
  var d = document.createElement("div");
  d.appendChild(document.createTextNode(String(s)));
  return d.innerHTML;
}

document.addEventListener("DOMContentLoaded", function(){
  setupDropZone();
  checkCredentials();
  var remoteToggle = document.getElementById("re-use-remote-exec");
  if (remoteToggle) {
    remoteToggle.addEventListener("change", syncRemoteExecControls);
  }
  syncRemoteExecControls();
});

})();
</script>
</body>
</html>`;
}

// ============================================================
// Server
// ============================================================

function startServer({ port = 4000 } = {}) {
  loadUploaderEnv();

  const server = http.createServer((req, res) => {
    handleRequest(req, res, port).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: err.message }));
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[uploader serve] Port ${port} is already in use.\n` +
          `  Try a different port: sof run uploader serve --port ${port + 1}`
      );
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log("");
    console.log(`  Sof Uploader is running at:`);
    console.log("");
    console.log(`    http://127.0.0.1:${port}`);
    console.log("");
    console.log("  Press Ctrl+C to stop the server.");
    console.log("");
  });

  return server;
}

module.exports = { startServer };
