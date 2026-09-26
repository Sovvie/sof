"use strict";

const { createServer } = require("../remote-exec/server");
const { zstdCompressSync } = require("node:zlib");
const { downloadAssetLegacyBufferWithRetries } = require("./asset-upload");
const { sanitizeRoblosecurity } = require("./env");
const { parseMeshBuffer } = require("../mesh/parser");

const DEFAULT_REMOTE_EXEC_PORT = 8080;
const DEFAULT_REMOTE_EXEC_TIMEOUT_MS = 120_000;
const MESH_PAYLOAD_MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const BASE64_CHUNK_SIZE = 60_000;

function parseRemotePort(valueRaw, fallback = DEFAULT_REMOTE_EXEC_PORT) {
  if (valueRaw == null || String(valueRaw).trim() === "") {
    return fallback;
  }

  const value = Number.parseInt(String(valueRaw).trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid remote exec port: ${valueRaw}`);
  }
  return value;
}

function parseRemoteTimeout(valueRaw, fallback = DEFAULT_REMOTE_EXEC_TIMEOUT_MS) {
  if (valueRaw == null || String(valueRaw).trim() === "") {
    return fallback;
  }

  const value = Number.parseInt(String(valueRaw).trim(), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid remote timeout: ${valueRaw}`);
  }
  return value;
}

