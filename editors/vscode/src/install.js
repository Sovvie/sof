"use strict";

// The command "Run install" sends to a terminal for a sof file.

// Letters, digits, "_", "." and "-": nothing a shell would treat specially.
const SAFE_FILE_NAME = /^[\w.-]+$/;

/**
 * "sof run package install" for sof.toml, with the file name added for any other name
 * (.sof.toml, packages.sof.toml). Null when the name has characters that must not be pasted
 * into a shell.
 * @param {string} fileName
 * @returns {string | null}
 */
function installCommandFor(fileName) {
  if (!SAFE_FILE_NAME.test(fileName)) {
    return null;
  }
  return fileName === "sof.toml" ? "sof run package install" : `sof run package install ${fileName}`;
}

module.exports = { installCommandFor };
