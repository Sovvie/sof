"use strict";

// Builds dist/sof-<version>.zip, the asset the install scripts and `sof run self update`
// download from the GitHub release tagged v<version>.

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const root = path.resolve(__dirname, "..");
const { version } = require(path.join(root, "package.json"));
const dist = path.join(root, "dist");
const output = path.join(dist, `sof-${version}.zip`);

fs.mkdirSync(dist, { recursive: true });

const zip = new AdmZip();
zip.addLocalFolder(path.join(root, "bin"), "bin");
zip.addLocalFolder(path.join(root, "src"), "src");
zip.addLocalFile(path.join(root, "package.json"));
zip.addLocalFile(path.join(root, "package-lock.json"));
zip.writeZip(output);

console.log(`Built ${path.relative(root, output)}`);
console.log(`Next: create GitHub release v${version} and upload it, along with install.ps1 and install.sh.`);
