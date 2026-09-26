"use strict";

const builder = require("../builder");

function fetchConditionals(root) {
  const visited = new Set();
  const conditionals = [];

  function walk(node) {
    if (!node || typeof node !== "object" || visited.has(node)) return node;
    visited.add(node);

    if (node.tag === "conditional") {
      conditionals.push(node);
    }

    for (const [key, child] of Object.entries(node)) {
      if (child && typeof child === "object") {
        node[key] = walk(child);
      }
    }
    return node;
  }

  walk(root);
  return conditionals;
}

function operatorText(node) {
  return (node && node.operator && node.operator.text) || node.operator || "";
}

function handleEmptyIfBranches(conditionals) {
  for (const conditional of conditionals) {
    const thenStatements = conditional.thenblock && conditional.thenblock.statements;
    if (Array.isArray(thenStatements) && thenStatements.length === 0) {
      conditional.condition = builder.Unary("not", conditional.condition);
      conditional.thenblock = conditional.elseblock;
      conditional.elseblock = null;
      conditional.elsekeyword = null;
    }
  }
}

function handleEmptyElseBranches(conditionals) {
  for (const conditional of conditionals) {
    const elseStatements = conditional.elseblock && conditional.elseblock.statements;
    if (Array.isArray(elseStatements) && elseStatements.length === 0) {
      conditional.elsekeyword = null;
      conditional.elseblock = null;
    }
  }
}

function handleNestedConditionals(conditionals) {
  for (const conditional of conditionals) {
    const statements = conditional.thenblock && conditional.thenblock.statements;
    if (!Array.isArray(statements) || statements.length !== 1) continue;

    const nested = statements[0];
    if (!nested || nested.tag !== "conditional") continue;

    const innerStatements = nested.thenblock && nested.thenblock.statements;
    if (!Array.isArray(innerStatements) || innerStatements.length !== 1) continue;
    if (innerStatements[0].tag !== "break") continue;

    const outerCond = conditional.condition;
    if (outerCond && outerCond.tag === "binary") {
      const op = operatorText(outerCond);
      if (op === "and" || op === "or") continue;
    }

    const innerCond = nested.condition;
    if (innerCond && innerCond.tag === "binary") {
      const op = operatorText(innerCond);
      if (op === "and" || op === "or") continue;
    }

    conditional.condition = builder.Logical(conditional.condition, "and", nested.condition);
    conditional.thenblock = nested.thenblock;
    conditional.elseblock = nested.elseblock;
    conditional.elsekeyword = nested.elsekeyword;
  }
}

function run(tree) {
  const conditionals = fetchConditionals(tree);
  handleEmptyElseBranches(conditionals);
  handleEmptyIfBranches(conditionals);
  handleNestedConditionals(conditionals);
}

module.exports = {
  Run: run,
  _HandleEmptyIfBranches: handleEmptyIfBranches,
  _HandleEmptyElseBranches: handleEmptyElseBranches,
  _HandleNestedConditionals: handleNestedConditionals,
};
