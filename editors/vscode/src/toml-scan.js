"use strict";

// A tolerant TOML scanner. It is not a validator: it exists to find every `key = value` pair
// with exact character offsets, and it must keep working while the file is half-typed (an
// unclosed quote, a dangling `[[dependencies`), which a real TOML parser refuses to do.
//
// What it reports:
//   tables  every [header] / [[header]] with its dotted path
//   entries every key = value, with the full table path, key span and (for strings) value spans
//
// Strings are never unescaped: a dependency specifier has no use for escapes, and keeping the
// raw text keeps every offset exact.

/**
 * @typedef {{ start: number, end: number }} Span  Offsets into the text; `end` is exclusive.
 *
 * @typedef {Object} StringValue
 * @property {"string"} kind
 * @property {string} raw          Text between the quotes, exactly as written.
 * @property {Span} span           Including the quotes.
 * @property {Span} innerSpan      Excluding the quotes.
 * @property {boolean} terminated  False for a string that runs into the end of its line.
 * @property {boolean} multiline
 *
 * @typedef {Object} OtherValue
 * @property {"other"} kind        Number, boolean, date, array or inline table.
 * @property {Span} span
 *
 * @typedef {Object} Entry
 * @property {string[]} path       Table path + dotted key, e.g. ["dependencies", "Router"].
 * @property {string} key          Last segment of the key.
 * @property {Span} keySpan        Last segment of the key, including quotes if quoted.
 * @property {number} container    Id of the table or inline table that holds the key (0 = root).
 * @property {StringValue | OtherValue} value
 *
 * @typedef {Object} Table
 * @property {string[]} path
 * @property {boolean} isArray     [[double brackets]]
 * @property {boolean} closed      False while the closing bracket is missing.
 * @property {Span} span
 * @property {number} container
 *
 * @typedef {{ entries: Entry[], tables: Table[] }} ScanResult
 */

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
// A line that can only be a table header or a new `key =` line. Used to stop an unterminated
// array from swallowing the rest of the file while the user is still typing it.
const HEADER_LINE = /^\[\[?[A-Za-z0-9_.\- ]+\]?\]?[ \t]*(#.*)?$/;
const ASSIGNMENT_LINE = /^[A-Za-z_][A-Za-z0-9_.-]*[ \t]*=/;

/**
 * @param {string} text
 * @returns {ScanResult}
 */
function scan(text) {
  const n = text.length;
  let i = 0;
  let nextContainer = 1;
  /** @type {Entry[]} */
  const entries = [];
  /** @type {Table[]} */
  const tables = [];
  /** @type {string[]} */
  let tablePath = [];
  let currentContainer = 0;

  const isEol = (c) => c === "\n" || c === "\r";

  function skipInlineSpace() {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
  }

  function skipToEol() {
    while (i < n && !isEol(text[i])) i++;
  }

  // Whitespace, line breaks and comments.
  function skipBlank() {
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
      } else if (c === "#") {
        skipToEol();
      } else {
        break;
      }
    }
  }

  function atLineStart() {
    let j = i - 1;
    while (j >= 0 && (text[j] === " " || text[j] === "\t")) j--;
    return j < 0 || isEol(text[j]);
  }

  function restOfLine() {
    let j = i;
    while (j < n && !isEol(text[j])) j++;
    return text.slice(i, j);
  }

  // Reads a quoted string starting at text[i], which must be " or '.
  function readString() {
    const quote = text[i];
    const start = i;

    if (text.startsWith(quote.repeat(3), i)) {
      const innerStart = i + 3;
      let j = innerStart;
      while (j < n) {
        if (quote === '"' && text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote && text[j + 1] === quote && text[j + 2] === quote) {
          // Up to two quotes may sit right before the closing delimiter as content.
          let extra = 0;
          while (text[j + 3] === quote && extra < 2) {
            j++;
            extra++;
          }
          i = j + 3;
          return {
            start,
            innerStart,
            innerEnd: j,
            end: j + 3,
            terminated: true,
            multiline: true,
          };
        }
        j++;
      }
      i = n;
      return { start, innerStart, innerEnd: n, end: n, terminated: false, multiline: true };
    }

    const innerStart = i + 1;
    let j = innerStart;
    while (j < n && !isEol(text[j])) {
      if (quote === '"' && text[j] === "\\" && j + 1 < n && !isEol(text[j + 1])) {
        j += 2;
        continue;
      }
      if (text[j] === quote) {
        break;
      }
      j++;
    }
    const terminated = j < n && text[j] === quote;
    const innerEnd = Math.min(j, n);
    i = terminated ? j + 1 : innerEnd;
    return { start, innerStart, innerEnd, end: i, terminated, multiline: false };
  }

  // A dotted key (a.b."c d"); null when no key starts here.
  function parseKey() {
    /** @type {{ text: string, start: number, end: number }[]} */
    const segments = [];
    for (;;) {
      skipInlineSpace();
      const c = text[i];
      if (c === '"' || c === "'") {
        const s = readString();
        segments.push({ text: text.slice(s.innerStart, s.innerEnd), start: s.start, end: s.end });
      } else {
        const start = i;
        while (i < n && BARE_KEY_CHAR.test(text[i])) i++;
        if (i === start) {
          return segments.length > 0 ? segments : null;
        }
        segments.push({ text: text.slice(start, i), start, end: i });
      }
      skipInlineSpace();
      if (text[i] === ".") {
        i++;
        continue;
      }
      return segments;
    }
  }

  function parseHeader() {
    const start = i;
    const isArray = text[i + 1] === "[";
    i += isArray ? 2 : 1;
    const segments = parseKey() || [];
    skipInlineSpace();

    let closed = false;
    if (text[i] === "]") {
      if (!isArray) {
        i++;
        closed = true;
      } else if (text[i + 1] === "]") {
        i += 2;
        closed = true;
      }
    }
    if (!closed) {
      skipToEol();
    }

    const path = segments.map((segment) => segment.text);
    currentContainer = nextContainer++;
    // An unreadable header still ends the previous table, so the lines under it are never
    // attributed to the wrong one.
    tablePath = segments.length > 0 ? path : ["?"];
    tables.push({ path, isArray, closed, span: { start, end: i }, container: currentContainer });
  }

  /**
   * @param {string[]} path
   * @param {{ text: string, start: number, end: number }} keySegment
   * @param {number} container
   * @param {"line" | "inline" | "array"} context
   */
  function parseValue(path, keySegment, container, context) {
    const c = text[i];
    const keySpan = { start: keySegment.start, end: keySegment.end };

    if (c === '"' || c === "'") {
      const s = readString();
      entries.push({
        path,
        key: keySegment.text,
        keySpan,
        container,
        value: {
          kind: "string",
          raw: text.slice(s.innerStart, s.innerEnd),
          span: { start: s.start, end: s.end },
          innerSpan: { start: s.innerStart, end: s.innerEnd },
          terminated: s.terminated,
          multiline: s.multiline,
        },
      });
      return;
    }

    const valueStart = i;
    if (c === "[") {
      parseArray(path);
    } else if (c === "{") {
      parseInlineTable(path);
    } else {
      parseBare(context);
    }
    entries.push({
      path,
      key: keySegment.text,
      keySpan,
      container,
      value: { kind: "other", span: { start: valueStart, end: i } },
    });
  }

  function parseBare(context) {
    while (i < n) {
      const c = text[i];
      if (isEol(c) || c === "#") break;
      if (context !== "line" && (c === "," || c === "}" || c === "]")) break;
      i++;
    }
  }

  // Array elements that are inline tables keep the array's own path, as in TOML's
  // array-of-tables meaning.
  function parseArray(path) {
    i++; // [
    for (;;) {
      const before = i;
      skipBlank();
      if (i >= n) return;
      const c = text[i];

      if (c === "]") {
        i++;
        return;
      }
      if (c === ",") {
        i++;
        continue;
      }
      if (atLineStart()) {
        const line = restOfLine();
        if (HEADER_LINE.test(line) || ASSIGNMENT_LINE.test(line)) {
          return; // the array was never closed
        }
      }

      if (c === "{") {
        parseInlineTable(path);
      } else if (c === "[") {
        parseArray(path);
      } else if (c === '"' || c === "'") {
        readString();
      } else {
        parseBare("array");
      }
      if (i === before) i++;
    }
  }

  function parseInlineTable(path) {
    i++; // {
    const container = nextContainer++;
    for (;;) {
      const before = i;
      skipBlank();
      if (i >= n) return;
      const c = text[i];

      if (c === "}") {
        i++;
        return;
      }
      if (c === ",") {
        i++;
        continue;
      }
      if (atLineStart() && HEADER_LINE.test(restOfLine())) {
        return; // never closed
      }

      const segments = parseKey();
      if (!segments) {
        i++;
        continue;
      }
      skipInlineSpace();
      if (text[i] !== "=") {
        while (i < n && !isEol(text[i]) && text[i] !== "," && text[i] !== "}") i++;
        continue;
      }
      i++;
      skipInlineSpace();
      const keyPath = path.concat(segments.map((segment) => segment.text));
      parseValue(keyPath, segments[segments.length - 1], container, "inline");
      if (i === before) i++;
    }
  }

  for (;;) {
    const before = i;
    skipBlank();
    if (i >= n) break;

    if (text[i] === "[") {
      parseHeader();
      continue;
    }

    const segments = parseKey();
    if (!segments) {
      skipToEol();
      if (i === before) i++;
      continue;
    }
    skipInlineSpace();
    if (text[i] !== "=") {
      skipToEol();
      continue;
    }
    i++;
    skipInlineSpace();
    const keyPath = tablePath.concat(segments.map((segment) => segment.text));
    parseValue(keyPath, segments[segments.length - 1], currentContainer, "line");
  }

  return { entries, tables };
}

/**
 * Offsets <-> line/column for plain strings (documents bring their own).
 * @param {string} text
 */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    } else if (text[i] === "\r" && text[i + 1] !== "\n") {
      starts.push(i + 1);
    }
  }

  return {
    positionAt(offset) {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid] <= offset) low = mid;
        else high = mid - 1;
      }
      return { line: low, character: offset - starts[low] };
    },
    lineStart(line) {
      return starts[line];
    },
    get lineCount() {
      return starts.length;
    },
  };
}

module.exports = { scan, lineIndex };
