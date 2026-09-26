"use strict";

const fs = require("fs");

class Cursor {
    constructor(buffer) {
        if (!Buffer.isBuffer(buffer)) throw new Error("Mesh parser expected a Buffer.");
        this.buffer = buffer;
        this.offset = 0;
    }

    ensure(size, label = "read") {
        if (this.offset + size > this.buffer.length) {
            throw new Error(
                `Unexpected EOF while trying to ${label}. ` +
                `Need ${size} bytes at offset ${this.offset}, but only ${this.remaining()} remain.`
            );
        }
    }

    remaining() { return this.buffer.length - this.offset; }

    bytes(size) {
        this.ensure(size, `read ${size} bytes`);
        const out = this.buffer.subarray(this.offset, this.offset + size);
        this.offset += size;
        return out;
    }

    skip(size) {
        this.ensure(size, `skip ${size} bytes`);
        this.offset += size;
    }

    u8()  { this.ensure(1, "u8");  const v = this.buffer.readUInt8(this.offset);       this.offset += 1; return v; }
    i8()  { this.ensure(1, "i8");  const v = this.buffer.readInt8(this.offset);        this.offset += 1; return v; }
    u16() { this.ensure(2, "u16"); const v = this.buffer.readUInt16LE(this.offset);    this.offset += 2; return v; }
    u32() { this.ensure(4, "u32"); const v = this.buffer.readUInt32LE(this.offset);    this.offset += 4; return v; }
    u64() { this.ensure(8, "u64"); const v = this.buffer.readBigUInt64LE(this.offset); this.offset += 8; return v; }
    f32() { this.ensure(4, "f32"); const v = this.buffer.readFloatLE(this.offset);     this.offset += 4; return v; }

    ascii(size) { return this.bytes(size).toString("utf8"); }
}

function parseTripleFloats(raw) {
    const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
    if (parts.length !== 3) throw new Error(`Expected triple float, got: "${raw}"`);
    const out = parts.map(Number.parseFloat);
    if (out.some(Number.isNaN)) throw new Error(`Failed to parse float triple: "${raw}"`);
    return out;
}

function fixTangent(t) {
    return (t[0] === -128 && t[1] === -128 && t[2] === -128 && t[3] === -128)
        ? [0, 0, -128, 127]
        : t;
}

function parseFaces(cursor, count) {
    const faces = new Array(count);
    for (let i = 0; i < count; i++) faces[i] = [cursor.u32(), cursor.u32(), cursor.u32()];
    return faces;
}

function parseLods(cursor, count) {
    const lods = new Array(count);
    for (let i = 0; i < count; i++) lods[i] = cursor.u32();
    return lods;
}

function parseVertexStream(cursor, count, vertexSize) {
    const vertices = new Array(count);
    const normals  = new Array(count);
    const uvs      = new Array(count);
    const tangents = new Array(count);
    const colors   = new Array(count);
    for (let i = 0; i < count; i++) {
        vertices[i] = [cursor.f32(), cursor.f32(), cursor.f32()];
        normals[i]  = [cursor.f32(), cursor.f32(), cursor.f32()];
        uvs[i]      = [cursor.f32(), cursor.f32()];
        tangents[i] = fixTangent([cursor.i8(), cursor.i8(), cursor.i8(), cursor.i8()]);
        colors[i]   = vertexSize === 40
            ? [cursor.u8(), cursor.u8(), cursor.u8(), cursor.u8()]
            : [255, 255, 255, 255];
    }
    return { vertices, normals, uvs, tangents, colors };
}

function parseSkinning(cursor, count) {
    return Array.from({ length: count }, () => ({
        bones:   [cursor.u8(), cursor.u8(), cursor.u8(), cursor.u8()],
        weights: [cursor.u8(), cursor.u8(), cursor.u8(), cursor.u8()],
    }));
}

function parseBones(cursor, count) {
    const bones = new Array(count);
    for (let i = 0; i < count; i++) {
        bones[i] = {
            boneNamePos:  cursor.u32(),
            parent:       cursor.u16(),
            lodParent:    cursor.u16(),
            cullDistance: cursor.f32(),
            cframe:       Array.from({ length: 12 }, () => cursor.f32()),
        };
    }
    return bones;
}

