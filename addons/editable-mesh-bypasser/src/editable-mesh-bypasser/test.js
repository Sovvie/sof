'use strict';

const fs             = require('fs');
const os             = require('os');
const path           = require('path');
const http           = require('http');
const https          = require('https');
const zlib           = require('zlib');
const { exec }       = require('child_process');
const sharp          = require('sharp');

const { parseMeshBuffer } = require('./parse');
const { loadUploaderEnv, sanitizeRoblosecurity } = require('../uploader/env');

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const LOG_DIR      = path.join(os.homedir(), '.sof');
const LOG_PATH     = path.join(LOG_DIR, 'editable-mesh-bypasser.log');

const MAX_IMAGE_SIZE = 1024;

let _logStream = null;

function openLogStream() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    _logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    return _logStream;
}

function closeLogStream() {
    if (_logStream) {
        _logStream.end();
        _logStream = null;
    }
}

const TERM_LOG_DIR = path.join(os.tmpdir(), 'sof-logs');

const CONTENT_TYPE_EXTENSIONS = {
    'image/png':                '.png',
    'image/jpeg':               '.jpg',
    'image/bmp':                '.bmp',
    'image/tga':                '.tga',
    'image/webp':               '.webp',
    'application/octet-stream': '.bin',
};

function openInEditor(filePath) {
    const candidates = process.env.TERM_PROGRAM === 'vscode'
        ? ['cursor', 'code']
        : ['code'];

    for (const cmd of candidates) {
        try {
            const child = exec(`"${cmd}" "${filePath}"`, { windowsHide: true });
            child.unref();
            return true;
        } catch {
            // binary not on PATH, try next
        }
    }
    return false;
}

function resolveCookie() {
    const raw = process.env.ROBLOSECURITY || '';
    const value = sanitizeRoblosecurity(raw);
    if (!value) return '';
    return `.ROBLOSECURITY=${value}`;
}

function log(tag, ...args) {
    if (!_logStream) return;
    const ts   = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] [${tag}] ${args.join(' ')}`;
    _logStream.write(line + '\n');
}

function logImportant(tag, ...args) {
    log(tag, ...args);
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] [${tag}]`, ...args);
}

function send(res, status, body, headers = {}) {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    res.writeHead(status, {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        ...headers,
    });
    res.end(buf);
}

function decompress(buffer, encoding) {
    if (!encoding) return buffer;
    const enc = encoding.toLowerCase().trim();
    if (enc === 'gzip')    return zlib.gunzipSync(buffer);
    if (enc === 'deflate') return zlib.inflateSync(buffer);
    if (enc === 'br')      return zlib.brotliDecompressSync(buffer);
    return buffer;
}

function fetchBuffer(urlStr, hops = 0) {
    return new Promise((resolve, reject) => {
        if (hops > 10) return reject(new Error('Too many redirects'));

        const parsed   = new URL(urlStr);
        const isRoblox = parsed.hostname.includes('roblox.com');
        const cookie   = isRoblox ? resolveCookie() : '';

        const options = {
            hostname: parsed.hostname,
            port:     parsed.port || 443,
            path:     parsed.pathname + parsed.search,
            method:   'GET',
            headers: {
                'User-Agent': 'Roblox/WinInet',
                'Accept':     '*/*',
                ...(cookie ? { Cookie: cookie } : {}),
            },
        };

        const req = https.request(options, (res) => {
            const { statusCode, headers } = res;

            if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
                res.resume();
                const next = headers.location.startsWith('http')
                    ? headers.location
                    : `https://${parsed.hostname}${headers.location}`;
                log('HTTP', `↳ Redirect (${statusCode}) → ${next}`);
                return fetchBuffer(next, hops + 1).then(resolve).catch(reject);
            }

            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let buf = Buffer.concat(chunks);
                try {
                    buf = decompress(buf, headers['content-encoding'] || '');
                } catch (err) {
                    return reject(new Error(`Decompression failed: ${err.message}`));
                }
                resolve({
                    statusCode,
                    contentType: headers['content-type'] || '',
                    buffer: buf,
                });
            });
            res.on('error', reject);
        });

        req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
        req.end();
    });
}

