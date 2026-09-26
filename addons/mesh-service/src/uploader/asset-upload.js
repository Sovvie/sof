"use strict";

const { loadUploaderEnv, sanitizeApiKey, sanitizeRoblosecurity } = require("./env");
loadUploaderEnv();

const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const fetch = require("node-fetch");
const { execFileSync } = require("child_process");
const sharp = require("sharp");

const exeDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const outputDir = path.join(exeDir, "output");

const DIRECT_IMAGE_EXTS  = new Set([".png", ".jpg", ".jpeg"]);
const CONVERT_IMAGE_EXTS = new Set([".tga", ".bmp", ".webp", ".svg", ".tiff", ".tif", ".gif", ".avif", ".heif", ".heic"]);
const MODEL_EXTS         = new Set([".obj", ".fbx", ".gltf", ".glb", ".stl"]);
const RAW_MESH_EXTS      = new Set([".mesh", ".rbxmesh"]);
const MESH_EXTS          = new Set([...MODEL_EXTS, ...RAW_MESH_EXTS]);

const MESH_MIME = {
    ".obj":  "model/obj",
    ".fbx":  "application/octet-stream",
    ".gltf": "model/gltf+json",
    ".glb":  "model/gltf-binary",
    ".stl":  "model/stl",
    ".mesh": "model/x-file-mesh-data",
    ".rbxmesh": "model/x-file-mesh-data",
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveApiKey(provided) {
    const providedApiKey = sanitizeApiKey(provided);
    if (providedApiKey) return providedApiKey;

    const envApiKey = sanitizeApiKey(process.env.ROBLOX_API_KEY);
    if (envApiKey) return envApiKey;

    return null;
}

function formatRoblosecurityCookie(value) {
    const token = sanitizeRoblosecurity(value);
    if (!token) {
        return null;
    }
    return `.ROBLOSECURITY=${token}`;
}

function resolveCookie(provided) {
    const providedCookie = formatRoblosecurityCookie(provided);
    if (providedCookie) return providedCookie;

    const envCookie = formatRoblosecurityCookie(process.env.ROBLOSECURITY);
    if (envCookie) return envCookie;

    return getCookieFromRustCLI();
}

function getCookieFromRustCLI() {
    const cookieExePath = path.join(exeDir, "rbx_cookie.exe");
    try {
        const token = execFileSync(cookieExePath, ["--format", "value"], { encoding: "utf8" }).trim();
        console.log("[rbx_cookie.exe] Found .ROBLOSECURITY token.");
        return `.ROBLOSECURITY=${token}`;
    } catch (err) {
        console.error("[rbx_cookie.exe] Failed:", err.message);
        return null;
    }
}

function prepareOutputDir(dir) {
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            console.log(`[prepareOutputDir] Created: ${dir}`);
            return;
        } catch (err) {
            console.warn(`[prepareOutputDir] Attempt ${attempt} failed: ${err.message}`);
            if (attempt < 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
            else console.error("[prepareOutputDir] Gave up.");
        }
    }
}

async function normalizeImageFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (DIRECT_IMAGE_EXTS.has(ext)) return filePath;
    if (!CONVERT_IMAGE_EXTS.has(ext)) {
        throw new Error(`Unsupported image format: ${ext}`);
    }
    const outPath = filePath.replace(/\.[^.]+$/, ".png");
    await sharp(filePath).png().toFile(outPath);
    console.log(`[normalizeImageFile] Converted ${ext} -> PNG: ${outPath}`);
    return outPath;
}

async function downloadAssetLegacyBuffer(assetId, cookie) {
    const url = `https://assetdelivery.roblox.com/v1/asset?id=${assetId}`;
    const headers = {
        "User-Agent": "RobloxStudio/WinInet"
    };
    const cookieHeader = formatRoblosecurityCookie(cookie);
    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }

    const response = await fetch(url, {
        method: "GET",
        headers
    });

    const body = await response.buffer();
    if (!response.ok) {
        const errorDetail = body.toString("utf8").trim();
        throw new Error(
            `Download failed (status ${response.status}) for assetId ${assetId}` +
                (errorDetail ? `: ${errorDetail.slice(0, 200)}` : "")
        );
    }

    return body;
}