function parseSubsets(cursor, count) {
    const subsets = new Array(count);
    for (let i = 0; i < count; i++) {
        subsets[i] = {
            facesOffset:    cursor.u32(),
            facesLen:       cursor.u32(),
            verticesOffset: cursor.u32(),
            verticesLen:    cursor.u32(),
            boneCount:      cursor.u32(),
            bones:          Array.from({ length: 26 }, () => cursor.u16()),
        };
    }
    return subsets;
}

function resolveBoneNames(nameBuf, bones) {
    const text = nameBuf.toString("utf8");
    return bones.map(b => {
        const end = text.indexOf("\0", b.boneNamePos);
        return end === -1 ? text.slice(b.boneNamePos) : text.slice(b.boneNamePos, end);
    });
}

function splitNullTerminated(buf) {
    const text = buf.toString("utf8");
    const out  = [];
    let start  = 0;
    for (let i = 0; i <= text.length; i++) {
        if (i === text.length || text[i] === "\0") {
            if (i > start) out.push(text.slice(start, i));
            start = i + 1;
        }
    }
    return out;
}

function emptyResult() {
    return {
        version:     "",
        vertexCount: 0,
        faceCount:   0,
        vertices:    [],
        normals:     [],
        uvs:         [],
        tangents:    [],
        colors:      [],
        faces:       [],
        lods:        [],
        skinning:    [],
        bones:       [],
        boneNames:   [],
        subsets:     [],
        facs:        null,
        hsravis:     null,
        metadata:    {},
    };
}

function parseQuantizedMatrix(cursor) {
    const version = cursor.u16();
    const rows    = cursor.u32();
    const cols    = cursor.u32();
    const total   = rows * cols;

    if (version === 1) {
        const matrix = Array.from({ length: total }, () => cursor.f32());
        return { version: 1, rows, cols, matrix };
    }

    if (version === 2) {
        const min       = cursor.f32();
        const max       = cursor.f32();
        const precision = (max - min) / 65535;
        const matrix    = Array.from({ length: total }, () => min + cursor.u16() * precision);
        return { version: 2, rows, cols, min, max, matrix };
    }

    throw new Error(`Unknown QuantizedMatrix version: ${version}`);
}

function parseFacsData(cursor) {
    const faceBoneNamesSize    = cursor.u32();
    const faceControlNamesSize = cursor.u32();

    cursor.u64();

    const twoPoseSize   = cursor.u32();
    const threePoseSize = cursor.u32();

    const faceBoneNames    = splitNullTerminated(cursor.bytes(faceBoneNamesSize));
    const faceControlNames = splitNullTerminated(cursor.bytes(faceControlNamesSize));

    const quantizedTransforms = {
        px: parseQuantizedMatrix(cursor),
        py: parseQuantizedMatrix(cursor),
        pz: parseQuantizedMatrix(cursor),
        rx: parseQuantizedMatrix(cursor),
        ry: parseQuantizedMatrix(cursor),
        rz: parseQuantizedMatrix(cursor),
    };

    const twoPoseCorrectives = Array.from({ length: twoPoseSize / 4 }, () => ({
        controlIndex0: cursor.u16(),
        controlIndex1: cursor.u16(),
    }));

    const threePoseCorrectives = Array.from({ length: threePoseSize / 6 }, () => ({
        controlIndex0: cursor.u16(),
        controlIndex1: cursor.u16(),
        controlIndex2: cursor.u16(),
    }));

    const augmentedNames = [...faceControlNames];
    for (const c of twoPoseCorrectives) {
        augmentedNames.push(`${faceControlNames[c.controlIndex0]}_${faceControlNames[c.controlIndex1]}`);
    }
    for (const c of threePoseCorrectives) {
        augmentedNames.push(
            `${faceControlNames[c.controlIndex0]}_` +
            `${faceControlNames[c.controlIndex1]}_` +
            `${faceControlNames[c.controlIndex2]}`
        );
    }

    return {
        faceBoneNames,
        faceControlNames: augmentedNames,
        quantizedTransforms,
        twoPoseCorrectives,
        threePoseCorrectives,
    };
}

