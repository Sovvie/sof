"use strict";

const builder = require("../builder");
const serializer = require("../utils/serializer");
const compressor = require("../utils/compressor");

const KTABLE_NAME = "K";

function isObject(value) {
  return value !== null && typeof value === "object";
}

function isStateAssignNumber(node) {
  if (!node || node.tag !== "assign") return false;
  const lhs = node.variables && node.variables[0] && node.variables[0].node;
  if (!lhs) return false;
  const tokenText = lhs.token && lhs.token.text;
  if ((lhs.tag !== "local" && lhs.tag !== "global") || tokenText !== "State") return false;
  const value = node.values && node.values[0] && node.values[0].node;
  return Boolean(value && value.tag === "number");
}

function getStringText(node) {
  if (node.text != null) return String(node.text);
  if (node.value != null) return String(node.value);
  return null;
}

function stripQuotes(text) {
  if (text.length >= 2) {
    const first = text.slice(0, 1);
    if ((first === "\"" || first === "'") && text.slice(-1) === first) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function constantKey(node) {
  if (!isObject(node) || !node.istoken) return null;
  if (node.tag === "string") {
    const text = getStringText(node);
    if (text == null) return null;
    return `s:${text}`;
  }
  if (node.tag === "number") {
    const value = node.value != null ? node.value : Number(node.text);
    return `n:${value}`;
  }
  return null;
}

function collectConstants(node, protectedNodes, out, seen, isIndex) {
  if (!isObject(node) || seen.has(node)) return;
  seen.add(node);

  if ((node.tag === "number" || node.tag === "string") && node.istoken) {
    if (!protectedNodes.has(node)) {
      if (node.tag === "string") {
        out.push(node);
      } else if (!isIndex) {
        out.push(node);
      }
    }
    return;
  }

  if (node.tag === "index" && node.kind === "expr") {
    collectConstants(node.expression, protectedNodes, out, seen, false);
    const expr = node.expression;
    const isOverflowIndex =
      expr &&
      (expr.tag === "local" || expr.tag === "global") &&
      expr.token &&
      (expr.token.text === "Overflow" || expr.token.text === KTABLE_NAME);
    collectConstants(node.index, protectedNodes, out, seen, isOverflowIndex);
    return;
  }

  for (const value of Object.values(node)) {
    if (isObject(value)) {
      collectConstants(value, protectedNodes, out, seen, false);
    }
  }
}

function replaceConstants(node, keyToIndex, seen) {
  if (!isObject(node) || seen.has(node)) return;
  seen.add(node);

  for (const [key, value] of Object.entries(node)) {
    if (isObject(value)) {
      const idx = keyToIndex.get(constantKey(value) || "");
      if (idx != null) {
        node[key] = builder.IndexExpr(builder.Local(KTABLE_NAME), builder.Number(idx));
      } else {
        replaceConstants(value, keyToIndex, seen);
      }
    }
  }
}

function toConstLiteral(node) {
  if (node.tag === "number") {
    const value = node.value != null ? node.value : Number(node.text);
    return builder.Number(value);
  }
  if (node.tag === "string") {
    const raw = getStringText(node) || "";
    return builder.String(stripQuotes(raw));
  }
  return builder.Nil();
}

function run(ctx) {
  const protectedNodes = new Set();
  for (const block of Object.values(ctx.EmitCtx.Blocks || {})) {
    for (const node of block.Body || []) {
      if (isStateAssignNumber(node)) {
        protectedNodes.add(node.values[0].node);
      }
    }
  }

  const collected = [];
  const seen = new Set();
  for (const block of Object.values(ctx.EmitCtx.Blocks || {})) {
    for (const node of block.Body || []) {
      collectConstants(node, protectedNodes, collected, seen, false);
    }
  }

  if (collected.length === 0) return;

  const unique = [];
  const keyToNode = new Map();
  for (const node of collected) {
    const key = constantKey(node);
    if (key && !keyToNode.has(key)) {
      keyToNode.set(key, node);
      unique.push(node);
    }
  }
  if (unique.length === 0) return;

  const keyToIndex = new Map();
  const writer = serializer.newWriter();
  const values = [];

  for (let i = 0; i < unique.length; i += 1) {
    const constNode = unique[i];
    const index = i + 1;
    keyToIndex.set(constantKey(constNode), index);
    values.push(toConstLiteral(constNode));

    if (constNode.tag === "number") {
      writer.writeNumber(constNode.value != null ? constNode.value : Number(constNode.text));
    } else if (constNode.tag === "string") {
      const raw = getStringText(constNode) || "";
      writer.writeString(stripQuotes(raw));
    }
  }

  const serialized = writer.export();
  ctx.EmitCtx.ConstantData = compressor.compress(serialized);

  const replaceSeen = new Set();
  for (const block of Object.values(ctx.EmitCtx.Blocks || {})) {
    for (const node of block.Body || []) {
      replaceConstants(node, keyToIndex, replaceSeen);
    }
  }

  ctx.EmitCtx.ConstantNode = builder.LocalDecl([KTABLE_NAME], [builder.Table(values)]);
}

module.exports = {
  Name: "Constant Table",
  Run: run,
};