async function downloadAssetLegacy(assetId, outputPath, cookie) {
    const data = await downloadAssetLegacyBuffer(assetId, cookie);
    fs.writeFileSync(outputPath, data);
}

async function downloadAssetLegacyWithRetries(assetId, outputPath, cookie, maxRetries = 10) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            await downloadAssetLegacy(assetId, outputPath, cookie);
            return;
        } catch (err) {
            attempt++;
            if (err.message.includes("429") || err.message.toLowerCase().includes("rate limit")) {
                console.warn(`[download] 429 for ${assetId}, attempt ${attempt}`);
                if (attempt < maxRetries) await sleep(1000);
                else throw err;
            } else {
                throw err;
            }
        } finally {
            await sleep(200);
        }
    }
}

async function downloadAssetLegacyBufferWithRetries(assetId, cookie, maxRetries = 10) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await downloadAssetLegacyBuffer(assetId, cookie);
        } catch (err) {
            attempt++;
            if (err.message.includes("429") || err.message.toLowerCase().includes("rate limit")) {
                console.warn(`[download] 429 for ${assetId}, attempt ${attempt}`);
                if (attempt < maxRetries) await sleep(1000);
                else throw err;
            } else {
                throw err;
            }
        } finally {
            await sleep(200);
        }
    }

    throw new Error(`Exceeded max retries downloading asset ${assetId}.`);
}

async function pollOperationUntilDone(operationId, apiKey) {
    const baseUrl = "https://apis.roblox.com/assets/v1/operations/";
    while (true) {
        const resp = await fetch(baseUrl + operationId, {
            method: "GET",
            headers: { "x-api-key": apiKey }
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(`Operation poll failed (status ${resp.status}): ${body}`);
        }
        const data = await resp.json();
        if (data.done === true) {
            const finalAssetId = data.assetId || data.response?.assetId;
            if (!finalAssetId) throw new Error(`Operation done but no assetId: ${JSON.stringify(data)}`);
            return finalAssetId;
        }
        await sleep(2000);
    }
}

async function openCloudUpload({
    filePath,
    fileData,
    fileName,
    assetType,
    mimeType,
    displayName,
    description,
    creatorID,
    isGroup,
    apiKey,
    oldAssetId
}) {
    const hasFilePath = typeof filePath === "string" && filePath.trim() !== "";
    const hasRawData = Buffer.isBuffer(fileData);
    if (!hasFilePath && !hasRawData) {
        throw new Error("openCloudUpload requires either filePath or fileData.");
    }

    const resolvedFileName = String(fileName || (hasFilePath ? path.basename(filePath) : "asset.bin")).trim();
    const creationContext = isGroup
        ? { creator: { groupId: parseInt(creatorID, 10) } }
        : { creator: { userId: parseInt(creatorID, 10) } };

    const form = new FormData();
    form.append("request", JSON.stringify({
        assetType,
        displayName: displayName || resolvedFileName,
        description: description || (oldAssetId ? `Reuploaded from rbxassetid://${oldAssetId}` : ""),
        creationContext
    }));
    form.append("fileContent", hasFilePath ? fs.createReadStream(filePath) : fileData, {
        contentType: mimeType,
        filename: resolvedFileName
    });

    const response = await fetch("https://apis.roblox.com/assets/v1/assets", {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: form
    });

    if (response.status === 201) {
        const data = await response.json();
        if (!data.assetId) throw new Error(`Response missing assetId: ${JSON.stringify(data)}`);
        return { newAssetId: data.assetId, rawModeration: data.moderationResult || data.response?.moderationResult };
    }
    if (response.status === 200) {
        const opData = await response.json();
        if (!opData.operationId) throw new Error(`Got 200 but no operationId: ${JSON.stringify(opData)}`);
        const finalAssetId = await pollOperationUntilDone(opData.operationId, apiKey);
        return { newAssetId: finalAssetId, rawModeration: null };
    }

    const errorText = await response.text().catch(() => "");
    throw new Error(`Open Cloud upload failed (status ${response.status}): ${errorText}`);
}

async function getAssetModeration(assetId, apiKey) {
    const url = `https://apis.roblox.com/assets/v1/assets/${assetId}?readMask=moderationResult`;
    const resp = await fetch(url, { method: "GET", headers: { "x-api-key": apiKey } });
    if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`GET moderation failed (status ${resp.status}): ${body}`);
    }
    const data = await resp.json();
    return data.moderationResult || null;
}