let _dracoPromise = null;

function getDracoModule() {
    if (!_dracoPromise) {
        let draco3d;
        try {
            draco3d = require("draco3d");
        } catch {
            return Promise.reject(
                new Error(
                    "The draco3d package is required to parse version 7.00 meshes.\n" +
                    "Install it with:  npm install draco3d"
                )
            );
        }
        _dracoPromise = draco3d.createDecoderModule({});
    }
    return _dracoPromise;
}

function dracoReadFloat(draco, decoder, mesh, uid, numPoints, numComponents) {
    const attr = decoder.GetAttributeByUniqueId(mesh, uid);
    if (!attr || attr.ptr === 0) {
        return Array.from({ length: numPoints }, () => new Array(numComponents).fill(0));
    }
    const arr = new draco.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, attr, arr);
    const out = new Array(numPoints);
    for (let i = 0; i < numPoints; i++) {
        const row = new Array(numComponents);
        for (let c = 0; c < numComponents; c++) row[c] = arr.GetValue(i * numComponents + c);
        out[i] = row;
    }
    draco.destroy(arr);
    return out;
}

function dracoReadUint8x4(draco, decoder, mesh, uid, numPoints) {
    const attr = decoder.GetAttributeByUniqueId(mesh, uid);
    if (!attr || attr.ptr === 0) return null;
    const arr = new draco.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, attr, arr);
    const out = new Array(numPoints);
    for (let i = 0; i < numPoints; i++) {
        out[i] = [
            Math.round(arr.GetValue(i * 4))     & 0xFF,
            Math.round(arr.GetValue(i * 4 + 1)) & 0xFF,
            Math.round(arr.GetValue(i * 4 + 2)) & 0xFF,
            Math.round(arr.GetValue(i * 4 + 3)) & 0xFF,
        ];
    }
    draco.destroy(arr);
    return out;
}

async function decodeDracoMesh(buf) {
    const draco = await getDracoModule();

    const decBuf = new draco.DecoderBuffer();

    decBuf.Init(new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength), buf.byteLength);

    const decoder  = new draco.Decoder();
    const geomType = decoder.GetEncodedGeometryType(decBuf);

    if (geomType !== draco.TRIANGULAR_MESH) {
        draco.destroy(decoder);
        throw new Error(`Draco: expected TRIANGULAR_MESH, got geometry type ${geomType}`);
    }

    const mesh   = new draco.Mesh();
    const status = decoder.DecodeBufferToMesh(decBuf, mesh);

    draco.destroy(decBuf);   

    if (!status.ok()) {
        draco.destroy(mesh);
        draco.destroy(decoder);
        throw new Error(`Draco decode failed: ${status.error_msg()}`);
    }

    const vertexCount = mesh.num_points();
    const faceCount   = mesh.num_faces();

    const vertices = dracoReadFloat(draco, decoder, mesh, 0, vertexCount, 3);
    const normals  = dracoReadFloat(draco, decoder, mesh, 1, vertexCount, 3);
    const uvs      = dracoReadFloat(draco, decoder, mesh, 2, vertexCount, 2);

    const rawTangents = dracoReadUint8x4(draco, decoder, mesh, 3, vertexCount);
    const tangents = rawTangents
        ? rawTangents.map(t => fixTangent(t.map(v => v > 127 ? v - 256 : v)))
        : Array.from({ length: vertexCount }, () => [0, 0, -128, 127]);

    const colors = dracoReadUint8x4(draco, decoder, mesh, 4, vertexCount)
        ?? Array.from({ length: vertexCount }, () => [255, 255, 255, 255]);

    const faces  = new Array(faceCount);
    const idxArr = new draco.DracoInt32Array();
    for (let i = 0; i < faceCount; i++) {
        decoder.GetFaceFromMesh(mesh, i, idxArr);
        faces[i] = [idxArr.GetValue(0), idxArr.GetValue(1), idxArr.GetValue(2)];
    }
    draco.destroy(idxArr);
    draco.destroy(mesh);
    draco.destroy(decoder);

    return { vertices, normals, uvs, tangents, colors, vertexCount, faceCount, faces };
}

