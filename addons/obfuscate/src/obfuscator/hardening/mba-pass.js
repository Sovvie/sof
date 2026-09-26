"use strict";

const builder = require("../builder");
const bit32 = require("../utils/bit32");
const { randInt } = require("../utils/random");

function isObject(value) {
  return value !== null && typeof value === "object";
}

function isStateAssign(node) {
  if (!node || node.tag !== "assign" || !Array.isArray(node.variables)) return false;
  const lhs = node.variables[0] && node.variables[0].node;
  if (!lhs) return false;
  const name =
    (lhs.token && lhs.token.text) ||
    (lhs.name && lhs.name.text) ||
    (lhs.local && lhs.local.name && lhs.local.name.text);
  return (lhs.tag === "local" || lhs.tag === "global") && name === "State";
}

function makeMbaForConstant(value) {
  const key = randInt(1, 0xfffe);
  const encoded = bit32.bxor(value, key);
  return builder.Group(
    builder.Call(
      builder.IndexExpr(builder.Local("bit32"), builder.String("bxor")),
      [builder.Number(encoded), builder.Number(key, true)]
    )
  );
}

function walkAndMba(node, protectedNodes, seen) {
  if (!isObject(node) || seen.has(node)) return;
  seen.add(node);

  for (const [key, value] of Object.entries(node)) {
    if (!isObject(value) || seen.has(value)) continue;

    if (
      value.tag === "number" &&
      value.istoken &&
      !protectedNodes.has(value) &&
      typeof value.value === "number" &&
      Number.isInteger(value.value) &&
      value.value >= 0 &&
      value.value <= 0xffffff &&
      Math.random() < 0.1
    ) {
      node[key] = makeMbaForConstant(value.value);
    } else {
      walkAndMba(value, protectedNodes, seen);
    }
  }
}

function run(ctx) {
  const protectedNodes = new Set();
  for (const block of Object.values(ctx.EmitCtx.Blocks || {})) {
    for (const node of block.Body || []) {
      if (isStateAssign(node) && node.values && node.values[0] && node.values[0].node) {
        const value = node.values[0].node;
        if (value.tag === "number") {
          protectedNodes.add(value);
        }
      }
    }
  }

  const seen = new Set();
  for (const block of Object.values(ctx.EmitCtx.Blocks || {})) {
    for (const node of block.Body || []) {
      walkAndMba(node, protectedNodes, seen);
    }
  }
}

module.exports = {
  Name: "MBA Pass",
  Run: run,
};