async function resolveAuthenticatedUserId(cookie) {
    const resp = await fetch("https://users.roblox.com/v1/users/authenticated", {
        method: "GET",
        headers: { "Cookie": cookie }
    });

    if (!resp.ok) throw new Error(`Failed to resolve authenticated user (status ${resp.status})`);
    const data = await resp.json();

    if (!data.id) throw new Error(`Authenticated user response missing id: ${JSON.stringify(data)}`);
    return String(data.id);
}

async function resolveCreatorId({ creatorID, isGroup = false, cookie } = {}) {
    const fallbackCreatorId = String(process.env.ROBLOX_CREATOR_ID || "").trim();
    const normalizedCreatorId = String(creatorID || fallbackCreatorId).trim();
    if (normalizedCreatorId) {
        if (!/^\d+$/.test(normalizedCreatorId)) {
            throw new Error(`Invalid creator ID: ${creatorID}`);
        }
        return normalizedCreatorId;
    }

    if (isGroup) {
        throw new Error("Group uploads require --creator-id <groupId>.");
    }

    const resolvedCookie = resolveCookie(cookie);
    if (!resolvedCookie) {
        throw new Error(
            "Cannot auto-resolve creator ID: no cookie available. " +
            "Run \"sof run uploader env\" to save your credentials."
        );
    }

    return resolveAuthenticatedUserId(resolvedCookie);
}

const ANIMATION_UPLOAD_URL = "https://www.roblox.com/ide/publish/uploadnewanimation";

async function getCsrfToken(cookie) {
    const res = await fetch(ANIMATION_UPLOAD_URL, {
        method: "POST",
        headers: { "Cookie": cookie, "Content-Type": "application/xml", "Requester": "Client" },
        body: ""
    });
    const csrfToken = res.headers.get("x-csrf-token");
    if (!csrfToken) throw new Error("Failed to retrieve x-csrf-token from uploadnewanimation");
    return csrfToken;
}

async function actuallyUploadAnimation(rawXmlBuffer, displayName, description, cookie, csrfToken, creatorID, isGroup) {
    const url = new URL(ANIMATION_UPLOAD_URL);
    url.searchParams.set("name", displayName);
    url.searchParams.set("description", description);
    url.searchParams.set("isGamesAsset", "false");
    if (isGroup) url.searchParams.set("groupId", creatorID);
    else url.searchParams.set("userId", creatorID);
    url.searchParams.set("ispublic", "false");
    url.searchParams.set("assetTypeName", "animation");
    url.searchParams.set("AllID", "1");
    url.searchParams.set("allowComments", "false");

    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Cookie": cookie,
            "x-csrf-token": csrfToken,
            "Content-Type": "application/xml",
            "User-Agent": "RobloxStudio/WinInet RobloxApp/0.483.1.425021 (GlobalDist; RobloxDirectDownload)",
            "Requester": "Client"
        },
        body: rawXmlBuffer
    });

    if (!resp.ok) throw new Error(`Animation upload failed (status ${resp.status}): ${await resp.text()}`);
    const text = (await resp.text()).trim();
    const assetId = parseInt(text, 10);
    if (isNaN(assetId)) throw new Error(`Animation upload returned invalid assetId: ${text}`);
    return assetId;
}

async function uploadAnimationWithRetries(rawXmlBuffer, displayName, description, cookie, csrfToken, creatorID, isGroup, maxRetries = 5, retryDelayMs = 5000) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await actuallyUploadAnimation(rawXmlBuffer, displayName, description, cookie, csrfToken, creatorID, isGroup);
        } catch (err) {
            attempt++;
            if (attempt >= maxRetries) throw err;
            console.warn(`[uploadAnimationWithRetries] Attempt ${attempt} failed: ${err.message}. Retrying in ${retryDelayMs}ms...`);
            await sleep(retryDelayMs);
        }
    }
}

