"use strict";

function indent(level) {
  return "  ".repeat(level);
}

function tokenText(token, fallback = "") {
  if (token == null) return fallback;
  if (typeof token === "string") return token;
  if (typeof token.text === "string") return token.text;
  return fallback;
}

function getLocalName(localNode) {
  if (!localNode) return "_";
  if (localNode.token && localNode.token.text) return localNode.token.text;
  if (localNode.name && localNode.name.text) return localNode.name.text;
  if (localNode.local && localNode.local.name && localNode.local.name.text) return localNode.local.name.text;
  return "_";
}

function quoteString(text, quotestyle = "double") {
  const value = String(text ?? "");
  if (quotestyle === "single") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function listFromPunctuated(items, mapper) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => mapper(item && (item.node || item)));
}

function maybeParens(expr) {
  if (!expr || typeof expr !== "object") return printExpression(expr, 0);
  const text = printExpression(expr, 0);
  if (expr.tag === "binary" || expr.tag === "logical") {
    return `(${text})`;
  }
  return text;
}

function printExpression(node, level) {
  if (!node) return "nil";

  switch (node.tag) {
    case "number":
      return typeof node.text === "string" ? node.text : String(node.value);
    case "string":
      return quoteString(node.text, node.quotestyle);
    case "boolean":
      return node.value ? "true" : "false";
    case "nil":
      return "nil";
    case "local":
      return getLocalName(node);
    case "global":
      return tokenText(node.name, "_G");
    case "group":
      return `(${printExpression(node.expression, level)})`;
    case "index":
      return `${printExpression(node.expression, level)}[${printExpression(node.index, level)}]`;
    case "indexname":
      return `${printExpression(node.expression, level)}.${tokenText(node.index, "_")}`;
    case "call": {
      const args = listFromPunctuated(node.arguments, (arg) => printExpression(arg, level)).join(", ");
      const funcNode = node.func;
      const callee = funcNode && funcNode.tag === "function"
        ? `(${printExpression(funcNode, level)})`
        : printExpression(funcNode, level);
      return `${callee}(${args})`;
    }
    case "binary":
      return `${maybeParens(node.lhsoperand)} ${tokenText(node.operator, "==")} ${maybeParens(node.rhsoperand)}`;
    case "unary": {
      const op = tokenText(node.operator, "not");
      if (op === "not") {
        return `not ${maybeParens(node.operand)}`;
      }
      return `${op}${maybeParens(node.operand)}`;
    }
    case "function": {
      const params = [];
      if (Array.isArray(node.parameters)) {
        for (const paramWrap of node.parameters) {
          const param = paramWrap && (paramWrap.node || paramWrap);
          if (param && param.tag === "vararg") {
            params.push("...");
          } else {
            params.push(getLocalName(param));
          }
        }
      }
      if (node.vararg) {
        params.push("...");
      }
      const body = printBlock(node.body, level + 1, false);
      return `function(${params.join(", ")})\n${body}\n${indent(level)}end`;
    }
    case "table": {
      const entries = [];
      for (const entry of node.entries || []) {
        if (entry.kind === "record") {
          entries.push(`${tokenText(entry.key, "_")} = ${printExpression(entry.value, level)}`);
        } else if (entry.kind === "general") {
          entries.push(`[${printExpression(entry.key, level)}] = ${printExpression(entry.value, level)}`);
        } else {
          entries.push(printExpression(entry.value, level));
        }
      }
      return `{${entries.join(", ")}}`;
    }
    case "vararg":
      return "...";
    default:
      return "nil";
  }
}

function printElseIf(elseifNode, level) {
  const cond = printExpression(elseifNode.condition, level);
  const body = printBlock(elseifNode.thenblock, level + 1, false);
  return `${indent(level)}elseif ${cond} then\n${body}`;
}

function printStatement(node, level) {
  const pad = indent(level);
  if (!node) return `${pad}--[[nil-statement]]`;

  switch (node.tag) {
    case "expression":
      return `${pad}${printExpression(node.expression, level)}`;
    case "assign": {
      const vars = listFromPunctuated(node.variables, (v) => printExpression(v, level)).join(", ");
      const vals = listFromPunctuated(node.values, (v) => printExpression(v, level)).join(", ");
      return `${pad}${vars} = ${vals}`;
    }
    case "local": {
      const vars = listFromPunctuated(node.variables, (v) => getLocalName(v)).join(", ");
      if (node.values && node.values.length > 0) {
        const vals = listFromPunctuated(node.values, (v) => printExpression(v, level)).join(", ");
        return `${pad}local ${vars} = ${vals}`;
      }
      return `${pad}local ${vars}`;
    }
    case "localfunction": {
      const name = getLocalName(node.name);
      const func = node.func || node.value;
      const asExpr = printExpression(func, level);
      return `${pad}local function ${name}${asExpr.replace(/^function/, "")}`;
    }
    case "conditional": {
      const cond = printExpression(node.condition, level);
      const thenBody = printBlock(node.thenblock, level + 1, false);
      const parts = [`${pad}if ${cond} then`, thenBody];

      for (const elseifNode of node.elseifs || []) {
        parts.push(printElseIf(elseifNode, level));
      }
      if (node.elseblock && Array.isArray(node.elseblock.statements) && node.elseblock.statements.length > 0) {
        parts.push(`${pad}else`);
        parts.push(printBlock(node.elseblock, level + 1, false));
      }
      parts.push(`${pad}end`);
      return parts.join("\n");
    }
    case "while": {
      const condition = printExpression(node.condition, level);
      const body = printBlock(node.body, level + 1, false);
      return `${pad}while ${condition} do\n${body}\n${pad}end`;
    }
    case "for": {
      const name = getLocalName(node.variable);
      const from = printExpression(node.from, level);
      const to = printExpression(node.to, level);
      const step = node.step ? `, ${printExpression(node.step, level)}` : "";
      const body = printBlock(node.body, level + 1, false);
      return `${pad}for ${name} = ${from}, ${to}${step} do\n${body}\n${pad}end`;
    }
    case "forin": {
      const vars = listFromPunctuated(node.variables, (v) => getLocalName(v)).join(", ");
      const vals = listFromPunctuated(node.values, (v) => printExpression(v, level)).join(", ");
      const body = printBlock(node.body, level + 1, false);
      return `${pad}for ${vars} in ${vals} do\n${body}\n${pad}end`;
    }
    case "repeat": {
      const body = printBlock(node.body, level + 1, false);
      const cond = printExpression(node.condition, level);
      return `${pad}repeat\n${body}\n${pad}until ${cond}`;
    }
    case "do": {
      const body = printBlock(node.body, level + 1, false);
      return `${pad}do\n${body}\n${pad}end`;
    }
    case "return": {
      const values = listFromPunctuated(node.expressions, (expr) => printExpression(expr, level));
      if (values.length === 0) return `${pad}return`;
      return `${pad}return ${values.join(", ")}`;
    }
    case "break":
      return `${pad}break`;
    case "continue":
      return `${pad}continue`;
    case "block":
      return printBlock(node, level, false);
    default:
      return `${pad}--[[unhandled:${node.tag || "unknown"}]]`;
  }
}

function printBlock(block, level = 0, isRoot = true) {
  const statements = (block && block.statements) || [];
  const lines = statements.map((statement) => printStatement(statement, level));
  if (lines.length === 0) {
    return isRoot ? "" : `${indent(level)}--[[empty]]`;
  }
  return lines.join("\n");
}

function print(astRoot) {
  return `${printBlock(astRoot, 0, true)}\n`;
}

module.exports = {
  print,
};
