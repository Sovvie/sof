"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { PNG } = require("pngjs");

function resolveExecutable(name, installerPackage) {
  try {
    return require(installerPackage).path;
  } catch {
    throw new Error(
      `${name} is not available. Install it with:\n` +
        `  cd tools/sof && npm install ${installerPackage}`
    );
  }
}

function getFFmpeg() {
  return resolveExecutable("ffmpeg", "@ffmpeg-installer/ffmpeg");
}

function getFFprobe() {
  return resolveExecutable("ffprobe", "@ffprobe-installer/ffprobe");
}

function runSync(cmd, args) {
  const r      = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stderr = r.stderr?.toString().trim() || "(no stderr)";
  if (r.error)       throw new Error(`Could not launch "${cmd}": ${r.error.message}`);
  if (r.status !== 0) throw new Error(`"${cmd}" exited ${r.status}:\n${stderr}`);
  return r.stdout;
}

function parseFps(str) {
  if (!str) return 30;
  const [num, den] = str.split("/").map(Number);
  const fps = den ? num / den : num;
  return Math.round(fps * 100) / 100;
}

function probeVideo(filePath) {
  const FFPROBE = getFFprobe();
  const out = runSync(FFPROBE, [
    "-v",              "error",
    "-select_streams", "v:0",
    "-show_entries",   "stream=width,height,r_frame_rate",
    "-of",             "json",
    filePath,
  ]);
  const stream = JSON.parse(out.toString()).streams[0];
  if (!stream) throw new Error("No video stream found in: " + filePath);
  return {
    width:  parseInt(stream.width),
    height: parseInt(stream.height),
    fps:    parseFps(stream.r_frame_rate),
  };
}

function extractFrames(filePath) {
  const FFMPEG = getFFmpeg();
  const { fps } = probeVideo(filePath);
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "spritepack-"));

  try {
    runSync(FFMPEG, [
      "-i",        filePath,
      "-vsync",    "0",
      "-f",        "image2",
      path.join(tmpDir, "frame%06d.png"),
      "-hide_banner",
      "-loglevel", "error",
      "-y",
    ]);

    const pngFiles = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith(".png"))
      .sort()
      .map(f => path.join(tmpDir, f));

    if (pngFiles.length === 0)
      throw new Error("ffmpeg produced no frames. Is this a valid video file?");

    return pngFiles.map((fp, i) => {
      const raw = fs.readFileSync(fp);
      const png = PNG.sync.read(raw);
      return {
        index:  i,
        source: filePath,
        fps,
        width:  png.width,
        height: png.height,
        rgba:   new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
      };
    });

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { probeVideo, extractFrames };