async function checkModeration(entry, apiKey) {
    let moderationState = entry.rawModeration?.moderationState ?? null;
    if (!moderationState) {
        try {
            const modData = await getAssetModeration(entry.newId, apiKey);
            moderationState = modData?.moderationState ?? null;
        } catch {
            moderationState = "Unknown";
        }
    }
    return moderationState;
}
/**
 * Upload image files (PNG, JPEG, or auto-converted from TGA/BMP/WebP/SVG/TIFF/GIF etc.)
 *
 * @param {Object}   options
 * @param {string[]} options.filePaths    
 * @param {string}   options.creatorID
 * @param {boolean}  [options.isGroup]
 * @param {string}   [options.apiKey]     
 * @param {Function} [options.onProgress]
 * @returns {Promise<JobResult>}
 */

async function uploadImageFiles({ filePaths, creatorID, isGroup = false, apiKey, onProgress } = {}) {
    const resolvedApiKey = resolveApiKey(apiKey);
    if (!resolvedApiKey) {
        throw new Error("uploadImageFiles: apiKey required (run \"sof run uploader env\" to configure)");
    }

    prepareOutputDir(outputDir);

    const report = { results: [], moderated: [], failures: [] };
    const progress = (done, total, msg) => onProgress?.(done, total, msg);

    const normalized = [];
    for (let i = 0; i < filePaths.length; i++) {
        const original = filePaths[i];
        try {
            const converted = await normalizeImageFile(original);
            normalized.push({ filePath: converted, originalPath: original });
        } catch (err) {
            report.failures.push({ assetId: original, stage: "convert", error: err.message });
        }
        progress(i + 1, filePaths.length, `${i + 1}/${filePaths.length} prepared`);
    }

    let uploadedCount = 0;
    for (let i = 0; i < normalized.length; i += 60) {
        const slice = normalized.slice(i, i + 60);
        const newlyCreated = [];

        for (const item of slice) {
            uploadedCount++;
            progress(uploadedCount, normalized.length, `${uploadedCount}/${normalized.length} uploading...`);
            try {
                const result = await openCloudUpload({
                    filePath: item.filePath,
                    assetType: "Image",
                    mimeType: item.filePath.endsWith(".png") ? "image/png" : "image/jpeg",
                    creatorID,
                    isGroup,
                    apiKey: resolvedApiKey
                });
                newlyCreated.push({ oldId: item.originalPath, newId: result.newAssetId, rawModeration: result.rawModeration });
                progress(uploadedCount, normalized.length, `${uploadedCount}/${normalized.length} uploaded`);
            } catch (err) {
                report.failures.push({ assetId: item.originalPath, stage: "upload", error: err.message });
            }
        }

        for (const entry of newlyCreated) {
            const state = await checkModeration(entry, resolvedApiKey);
            if (state && state !== "Approved") {
                report.moderated.push({ oldId: entry.oldId, newId: `rbxassetid://${entry.newId}`, state });
            } else {
                report.results.push({ oldId: entry.oldId, newId: `rbxassetid://${entry.newId}` });
            }
        }

        if (i + 60 < normalized.length) {
            progress(uploadedCount, normalized.length, "Waiting (rate limit)...");
            await sleep(60_000);
        }
    }

    return report;
}

/**
 *
 * @param {Object}   options
 * @param {string[]} options.assetIDs   
 * @param {string}   options.creatorID
 * @param {boolean}  [options.isGroup]
 * @param {string}   [options.apiKey]
 * @param {string}   [options.cookie]
 * @param {Function} [options.onProgress]
 * @returns {Promise<JobResult>}
 */