function parseV1(buffer, revision) {
    const lines     = buffer.toString("utf8").split(/\r?\n/);
    const faceCount = Number.parseInt(String(lines[1] || "").trim(), 10);
    if (!Number.isFinite(faceCount) || faceCount < 0) {
        throw new Error(`Invalid face count in version ${revision} mesh.`);
    }

    const vertices = [], normals = [], uvs = [], tangents = [], colors = [];

    for (const match of lines.slice(2).join("").matchAll(/\[(.*?)\]\[(.*?)\]\[(.*?)\]/g)) {
        const pos  = parseTripleFloats(match[1]);
        const norm = parseTripleFloats(match[2]);
        const tex  = parseTripleFloats(match[3]);
        tex[1] = 1 - tex[1];
        if (revision === "1.00") { pos[0] *= 0.5; pos[1] *= 0.5; pos[2] *= 0.5; }
        vertices.push(pos);
        normals.push(norm);
        uvs.push([tex[0], tex[1]]);
        tangents.push([0, 0, -128, 127]);
        colors.push([255, 255, 255, 255]);
    }

    if (vertices.length !== faceCount * 3) {
        throw new Error(`v${revision}: expected ${faceCount * 3} vertices, got ${vertices.length}.`);
    }

    return {
        ...emptyResult(),
        version:     revision,
        vertexCount: vertices.length,
        faceCount,
        vertices, normals, uvs, tangents, colors,
        faces:    Array.from({ length: faceCount }, (_, i) => [i * 3, i * 3 + 1, i * 3 + 2]),
        metadata: { source: "ascii-v1" },
    };
}

function parseV2(cursor) {
    cursor.skip(1);
    const headerSize = cursor.u16();
    const vertexSize = cursor.u8();
    if (vertexSize !== 36 && vertexSize !== 40) throw new Error(`Unsupported v2 vertex size: ${vertexSize}`);
    cursor.skip(1);
    const vertexCount = cursor.u32();
    const faceCount   = cursor.u32();
    return {
        ...emptyResult(),
        version: "2.00", vertexCount, faceCount,
        ...parseVertexStream(cursor, vertexCount, vertexSize),
        faces:    parseFaces(cursor, faceCount),
        metadata: { headerSize, vertexSize },
    };
}

function parseV3(cursor, revision) {
    cursor.skip(1);
    const headerStart = cursor.offset;
    const headerSize  = cursor.u16();
    const vertexSize  = cursor.u8();
    if (vertexSize !== 36 && vertexSize !== 40) throw new Error(`Unsupported v3 vertex size: ${vertexSize}`);
    cursor.skip(1); cursor.skip(2);
    const lodCount    = cursor.u16();
    const vertexCount = cursor.u32();
    const faceCount   = cursor.u32();
    cursor.offset = headerStart + headerSize;
    return {
        ...emptyResult(), version: revision, vertexCount, faceCount,
        ...parseVertexStream(cursor, vertexCount, vertexSize),
        faces: parseFaces(cursor, faceCount), lods: parseLods(cursor, lodCount),
        metadata: { headerSize, vertexSize, lodCount },
    };
}