function normalizeOptionalCreatorId(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid creator ID: ${rawValue}`);
  }
  return value;
}

function resolveMeshDownloadCookie(cookieOverride) {
  const token = sanitizeRoblosecurity(cookieOverride || process.env.ROBLOSECURITY || "");
  if (!token) {
    return null;
  }
  return `.ROBLOSECURITY=${token}`;
}

function extractNumericAssetId(rawValue) {
  const match = String(rawValue || "").match(/\d+/);
  return match ? match[0] : null;
}

function buildUploadableMeshPayload(parsedMesh) {
  if (!parsedMesh || typeof parsedMesh !== "object") {
    throw new Error("Parsed mesh payload is missing.");
  }

  if (!Array.isArray(parsedMesh.vertices) || !Array.isArray(parsedMesh.faces)) {
    throw new Error("Parsed mesh is missing vertices or faces arrays.");
  }

  const payload = {
    version: String(parsedMesh.version || "unknown"),
    vertices: parsedMesh.vertices,
    faces: parsedMesh.faces,
  };

  if (Array.isArray(parsedMesh.normals) && parsedMesh.normals.length === parsedMesh.vertices.length) {
    payload.normals = parsedMesh.normals;
  }

  if (Array.isArray(parsedMesh.uvs) && parsedMesh.uvs.length === parsedMesh.vertices.length) {
    payload.uvs = parsedMesh.uvs;
  }

  return payload;
}

function splitIntoChunks(value, chunkSize = BASE64_CHUNK_SIZE) {
  const out = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    out.push(value.slice(index, index + chunkSize));
  }
  return out;
}

function buildMeshEditableScriptFromCompressedPayload(base64Payload, numericAssetId) {
  const chunkLines = splitIntoChunks(base64Payload)
    .map((chunk) => `  ${JSON.stringify(chunk)},`)
    .join("\n");

  return [
    'local HttpService = game:GetService("HttpService")',
    'local AssetService = game:GetService("AssetService")',
    'local EncodingService = game:GetService("EncodingService")',
    "",
    "-- Rebuilt from parsed mesh payload (compressed in Node, decompressed in Studio).",
    "local compressedBase64 = table.concat({",
    chunkLines,
    "})",
    "",
    "local compressedBuffer = EncodingService:Base64Decode(buffer.fromstring(compressedBase64))",
    "local payloadBuffer = EncodingService:DecompressBuffer(",
    "  compressedBuffer,",
    "  Enum.CompressionAlgorithm.Zstd",
    ")",
    "local payload = HttpService:JSONDecode(buffer.tostring(payloadBuffer))",
    "",
    "local editableMesh = AssetService:CreateEditableMesh({ FixedSize = false })",
    "local vertexIds = table.create(#payload.vertices)",
    "for index, xyz in ipairs(payload.vertices) do",
    "  vertexIds[index] = editableMesh:AddVertex(Vector3.new(xyz[1], xyz[2], xyz[3]))",
    "end",
    "",
    "local uvIds = nil",
    "if payload.uvs and #payload.uvs == #payload.vertices then",
    "  uvIds = table.create(#payload.uvs)",
    "  for index, uv in ipairs(payload.uvs) do",
    "    uvIds[index] = editableMesh:AddUV(Vector2.new(uv[1], uv[2]))",
    "  end",
    "end",
    "",
    "local normalIds = nil",
    "if payload.normals and #payload.normals == #payload.vertices then",
    "  normalIds = table.create(#payload.normals)",
    "  for index, n in ipairs(payload.normals) do",
    "    normalIds[index] = editableMesh:AddNormal(Vector3.new(n[1], n[2], n[3]))",
    "  end",
    "end",
    "",
    "for faceIndex, tri in ipairs(payload.faces) do",
    "  local a = tri[1] + 1",
    "  local b = tri[2] + 1",
    "  local c = tri[3] + 1",
    "  local va = vertexIds[a]",
    "  local vb = vertexIds[b]",
    "  local vc = vertexIds[c]",
    "  if not va or not vb or not vc then",
    `    error(string.format("Invalid triangle indices for source mesh ${numericAssetId} at face %d", faceIndex))`,
    "  end",
    "",
    "  local faceId = editableMesh:AddTriangle(va, vb, vc)",
    "",
    "  if uvIds then",
    "    editableMesh:SetFaceUVs(faceId, { uvIds[a], uvIds[b], uvIds[c] })",
    "  end",
    "",
    "  if normalIds then",
    "    editableMesh:SetFaceNormals(faceId, { normalIds[a], normalIds[b], normalIds[c] })",
    "  end",
    "end",
    "",
    "return editableMesh",
  ].join("\n");
}

function buildCompressedMeshScriptFromSourceBuffer(meshBuffer, numericAssetId) {
  const parsedMesh = parseMeshBuffer(meshBuffer);
  const payload = buildUploadableMeshPayload(parsedMesh);
  const payloadBuffer = Buffer.from(JSON.stringify(payload), "utf8");
  const compressedPayload = zstdCompressSync(payloadBuffer);

  if (compressedPayload.length > MESH_PAYLOAD_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `Mesh payload is too large after compression (${compressedPayload.length} bytes).`
    );
  }

  const base64Payload = compressedPayload.toString("base64");
  return buildMeshEditableScriptFromCompressedPayload(base64Payload, numericAssetId);
}

function extractCreatedAssetId(result) {
  if (typeof result === "number") {
    return String(result);
  }
  if (typeof result === "string" && result.trim() !== "") {
    return result.trim();
  }
  if (result && typeof result === "object" && result.assetId != null) {
    return String(result.assetId);
  }
  throw new Error(`CreateAssetAsync result missing assetId: ${JSON.stringify(result)}`);
}

async function uploadMeshesViaRemoteExec({
  assetIDs,
  creatorID,
  cookie = null,
  isGroup = false,
  remotePort = DEFAULT_REMOTE_EXEC_PORT,
  remoteTimeout = DEFAULT_REMOTE_EXEC_TIMEOUT_MS,
  onProgress,
  logger = console,
} = {}) {
  if (!Array.isArray(assetIDs)) {
    throw new Error("uploadMeshesViaRemoteExec requires assetIDs array.");
  }

  const resolvedCreatorId = normalizeOptionalCreatorId(creatorID);
  if (isGroup && !resolvedCreatorId) {
    throw new Error("Group uploads require creatorID.");
  }

  const resolvedPort = parseRemotePort(remotePort, DEFAULT_REMOTE_EXEC_PORT);
  const resolvedTimeout = parseRemoteTimeout(remoteTimeout, DEFAULT_REMOTE_EXEC_TIMEOUT_MS);
  const resolvedCookie = resolveMeshDownloadCookie(cookie || null);

  const report = { results: [], moderated: [], failures: [] };
  const progress = (done, total, msg) => onProgress?.(done, total, msg);

  const server = await createServer({
    port: resolvedPort,
    defaultTimeout: resolvedTimeout,
  });

  try {
    logger.log?.(`[uploader] Waiting for Remote Exec plugin on ws://127.0.0.1:${resolvedPort}...`);
    await server.waitForConnection({ timeout: resolvedTimeout });
    logger.log?.("[uploader] Remote Exec plugin connected.");
    if (!resolvedCookie) {
      logger.warn?.(
        "[uploader] No .ROBLOSECURITY cookie found; downloading source meshes may fail for private assets."
      );
    }

    for (let index = 0; index < assetIDs.length; index += 1) {
      const oldId = assetIDs[index];
      const numericId = extractNumericAssetId(oldId);
      if (!numericId) {
        report.failures.push({
          assetId: oldId,
          stage: "validate",
          error: "Could not parse numeric asset ID.",
        });
        progress(index + 1, assetIDs.length, `Invalid asset ID: ${oldId}`);
        continue;
      }

      progress(index + 1, assetIDs.length, `${index + 1}/${assetIDs.length} downloading source mesh...`);

      const requestParameters = {
        Name: `Mesh ${numericId}`,
        Description: `Reuploaded from rbxassetid://${numericId}`,
      };

      if (resolvedCreatorId) {
        requestParameters.CreatorId = Number.parseInt(resolvedCreatorId, 10);
        requestParameters.CreatorType = isGroup ? "Group" : "User";
      }

      try {
        const sourceBuffer = await downloadAssetLegacyBufferWithRetries(numericId, resolvedCookie);
        progress(index + 1, assetIDs.length, `${index + 1}/${assetIDs.length} parsing/compressing mesh...`);

        const payloadScript = buildCompressedMeshScriptFromSourceBuffer(sourceBuffer, numericId);
        progress(index + 1, assetIDs.length, `${index + 1}/${assetIDs.length} executing Studio payload...`);

        const createResult = await server.createAsset(payloadScript, {
          assetType: "Mesh",
          requestParameters,
          timeout: resolvedTimeout,
        });

        const newAssetId = extractCreatedAssetId(createResult);
        report.results.push({
          oldId,
          newId: `rbxassetid://${newAssetId}`,
        });
        progress(index + 1, assetIDs.length, `${index + 1}/${assetIDs.length} uploaded`);
      } catch (error) {
        report.failures.push({
          assetId: oldId,
          stage: "upload",
          error: error.message,
        });
        progress(index + 1, assetIDs.length, `Upload failed: ${oldId}`);
      }
    }
  } finally {
    await server.close();
  }

  return report;
}

module.exports = {
  DEFAULT_REMOTE_EXEC_PORT,
  DEFAULT_REMOTE_EXEC_TIMEOUT_MS,
  uploadMeshesViaRemoteExec,
};
