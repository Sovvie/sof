"use strict";

const { CATEGORIES, cacheInfo, cacheRoot, clearCache } = require("../cache");
const { bytes } = require("../addons/kit");

const HELP_TEXT = `
sof run cache - What sof keeps so installs work offline

USAGE:
  sof run cache info               Where the cache is and how big each part is
  sof run cache path               Print the cache folder
  sof run cache clear [part...]    Delete the cache, or only some parts: ${CATEGORIES.join(", ")}

Installs fill it as they go: package index answers and archives, and tool downloads. With
--offline (or SOF_OFFLINE=1) an install uses only what is installed or cached, and says what is
missing. Cached archives are checked against their sha256 each time they are read.
`;

async function runCache(argv) {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(HELP_TEXT);
    process.exit(command ? 0 : 1);
  }

  if (command === "path") {
    console.log(cacheRoot());
  } else if (command === "info") {
    const info = cacheInfo();
    console.log(`Cache: ${cacheRoot()}`);
    let total = 0;
    for (const category of CATEGORIES) {
      total += info[category].bytes;
      console.log(`  ${category.padEnd(9)} ${String(info[category].files).padStart(5)} file(s)  ${bytes(info[category].bytes)}`);
    }
    console.log(`  total     ${bytes(total).padStart(18)}`);
  } else if (command === "clear") {
    const removed = clearCache(rest.length > 0 ? rest : CATEGORIES);
    const total = Object.values(removed).reduce((sum, entry) => sum + entry.bytes, 0);
    console.log(`Cleared ${Object.keys(removed).join(", ")} (${bytes(total)}).`);
  } else {
    throw new Error(`Unknown cache command: ${command}`);
  }
}

module.exports = { runCache };
