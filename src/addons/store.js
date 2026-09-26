"use strict";

// Where add-ons live on this machine and the manifest that lists them.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ADDON_SCOPE = "sofaddon";

function sofHome() {
  return process.env.SOF_HOME ? path.resolve(process.env.SOF_HOME) : path.join(os.homedir(), ".sof");
}

function addonsRoot() {
  return path.join(sofHome(), "addons");
}

function manifestPath() {
  return path.join(sofHome(), "addons.json");
}

function readManifest() {
  const filePath = manifestPath();
  if (!fs.existsSync(filePath)) {
    return { addons: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed.addons === "object" ? parsed : { addons: {} };
  } catch (err) {
    throw new Error(`Add-on manifest is not valid JSON (${filePath}): ${err.message}`);
  }
}

function writeManifest(manifest) {
  fs.mkdirSync(sofHome(), { recursive: true });
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

// sof-addon.json: { name, version, command, entry, export?, description?, usage? }
function readAddonDescriptor(directory) {
  const filePath = path.join(directory, "sof-addon.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Not an add-on: ${directory} has no sof-addon.json.`);
  }

  const descriptor = JSON.parse(fs.readFileSync(filePath, "utf8"));
  for (const field of ["name", "version", "command", "entry"]) {
    if (typeof descriptor[field] !== "string" || descriptor[field].trim() === "") {
      throw new Error(`${filePath}: "${field}" is required.`);
    }
  }

  return descriptor;
}

function findAddonForCommand(command) {
  const manifest = readManifest();
  for (const addon of Object.values(manifest.addons)) {
    if (addon.command === command) {
      return addon;
    }
  }
  return null;
}

module.exports = {
  ADDON_SCOPE,
  sofHome,
  addonsRoot,
  readManifest,
  writeManifest,
  readAddonDescriptor,
  findAddonForCommand,
};
