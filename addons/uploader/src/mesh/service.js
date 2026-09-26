"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    loadUploaderEnv,
    sanitizeApiKey,
    sanitizeRoblosecurity
} = require("../uploader/env");
const {
    resolveCookie,
    resolveCreatorId,
    downloadAssetLegacyBufferWithRetries,
    uploadMeshes,
    openCloudUpload
} = require("../uploader/asset-upload");
const { parseMeshBuffer } = require("./parser");
const { encodeObjMesh } = require("./encoder");

const CACHE_DIR = path.join(os.homedir(), ".sof", "mesh-cache");

function ensureCacheDir() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function parseAssetId(rawValue) {
    const value = String(rawValue || "").trim();
    const match = value.match(/\d+/);
    if (!match) {
        return null;
    }
    return match[0];
}

function parseAssetIds(values) {
    const out = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
        const id = parseAssetId(candidate);
        if (!id || seen.has(id)) {
            return;
        }
        seen.add(id);
        out.push(id);
    };

    if (Array.isArray(values)) {
        for (const value of values) pushCandidate(value);
    } else if (typeof values === "string") {
        const parts = values.split(/[\s,]+/);
        for (const value of parts) pushCandidate(value);
    } else if (values != null) {
        pushCandidate(values);
    }

    return out;
}

function readJsonCache(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return null;
    }
}

function writeJsonCache(filePath, payload) {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function detectImageMime(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return "application/octet-stream";
    }
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
    ) {
        return "image/png";
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        return "image/jpeg";
    }
    if (
        buffer.length >= 6 &&
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38
    ) {
        return "image/gif";
    }
    if (
        buffer.length >= 12 &&
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
    ) {
        return "image/webp";
    }
    return "application/octet-stream";
}

function jsonResponse(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

async function readRawBody(req, maxSize = 10 * 1024 * 1024) {
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
    const raw = await readRawBody(req);
    if (!raw.length) {
        return {};
    }
    try {
        return JSON.parse(raw.toString("utf8"));
    } catch {
        throw new Error("Invalid JSON body.");
    }
}

function resolveRequestCookie(cookieOverride) {
    const cookie = resolveCookie(cookieOverride || null);
    return cookie || null;
}

function normalizeUploadName(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) {
        throw new Error("`name` is required.");
    }
    return trimmed;
}

function toFileSafeName(name) {
    const output = name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/\s+/g, "_")
        .slice(0, 120);
    return output || "voxelized_mesh";
}

function resolveRequestApiKey(apiKeyOverride) {
    const direct = sanitizeApiKey(apiKeyOverride);
    if (direct) {
        return direct;
    }
    const envKey = sanitizeApiKey(process.env.ROBLOX_API_KEY);
    if (envKey) {
        return envKey;
    }
    return "";
}

async function extractMeshAsset(assetId, { cookie = null, force = false } = {}) {
    ensureCacheDir();
    const cachePath = path.join(CACHE_DIR, `${assetId}.mesh.json`);
    if (!force) {
        const cached = readJsonCache(cachePath);
        if (cached) {
            return cached;
        }
    }

    const data = await downloadAssetLegacyBufferWithRetries(assetId, cookie);
    const parsed = parseMeshBuffer(data);
    const payload = {
        assetId: String(assetId),
        fetchedAt: new Date().toISOString(),
        mesh: parsed
    };
    writeJsonCache(cachePath, payload);
    return payload;
}

async function extractImageAsset(assetId, { cookie = null, force = false } = {}) {
    ensureCacheDir();
    const metaPath = path.join(CACHE_DIR, `${assetId}.image.json`);
    const dataPath = path.join(CACHE_DIR, `${assetId}.image.bin`);

    if (!force && fs.existsSync(metaPath) && fs.existsSync(dataPath)) {
        const cachedMeta = readJsonCache(metaPath);
        if (cachedMeta) {
            return {
                meta: cachedMeta,
                buffer: fs.readFileSync(dataPath)
            };
        }
    }

    const buffer = await downloadAssetLegacyBufferWithRetries(assetId, cookie);
    const contentType = detectImageMime(buffer);
    const meta = {
        assetId: String(assetId),
        contentType,
        size: buffer.length,
        fetchedAt: new Date().toISOString()
    };
    fs.writeFileSync(dataPath, buffer);
    writeJsonCache(metaPath, meta);

    return { meta, buffer };
}

async function handleStatus(_req, res) {
    loadUploaderEnv();
    const hasApiKey = !!sanitizeApiKey(process.env.ROBLOX_API_KEY);
    const hasCookie = !!sanitizeRoblosecurity(process.env.ROBLOSECURITY);
    const hasCreatorId = /^\d+$/.test(String(process.env.ROBLOX_CREATOR_ID || "").trim());

    jsonResponse(res, 200, {
        ok: true,
        cacheDir: CACHE_DIR,
        credentials: {
            hasApiKey,
            hasCookie,
            hasCreatorId
        }
    });
}

async function handleMeshGet(req, res, assetId, urlObj) {
    try {
        const cookie = resolveRequestCookie(urlObj.searchParams.get("cookie"));
        const force = urlObj.searchParams.get("force") === "1";
        const payload = await extractMeshAsset(assetId, { cookie, force });
        jsonResponse(res, 200, payload);
    } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message });
    }
}