function parseV4(cursor, revision) {
    cursor.skip(1);
    const headerStart  = cursor.offset;
    const headerSize   = cursor.u16();
    const lodType      = cursor.u16();
    const vertexCount  = cursor.u32();
    const faceCount    = cursor.u32();
    const lodCount     = cursor.u16();
    const boneCount    = cursor.u16();
    const boneNamesLen = cursor.u32();
    const subsetCount  = cursor.u16();
    const lodHqCount   = cursor.u8();
    cursor.offset = headerStart + headerSize;

    const vertexData   = parseVertexStream(cursor, vertexCount, 40);
    const skinning     = boneCount > 0 ? parseSkinning(cursor, vertexCount) : [];
    const faces        = parseFaces(cursor, faceCount);
    const lods         = parseLods(cursor, lodCount);
    const rawBones     = parseBones(cursor, boneCount);
    const boneNamesBuf = cursor.bytes(boneNamesLen);
    const subsets      = parseSubsets(cursor, subsetCount);
    const boneNames    = resolveBoneNames(boneNamesBuf, rawBones);
    return {
        ...emptyResult(), version: revision, vertexCount, faceCount,
        ...vertexData, faces, lods, skinning, subsets,
        bones: rawBones.map((b, i) => ({ ...b, name: boneNames[i] })), boneNames,
        metadata: { headerSize, lodType, lodHqCount, boneCount, subsetCount },
    };
}

function parseV5(cursor) {
    cursor.skip(1);
    const headerStart  = cursor.offset;
    const headerSize   = cursor.u16();
    const lodType      = cursor.u16();
    const vertexCount  = cursor.u32();
    const faceCount    = cursor.u32();
    const lodCount     = cursor.u16();
    const boneCount    = cursor.u16();
    const boneNamesLen = cursor.u32();
    const subsetCount  = cursor.u16();
    const lodHqCount   = cursor.u8();
    cursor.skip(1);
    const facsFormat   = cursor.u32();
    const facsSize     = cursor.u32();
    cursor.offset = headerStart + headerSize;

    const vertexData   = parseVertexStream(cursor, vertexCount, 40);
    const skinning     = boneCount > 0 ? parseSkinning(cursor, vertexCount) : [];
    const faces        = parseFaces(cursor, faceCount);
    const lods         = parseLods(cursor, lodCount);
    const rawBones     = parseBones(cursor, boneCount);
    const boneNamesBuf = cursor.bytes(boneNamesLen);
    const subsets      = parseSubsets(cursor, subsetCount);
    const boneNames    = resolveBoneNames(boneNamesBuf, rawBones);
    let facs = null;
    if (facsFormat === 1 && facsSize > 0 && cursor.remaining() > 0) {
        const facsEnd = cursor.offset + Math.min(facsSize, cursor.remaining());
        facs = parseFacsData(cursor);
        cursor.offset = facsEnd;
    }
    return {
        ...emptyResult(), version: "5.00", vertexCount, faceCount,
        ...vertexData, faces, lods, skinning, subsets,
        bones: rawBones.map((b, i) => ({ ...b, name: boneNames[i] })), boneNames, facs,
        metadata: { headerSize, lodType, lodHqCount, boneCount, subsetCount, facsFormat, facsSize },
    };
}

const LOD_TYPE_NAMES = { 0: "None", 1: "Unknown", 2: "RbxSimplifier", 3: "ZeuxMeshOptimizer" };

async function parseChunkCoreMesh(data, chunkVersion) {
    if (chunkVersion === 2) {
        const cur       = new Cursor(data);
        const dracoSize = cur.u32();
        const dracoBuf  = cur.bytes(dracoSize);
        return await decodeDracoMesh(dracoBuf);
    }

    const cur         = new Cursor(data);
    const vertexCount = cur.u32();
    const vertexData  = parseVertexStream(cur, vertexCount, 40);
    const faceCount   = cur.u32();
    const faces       = parseFaces(cur, faceCount);
    return { vertexCount, faceCount, ...vertexData, faces };
}

function parseChunkLods(data) {
    const cur        = new Cursor(data);
    const lodType    = cur.u16();
    const lodHqCount = cur.u8();
    cur.skip(1);
    const lodCount   = cur.u32();
    const lods       = parseLods(cur, lodCount);
    return { lodType, lodTypeName: LOD_TYPE_NAMES[lodType] ?? "Unknown", lodHqCount, lods };
}

