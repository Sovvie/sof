"use strict";

// Text that came out of a file in a repository (a key in sof.toml, a TOML parse error that quotes the
// offending line) may hold terminal control sequences: clear the screen, move the cursor, write to
// the clipboard (OSC 52). Anything printed from such text goes through here, which shows control,
// zero-width, bidirectional and line-separator characters as \u{...} instead. Newline and tab stay.

const UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function safeText(value) {
  return String(value).replace(UNSAFE_CHARACTER, (character) =>
    character === "\n" || character === "\t" ? character : `\\u{${character.codePointAt(0).toString(16)}}`
  );
}

module.exports = { safeText };