async function uploadImages({ assetIDs, creatorID, isGroup = false, apiKey, cookie, onProgress } = {}) {
    const resolvedApiKey = resolveApiKey(apiKey);
    if (!resolvedApiKey) {
        throw new Error("uploadImages: apiKey required (run \"sof run uploader env\" to configure)");
    }

    const resolvedCookie = resolveCookie(cookie);
    if (!resolvedCookie) throw new Error("uploadImages: .ROBLOSECURITY cookie not found");

    const report = { results: [], moderated: [], failures: [] };
    const progress = (done, total, msg) => onProgress?.(done, total, msg);

    const downloaded = [];
    for (let i = 0; i < assetIDs.length; i++) {
        const rbxAssetIdStr = assetIDs[i];
        const match = rbxAssetIdStr.match(/\d+/);
        if (!match) {
            report.failures.push({ assetId: rbxAssetIdStr, stage: "download", error: "Could not parse numeric ID" });
            progress(i + 1, assetIDs.length, `Parse fail: ${rbxAssetIdStr}`);
            continue;
        }
        const numericId = match[0];
        const fileName = `asset_${numericId}.png`;
        try {
            const fileData = await downloadAssetLegacyBufferWithRetries(numericId, resolvedCookie);
            downloaded.push({ fileData, fileName, oldId: rbxAssetIdStr });
            progress(i + 1, assetIDs.length, `${i + 1}/${assetIDs.length} downloaded`);
        } catch (err) {
            report.failures.push({ assetId: rbxAssetIdStr, stage: "download", error: err.message });
            progress(i + 1, assetIDs.length, `Download failed: ${rbxAssetIdStr}`);
        }
    }

    let uploadedCount = 0;
    for (let i = 0; i < downloaded.length; i += 60) {
        const slice = downloaded.slice(i, i + 60);
        const newlyCreated = [];

        for (const item of slice) {
            uploadedCount++;
            progress(uploadedCount, downloaded.length, `${uploadedCount}/${downloaded.length} uploading...`);
            try {
                const result = await openCloudUpload({
                    fileData: item.fileData,
                    fileName: item.fileName,
                    assetType: "Image",
                    mimeType: "image/png",
                    creatorID,
                    isGroup,
                    apiKey: resolvedApiKey,
                    oldAssetId: item.oldId
                });
                newlyCreated.push({ oldId: item.oldId, newId: result.newAssetId, rawModeration: result.rawModeration });
                progress(uploadedCount, downloaded.length, `${uploadedCount}/${downloaded.length} uploaded`);
            } catch (err) {
                report.failures.push({ assetId: item.oldId, stage: "upload", error: err.message });
            }
        }

        for (const entry of newlyCreated) {
            const state = await checkModeration(entry, resolvedApiKey);
            if (state && state !== "Approved") {
                report.moderated.push({ oldId: entry.oldId, newId: `rbxassetid://${entry.newId}`, state });
            } else {
                report.results.push({ oldId: entry.oldId, newId: `rbxassetid://${entry.newId}` });
            }
        }

        if (i + 60 < downloaded.length) {
            progress(uploadedCount, downloaded.length, "Waiting (rate limit)...");
            await sleep(60_000);
        }
    }

    return report;
}

/**
 *
 * @param {Object}   options
 * @param {string[]} options.filePaths    
 * @param {string}   options.creatorID
 * @param {boolean}  [options.isGroup]
 * @param {string}   [options.apiKey]
 * @param {Function} [options.onProgress]
 * @returns {Promise<JobResult>}
 */
async function uploadModelFiles({ filePaths, creatorID, isGroup = false, apiKey, onProgress } = {}) {
    const resolvedApiKey = resolveApiKey(apiKey);
    if (!resolvedApiKey) {
        throw new Error("uploadModelFiles: apiKey required (run \"sof run uploader env\" to configure)");
    }

    prepareOutputDir(outputDir);

    const report = { results: [], moderated: [], failures: [] };
    const progress = (done, total, msg) => onProgress?.(done, total, msg);

    let uploadedCount = 0;
    for (let i = 0; i < filePaths.length; i += 60) {
        const slice = filePaths.slice(i, i + 60);

        for (const filePath of slice) {
            uploadedCount++;
            const ext = path.extname(filePath).toLowerCase();

            if (!MESH_EXTS.has(ext)) {
                report.failures.push({ assetId: filePath, stage: "validate", error: `Unsupported model format: ${ext}` });
                progress(uploadedCount, filePaths.length, `Skipped unsupported: ${ext}`);
                continue;
            }

            progress(uploadedCount, filePaths.length, `${uploadedCount}/${filePaths.length} uploading ${ext}...`);
            try {
                const isRawMeshUpload = RAW_MESH_EXTS.has(ext);
                const result = await openCloudUpload({
                    filePath,
                    assetType: isRawMeshUpload ? "Mesh" : "Model",
                    mimeType: MESH_MIME[ext] || "application/octet-stream",
                    creatorID,
                    isGroup,
                    apiKey: resolvedApiKey
                });
                report.results.push({ oldId: filePath, newId: `rbxassetid://${result.newAssetId}` });
                progress(uploadedCount, filePaths.length, `${uploadedCount}/${filePaths.length} uploaded`);
            } catch (err) {
                report.failures.push({ assetId: filePath, stage: "upload", error: err.message });
                progress(uploadedCount, filePaths.length, `Upload failed: ${path.basename(filePath)}`);
            }
        }

        if (i + 60 < filePaths.length) {
            progress(uploadedCount, filePaths.length, "Waiting (rate limit)...");
            await sleep(60_000);
        }
    }

    return report;
}