function parseChunkSkinning(data) {
    const cur         = new Cursor(data);
    const skinCount   = cur.u32();
    const skinning    = parseSkinning(cur, skinCount);
    const boneCount   = cur.u32();
    const rawBones    = parseBones(cur, boneCount);
    const nameSize    = cur.u32();
    const nameBuf     = cur.bytes(nameSize);
    const subsetCount = cur.u32();
    const subsets     = parseSubsets(cur, subsetCount);
    const boneNames   = resolveBoneNames(nameBuf, rawBones);
    return {
        skinning,
        bones:     rawBones.map((b, i) => ({ ...b, name: boneNames[i] })),
        boneNames,
        subsets,
    };
}

function parseChunkFacs(data) {
    const cur = new Cursor(data);
    cur.u32(); 
    return parseFacsData(cur);
}

function parseChunkHsravis(data) {
    const cur      = new Cursor(data);
    const bitCount = cur.u32();
    const raw      = cur.bytes(Math.ceil(bitCount / 8));
    const flags    = Array.from({ length: bitCount }, (_, i) => ((raw[i >> 3] >> (i & 7)) & 1) === 1);
    return { bitCount, alwaysVisibleFlags: flags };
}

async function parseV6orV7(cursor, version) {
    cursor.skip(1);

    const result = { ...emptyResult(), version, metadata: { chunks: [] } };

    while (cursor.remaining() >= 16) {
        const chunkType    = cursor.ascii(8).replace(/\0+$/, "").trim();
        const chunkVersion = cursor.u32();
        const chunkSize    = cursor.u32();

        if (cursor.remaining() < chunkSize) {
            throw new Error(
                `Chunk "${chunkType}" declares ${chunkSize} bytes but only ${cursor.remaining()} remain.`
            );
        }

        const chunkData = cursor.bytes(chunkSize);
        result.metadata.chunks.push({ type: chunkType, version: chunkVersion, size: chunkSize });

        try {
            switch (chunkType) {
                case "COREMESH": {
                    const c = await parseChunkCoreMesh(chunkData, chunkVersion);
                    Object.assign(result, c);
                    break;
                }
                case "LODS": {
                    const c = parseChunkLods(chunkData);
                    result.lods = c.lods;
                    result.metadata.lodType     = c.lodType;
                    result.metadata.lodTypeName = c.lodTypeName;
                    result.metadata.lodHqCount  = c.lodHqCount;
                    break;
                }
                case "SKINNING": {
                    const c = parseChunkSkinning(chunkData);
                    result.skinning  = c.skinning;
                    result.bones     = c.bones;
                    result.boneNames = c.boneNames;
                    result.subsets   = c.subsets;
                    break;
                }
                case "FACS": {
                    result.facs = parseChunkFacs(chunkData);
                    break;
                }
                case "HSRAVIS": {
                    result.hsravis = parseChunkHsravis(chunkData);
                    break;
                }
            }
        } catch (err) {
            throw new Error(`Failed to parse chunk "${chunkType}" v${chunkVersion}: ${err.message}`);
        }
    }

    return result;
}

async function parseMeshBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new Error("parseMeshBuffer expects a Buffer.");
    if (buffer.length < 12)       throw new Error("Buffer too small to be a Roblox mesh.");

    const prefix = buffer.subarray(0, 12).toString("utf8");
    if (prefix === "version 1.00") return parseV1(buffer, "1.00");
    if (prefix === "version 1.01") return parseV1(buffer, "1.01");

    const cursor   = new Cursor(buffer);
    const magic    = cursor.ascii(8);
    if (magic !== "version ") throw new Error(`Unknown mesh magic: "${magic}"`);
    const revision = cursor.ascii(4);

    if (revision === "2.00")                        return parseV2(cursor);
    if (revision === "3.00" || revision === "3.01") return parseV3(cursor, revision);
    if (revision === "4.00" || revision === "4.01") return parseV4(cursor, revision);
    if (revision === "5.00")                        return parseV5(cursor);
    if (revision === "6.00")                        return parseV6orV7(cursor, "6.00");
    if (revision === "7.00")                        return parseV6orV7(cursor, "7.00");

    throw new Error(`Unsupported mesh revision: "${revision}"`);
}

async function parseMeshFile(filePath) {
    return parseMeshBuffer(fs.readFileSync(filePath));
}

module.exports = { parseMeshBuffer, parseMeshFile };