async function handleImageGet(_req, res, assetId, urlObj) {
    try {
        const cookie = resolveRequestCookie(urlObj.searchParams.get("cookie"));
        const force = urlObj.searchParams.get("force") === "1";
        const raw = urlObj.searchParams.get("raw") === "1";

        const { meta, buffer } = await extractImageAsset(assetId, { cookie, force });
        if (raw) {
            res.writeHead(200, {
                "Content-Type": meta.contentType,
                "Content-Length": String(buffer.length)
            });
            res.end(buffer);
            return;
        }

        jsonResponse(res, 200, {
            ...meta,
            dataBase64: buffer.toString("base64")
        });
    } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message });
    }
}

async function handleExtractPost(req, res) {
    try {
        const body = await readJsonBody(req);
        const ids = parseAssetIds(body.assetIds);
        if (ids.length === 0) {
            throw new Error("No valid asset IDs provided.");
        }

        const cookie = resolveRequestCookie(body.cookie || null);
        const force = !!body.force;
        const results = [];
        const failures = [];

        for (const assetId of ids) {
            try {
                const payload = await extractMeshAsset(assetId, { cookie, force });
                results.push(payload);
            } catch (err) {
                failures.push({ assetId, error: err.message });
            }
        }

        jsonResponse(res, 200, { ok: true, results, failures });
    } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message });
    }
}

async function handleReuploadPost(req, res) {
    try {
        const body = await readJsonBody(req);
        const ids = parseAssetIds(body.assetIds);
        if (ids.length === 0) {
            throw new Error("No valid asset IDs provided.");
        }

        const creatorId = await resolveCreatorId({
            creatorID: body.creatorId || null,
            isGroup: !!body.isGroup,
            cookie: body.cookie || null
        });

        const report = await uploadMeshes({
            assetIDs: ids,
            creatorID: creatorId,
            isGroup: !!body.isGroup,
            apiKey: body.apiKey || undefined,
            cookie: body.cookie || undefined
        });

        jsonResponse(res, 200, { ok: true, ...report });
    } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message });
    }
}

async function handleUploadVoxelizedPost(req, res) {
    try {
        const body = await readJsonBody(req);
        const displayName = normalizeUploadName(body.name);
        const description = typeof body.description === "string" ? body.description.trim() : "";
        const isGroup = !!body.isGroup;
        const apiKey = resolveRequestApiKey(body.apiKey || null);
        if (!apiKey) {
            throw new Error("API key required. Configure uploader env or pass `apiKey`.");
        }

        const creatorId = await resolveCreatorId({
            creatorID: body.creatorId || null,
            isGroup,
            cookie: body.cookie || null
        });

        const objBuffer = encodeObjMesh({
            vertices: body.vertices,
            faces: body.faces,
            normals: body.normals,
            uvs: body.uvs
        });

        const uploadResult = await openCloudUpload({
            fileData: objBuffer,
            fileName: `${toFileSafeName(displayName)}.obj`,
            assetType: "Model",
            mimeType: "model/obj",
            displayName,
            description,
            creatorID: creatorId,
            isGroup,
            apiKey
        });

        jsonResponse(res, 200, {
            ok: true,
            assetId: String(uploadResult.newAssetId),
            rbxassetid: `rbxassetid://${uploadResult.newAssetId}`
        });
    } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message });
    }
}

async function handleRequest(req, res, { port }) {
    const urlObj = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = urlObj.pathname;

    if (req.method === "GET" && pathname === "/api/status") {
        return handleStatus(req, res);
    }
    if (req.method === "GET" && pathname.startsWith("/api/mesh/")) {
        const assetId = parseAssetId(pathname.slice("/api/mesh/".length));
        if (!assetId) {
            return jsonResponse(res, 400, { ok: false, error: "Invalid mesh asset ID." });
        }
        return handleMeshGet(req, res, assetId, urlObj);
    }
    if (req.method === "GET" && pathname.startsWith("/api/image/")) {
        const assetId = parseAssetId(pathname.slice("/api/image/".length));
        if (!assetId) {
            return jsonResponse(res, 400, { ok: false, error: "Invalid image asset ID." });
        }
        return handleImageGet(req, res, assetId, urlObj);
    }
    if (req.method === "POST" && pathname === "/api/extract") {
        return handleExtractPost(req, res);
    }
    if (req.method === "POST" && pathname === "/api/reupload") {
        return handleReuploadPost(req, res);
    }
    if (req.method === "POST" && pathname === "/api/upload-voxelized") {
        return handleUploadVoxelizedPost(req, res);
    }

    jsonResponse(res, 404, { ok: false, error: "Not found" });
}

function startMeshService({ port = 5000, host = "0.0.0.0" } = {}) {
    ensureCacheDir();
    loadUploaderEnv();

    const server = http.createServer((req, res) => {
        handleRequest(req, res, { port }).catch((err) => {
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            }
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });
    });

    server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            console.error(
                `[mesh-service] Port ${port} is already in use.\n` +
                `  Try a different port: sof run mesh-service --port ${port + 1}`
            );
            process.exit(1);
        }
        throw err;
    });

    server.listen(port, host, () => {
        const address = server.address();
        const resolvedPort = typeof address === "object" && address ? address.port : port;
        console.log("");
        console.log("  Sof Mesh Service is running at:");
        console.log("");
        console.log(`    http://${host}:${resolvedPort}`);
        console.log("");
        console.log("  Endpoints:");
        console.log("    GET  /api/status");
        console.log("    GET  /api/mesh/:assetId");
        console.log("    GET  /api/image/:assetId");
        console.log("    POST /api/extract");
        console.log("    POST /api/reupload");
        console.log("    POST /api/upload-voxelized");
        console.log("");
        console.log("  Press Ctrl+C to stop.");
        console.log("");
    });

    return server;
}

module.exports = {
    startMeshService,
    parseAssetId,
    parseAssetIds
};