/**
 *
 * @param {Object}   options
 * @param {string[]} options.assetIDs
 * @param {string}   options.creatorID
 * @param {boolean}  [options.isGroup]
 * @param {string}   [options.cookie]
 * @param {Function} [options.onProgress]
 * @returns {Promise<JobResult>}
 */
async function uploadAnimations({ assetIDs, creatorID, isGroup = false, cookie, onProgress } = {}) {
    const resolvedCookie = resolveCookie(cookie);
    if (!resolvedCookie) throw new Error("uploadAnimations: .ROBLOSECURITY cookie not found");

    prepareOutputDir(outputDir);

    const report = { results: [], moderated: [], failures: [] };
    const progress = (done, total, msg) => onProgress?.(done, total, msg);

    const downloaded = [];
    let downloadedCount = 0;
    for (let i = 0; i < assetIDs.length; i += 60) {
        const slice = assetIDs.slice(i, i + 60);
        for (const rbxAssetIdStr of slice) {
            downloadedCount++;
            const match = rbxAssetIdStr.match(/\d+/);
            if (!match) {
                report.failures.push({ assetId: rbxAssetIdStr, stage: "download", error: "Not a numeric ID" });
                progress(downloadedCount, assetIDs.length, `Invalid ID: ${rbxAssetIdStr}`);
                continue;
            }
            const numericId = match[0];
            const filePath = path.join(outputDir, `asset_${numericId}.xml`);
            try {
                await downloadAssetLegacyWithRetries(numericId, filePath, resolvedCookie);
                downloaded.push({ filePath, fileName: path.basename(filePath), oldId: rbxAssetIdStr });
                progress(downloadedCount, assetIDs.length, `${downloadedCount}/${assetIDs.length} downloaded`);
            } catch (err) {
                report.failures.push({ assetId: rbxAssetIdStr, stage: "download", error: err.message });
                progress(downloadedCount, assetIDs.length, `Download failed: ${rbxAssetIdStr}`);
            }
        }
    }

    const csrfToken = await getCsrfToken(resolvedCookie);
    let uploadedCount = 0;

    for (let i = 0; i < downloaded.length; i += 60) {
        const slice = downloaded.slice(i, i + 60);
        for (const item of slice) {
            uploadedCount++;
            progress(uploadedCount, downloaded.length, `${uploadedCount}/${downloaded.length} uploading animation...`);
            try {
                const buffer = fs.readFileSync(item.filePath);
                const newAssetId = await uploadAnimationWithRetries(
                    buffer,
                    item.fileName,
                    `Reuploaded from rbxassetid://${item.oldId}`,
                    resolvedCookie,
                    csrfToken,
                    creatorID,
                    isGroup
                );
                report.results.push({ oldId: item.oldId, newId: `rbxassetid://${newAssetId}` });
                progress(uploadedCount, downloaded.length, `${uploadedCount}/${downloaded.length} uploaded`);
            } catch (err) {
                report.failures.push({ assetId: item.oldId, stage: "upload", error: err.message });
                progress(uploadedCount, downloaded.length, `Upload failed: ${item.oldId}`);
            }
        }
    }

    return report;
}