function bufferPreview(buf) {
    return buf.slice(0, 128).toString('utf8').replace(/[^\x20-\x7E]/g, '·');
}

function isImageBuffer(buf) {
    if (buf.length < 2) return false;

    if (buf[0] === 0x89 && buf[1] === 0x50) return true; 
    if (buf[0] === 0xFF && buf[1] === 0xD8) return true; 
    if (buf[0] === 0x42 && buf[1] === 0x4D) return true; 

    return false;
}

function sniffContentType(buf, declared) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
    if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
    return declared || 'application/octet-stream';
}

async function downscaleImage(buffer, assetId) {
    if (!sharp) return buffer;

    try {
        const meta = await sharp(buffer).metadata();
        const { width = 0, height = 0, format } = meta;

        if (width <= MAX_IMAGE_SIZE && height <= MAX_IMAGE_SIZE) {
            log('IMG', `Asset ${assetId}  ${width}×${height} — already within ${MAX_IMAGE_SIZE}px, skipping`);
            return buffer;
        }

        const out = await sharp(buffer)
            .resize(MAX_IMAGE_SIZE, MAX_IMAGE_SIZE, {
                fit:               'inside',
                kernel:            sharp.kernel.lanczos3,
                withoutEnlargement: true,
            })
            .png()
            .toBuffer();

        const outMeta = await sharp(out).metadata();
        log('IMG', `Asset ${assetId}  ${width}x${height} (${format}) → ${outMeta.width}x${outMeta.height} PNG  ${(buffer.length/1024).toFixed(0)}KB → ${(out.length/1024).toFixed(0)}KB`);
        return out;
    } catch (err) {
        logImportant('WARN', `Image downscale failed for ${assetId}: ${err.message} — sending original`);
        return buffer;
    }
}

async function fetchAsset(id, version) {
    let url = `https://assetdelivery.roblox.com/v1/asset/?id=${encodeURIComponent(id)}`;
    if (version) url += `&version=${encodeURIComponent(version)}`;
    return fetchBuffer(url);
}

function handleHttpError(res, statusCode, id) {
    if (statusCode === 401) {
        send(res, 401, 'Roblox 401 – check your COOKIE', { 'Content-Type': 'text/plain; charset=utf-8' });
        return true;
    }
    if (statusCode === 403) {
        send(res, 403, `Roblox 403 – no permission for asset ${id}`, { 'Content-Type': 'text/plain; charset=utf-8' });
        return true;
    }
    if (statusCode === 404) {
        send(res, 404, `Roblox 404 – asset ${id} not found`, { 'Content-Type': 'text/plain; charset=utf-8' });
        return true;
    }
    if (statusCode < 200 || statusCode >= 300) {
        send(res, 502, `Roblox returned HTTP ${statusCode}`, { 'Content-Type': 'text/plain; charset=utf-8' });
        return true;
    }
    return false;
}

