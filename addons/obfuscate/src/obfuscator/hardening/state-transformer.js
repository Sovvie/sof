"use strict";

const builder = require("../builder");
const { randInt } = require("../utils/random");

function isObject(value) {
  return value !== null && typeof value === "object";
}

function isStateLocal(node) {
  if (!node) return false;
  const name =
    (node.token && node.token.text) ||
    (node.name && node.name.text) ||
    (node.local && node.local.name && node.local.name.text);
  return (node.tag === "local" || node.tag === "global") && name === "State";
}

function isStateAssign(node) {
  if (!node || node.tag !== "assign" || !Array.isArray(node.variables)) return false;
  if (node.variables.length !== 1) return false;
  const target = node.variables[0] && node.variables[0].node;
  if (!isStateLocal(target)) return false;
  const value = node.values && node.values[0] && node.values[0].node;
  return Boolean(value && value.tag === "number" && typeof value.value === "number");
}

function encodeNumber(value, offset, multiplier) {
  return value * multiplier + offset;
}

function patchNode(node, offset, multiplier, seen) {
  if (!isObject(node) || seen.has(node)) return;
  seen.add(node);

  if (isStateAssign(node)) {
    const entry = node.values[0];
    const oldValue = entry.node.value;
    entry.node = builder.Number(encodeNumber(oldValue, offset, multiplier));
  }

  if (
    node.tag === "binary" &&
    node.operator &&
    ["==", "~=", "<", ">", "<=", ">="].includes(node.operator.text)
  ) {
    const lhs = node.lhsoperand;
    const rhs = node.rhsoperand;
    if (isStateLocal(lhs) && rhs && rhs.tag === "number" && typeof rhs.value === "number") {
      node.rhsoperand = builder.Number(encodeNumber(rhs.value, offset, multiplier));
    }
  }

  for (const value of Object.values(node)) {
    if (isObject(value)) {
      patchNode(value, offset, multiplier, seen);
    }
  }
}

function run(ctx) {
  const offset = randInt(1000, 9999);
  const multiplier = randInt(2, 5);
  const seen = new Set();

  for (const block of Object.values(ctx.EmitCtx.Blocks || {})) {
    for (const node of block.Body || []) {
      patchNode(node, offset, multiplier, seen);
    }
  }

  if (typeof ctx.EmitCtx.FirstStateId === "number") {
    ctx.EmitCtx.FirstStateId = encodeNumber(ctx.EmitCtx.FirstStateId, offset, multiplier);
  }

  ctx.EmitCtx.TransformStats = ctx.EmitCtx.TransformStats || {};
  ctx.EmitCtx.TransformStats._stateDecode = builder.LocalDecl(
    ["_stateDecode"],
    [{
      kind: "expr",
      tag: "function",
      functionkeyword: builder.Token("function"),
      openparens: builder.Token("("),
      parameters: [{ node: { kind: "local", name: builder.Token("s") } }],
      closeparens: builder.Token(")"),
      body: {
        kind: "stat",
        tag: "block",
        statements: [{
          kind: "stat",
          tag: "return",
          returnkeyword: builder.TrailingSpacedToken("return"),
          expressions: [{
            node: builder.Binary(
              builder.Binary(builder.Local("s"), "-", builder.Number(offset)),
              "/",
              builder.Number(multiplier)
            ),
          }],
        }],
      },
      endkeyword: builder.Token("end"),
      attributes: [],
    }]
  );
}

module.exports = {
  Name: "State Transformer",
  Run: run,
};