/**
 *
 * @param {Object}   options
 * @param {string[]} options.assetIDs
 * @param {string}   options.creatorID
 * @param {boolean}  [options.isGroup]
 * @param {string}   [options.apiKey]
 * @param {string}   [options.cookie]
 * @param {Function} [options.onProgress]
 * @returns {Promise<JobResult>}
 */
async function uploadMeshes({ assetIDs, creatorID, isGroup = false, apiKey, cookie, onProgress } = {}) {
    const resolvedApiKey = resolveApiKey(apiKey);
    if (!resolvedApiKey) {
        throw new Error("uploadMeshes: apiKey required (run \"sof run uploader env\" to configure)");
    }

    const resolvedCookie = resolveCookie(cookie);
    if (!resolvedCookie) throw new Error("uploadMeshes: .ROBLOSECURITY cookie not found");

    const report = { results: [], moderated: [], failures: [] };
    const progress = (done, total, msg) => onProgress?.(done, total, msg);

    const downloaded = [];
    for (let i = 0; i < assetIDs.length; i++) {
        const rbxAssetIdStr = assetIDs[i];
        const match = rbxAssetIdStr.match(/\d+/);
        if (!match) {
            report.failures.push({ assetId: rbxAssetIdStr, stage: "download", error: "Could not parse numeric ID" });
            progress(i + 1, assetIDs.length, `Parse fail: ${rbxAssetIdStr}`);
            continue;
        }
        const numericId = match[0];
        const fileName = `asset_${numericId}.mesh`;
        try {
            const fileData = await downloadAssetLegacyBufferWithRetries(numericId, resolvedCookie);
            downloaded.push({ fileData, fileName, oldId: rbxAssetIdStr });
            progress(i + 1, assetIDs.length, `${i + 1}/${assetIDs.length} downloaded`);
        } catch (err) {
            report.failures.push({ assetId: rbxAssetIdStr, stage: "download", error: err.message });
            progress(i + 1, assetIDs.length, `Download failed: ${rbxAssetIdStr}`);
        }
    }

    let uploadedCount = 0;
    for (let i = 0; i < downloaded.length; i += 60) {
        const slice = downloaded.slice(i, i + 60);
        const newlyCreated = [];

        for (const item of slice) {
            uploadedCount++;
            progress(uploadedCount, downloaded.length, `${uploadedCount}/${downloaded.length} uploading mesh...`);
            try {
                const result = await openCloudUpload({
                    fileData: item.fileData,
                    fileName: item.fileName,
                    assetType: "Mesh",
                    mimeType: "model/x-file-mesh-data",
                    creatorID,
                    isGroup,
                    apiKey: resolvedApiKey,
                    oldAssetId: item.oldId
                });
                newlyCreated.push({ oldId: item.oldId, newId: result.newAssetId, rawModeration: result.rawModeration });
                progress(uploadedCount, downloaded.length, `${uploadedCount}/${downloaded.length} uploaded`);
            } catch (err) {
                report.failures.push({ assetId: item.oldId, stage: "upload", error: err.message });
                progress(uploadedCount, downloaded.length, `Upload failed: ${item.oldId}`);
            }
        }

        for (const entry of newlyCreated) {
            const state = await checkModeration(entry, resolvedApiKey);
            if (state && state !== "Approved") {
                report.moderated.push({ oldId: entry.oldId, newId: `rbxassetid://${entry.newId}`, state });
            } else {
                report.results.push({ oldId: entry.oldId, newId: `rbxassetid://${entry.newId}` });
            }
        }

        if (i + 60 < downloaded.length) {
            progress(uploadedCount, downloaded.length, "Waiting (rate limit)...");
            await sleep(60_000);
        }
    }

    return report;
}

module.exports = {
    resolveApiKey,
    resolveCookie,
    resolveAuthenticatedUserId,
    resolveCreatorId,
    downloadAssetLegacyBuffer,
    downloadAssetLegacyBufferWithRetries,
    openCloudUpload,

    uploadImageFiles,
    uploadModelFiles,

    uploadImages,
    uploadAnimations,
    uploadMeshes,
};