function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
    loadUploaderEnv();
    openLogStream();

    const cookie = resolveCookie();
    if (!cookie) {
        console.warn(
            '[editable-mesh-bypasser] Warning: No ROBLOSECURITY credential found.\n' +
            '  Roblox API requests will likely fail with 401.\n' +
            '  Run "sof run uploader env" to configure credentials.\n'
        );
    }

    const shutdown = () => closeLogStream();
    process.once('exit', shutdown);

    const server = http.createServer(async (req, res) => {
        const url     = new URL(req.url, `http://${host}:${port}`);
        const id      = url.searchParams.get('id');
        const version = url.searchParams.get('version') || null;

        if (req.method === 'OPTIONS') { send(res, 204, ''); return; }

        if (!id) {
            send(res, 400, 'Missing required query param: id', { 'Content-Type': 'text/plain; charset=utf-8' });
            return;
        }

        log('REQ', `${url.pathname}  id=${id}${version ? '  ver=' + version : ''}`);

        if (url.pathname === '/asset') {
            let result;
            try {
                result = await fetchAsset(id, version);
            } catch (err) {
                logImportant('ERR', 'Fetch failed:', err.message);
                send(res, 502, `Fetch error: ${err.message}`, { 'Content-Type': 'text/plain; charset=utf-8' });
                return;
            }

            let { statusCode, contentType, buffer } = result;
            log('RES', `HTTP ${statusCode}  ${buffer.length}B  ${contentType || '(no content-type)'}`);

            if (handleHttpError(res, statusCode, id)) return;

            let finalContentType = sniffContentType(buffer, contentType);
            const isImg          = isImageBuffer(buffer);

            if (isImg) {
                buffer           = await downscaleImage(buffer, id);
                finalContentType = 'image/png';
            }

            const ext = CONTENT_TYPE_EXTENSIONS[finalContentType.split(';')[0].trim()] || '.bin';
            log('OK', `Asset ${id}  ${buffer.length}B  ${finalContentType}  (${ext})`);

            send(res, 200, buffer, {
                'Content-Type':   finalContentType,
                'Content-Length': String(buffer.length),
                'X-Asset-Id':     id,
                'X-Detected-Ext': ext,
                'X-Is-Image':     String(isImg),
            });
            return;
        }

        if (url.pathname === '/mesh') {
            let result;
            try {
                result = await fetchAsset(id, version);
            } catch (err) {
                logImportant('ERR', 'Fetch failed:', err.message);
                send(res, 502, `Fetch error: ${err.message}`, { 'Content-Type': 'text/plain; charset=utf-8' });
                return;
            }

            const { statusCode, contentType, buffer } = result;
            log('RES', `HTTP ${statusCode}  ${buffer.length}B  ${contentType || '(none)'}`);
            log('RES', `Buffer preview: "${bufferPreview(buffer)}"`);

            if (handleHttpError(res, statusCode, id)) return;

            let parsed;
            try {
                parsed = await parseMeshBuffer(buffer);
            } catch (err) {
                const msg = [
                    `parseMeshBuffer failed: ${err.message}`,
                    `Asset ${id}  HTTP ${statusCode}  Content-Type: ${contentType || '(none)'}`,
                    `Buffer size: ${buffer.length} bytes`,
                    `Buffer preview: "${bufferPreview(buffer)}"`,
                ].join('\n');
                logImportant('ERR', msg);
                send(res, 500, msg, { 'Content-Type': 'text/plain; charset=utf-8' });
                return;
            }

            const indent = url.searchParams.get('pretty') === '1' ? 2 : 0;
            const body   = JSON.stringify({ success: true, assetId: String(id), parsed }, null, indent);

            log('OK', `Mesh v${parsed.version}  ${parsed.vertexCount}v  ${parsed.faceCount}f  ${(body.length / 1024).toFixed(1)} KB`);

            send(res, 200, body, {
                'Content-Type':   'application/json; charset=utf-8',
                'X-Asset-Id':     id,
                'X-Mesh-Version': String(parsed.version),
            });
            return;
        }

        send(res, 404, `Unknown route: ${url.pathname}\nAvailable: /asset  /mesh`, {
            'Content-Type': 'text/plain; charset=utf-8',
        });
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(
                `[editable-mesh-bypasser] Port ${port} is already in use.\n` +
                `  Try a different port: sof run editable-mesh-bypasser --port ${port + 1}`
            );
            process.exit(1);
        }
        throw err;
    });

    server.listen(port, host, () => {
        console.log('');
        console.log('  Editable Mesh Bypasser is running at:');
        console.log('');
        console.log(`    http://${host}:${port}`);
        console.log('');
        console.log('  Endpoints:');
        console.log('    GET  /asset?id=<assetId>[&version=<v>]');
        console.log('    GET  /mesh?id=<assetId>[&version=<v>][&pretty=1]');
        console.log('');
        console.log(`  Logs:  ${LOG_PATH}`);
        console.log('  Press Ctrl+C to stop.');
        console.log('');

        if (!openInEditor(LOG_PATH)) {
            console.log('  (Could not auto-open log file — open it manually.)');
            console.log('');
        }
    });

    return server;
}

module.exports = { startServer, DEFAULT_PORT, DEFAULT_HOST, LOG_PATH };