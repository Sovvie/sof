"use strict";

const luats = require("luats");
const luaparse = require("luaparse");
const builder = require("./builder");

class ScopeStack {
  constructor() {
    this.scopes = [new Set()];
  }

  push() {
    this.scopes.push(new Set());
  }

  pop() {
    this.scopes.pop();
  }

  declare(name) {
    this.scopes[this.scopes.length - 1].add(name);
  }

  has(name) {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      if (this.scopes[i].has(name)) return true;
    }
    return false;
  }
}

function typeBalanceDelta(text) {
  let delta = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") {
      delta += 1;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      delta -= 1;
    }
  }
  return delta;
}

function stripTypeAliasBlocks(source) {
  const lines = String(source || "").split(/\r?\n/);
  const kept = [];
  let skipping = false;
  let balance = 0;
  let continuation = false;

  for (const line of lines) {
    if (!skipping) {
      const match = line.match(
        /^\s*(?:export\s+)?type\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\n]+>)?\s*=/
      );
      if (!match) {
        kept.push(line);
        continue;
      }

      const equalsIndex = line.indexOf("=");
      const rhs = equalsIndex >= 0 ? line.slice(equalsIndex + 1) : "";
      const rhsTrim = rhs.trim();

      skipping = true;
      balance = typeBalanceDelta(rhs);
      continuation = rhsTrim === "" || /[|&]$/.test(rhsTrim);

      if (!continuation && balance <= 0) {
        skipping = false;
      }
      continue;
    }

    balance += typeBalanceDelta(line);
    const trimmed = line.trim();
    if (continuation) {
      continuation = trimmed === "" || /[|&]$/.test(trimmed);
    }
    if (!continuation && balance <= 0) {
      skipping = false;
    }
  }

  return kept.join("\n");
}

function stripTypeAnnotationsInHead(head) {
  let out = "";
  let i = 0;
  while (i < head.length) {
    const ch = head[i];
    if (ch !== ":") {
      out += ch;
      i += 1;
      continue;
    }

    i += 1;
    let depth = 0;
    while (i < head.length) {
      const c = head[i];
      if (c === "{" || c === "(" || c === "[") {
        depth += 1;
      } else if (c === "}" || c === ")" || c === "]") {
        depth = Math.max(0, depth - 1);
      }

      if (depth === 0 && c === ",") {
        break;
      }
      i += 1;
    }
  }

  return out
    .replace(/\s+,/g, ",")
    .replace(/,\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripInlineTypeAnnotations(source) {
  const lines = String(source || "").split(/\r?\n/);

  const stripped = lines.map((line) => {
    const localMatch = line.match(/^(\s*local\s+)([^=\n]*)(.*)$/);
    if (localMatch) {
      const [, prefix, head, tail] = localMatch;
      if (/^\s*function\b/.test(head)) {
        return line;
      }
      return `${prefix}${stripTypeAnnotationsInHead(head)}${tail}`;
    }

    const forNumeric = line.match(/^(\s*for\s+)([^=\n]+)(=\s*.*)$/);
    if (forNumeric) {
      const [, prefix, head, tail] = forNumeric;
      return `${prefix}${stripTypeAnnotationsInHead(head)}${tail}`;
    }

    const forGeneric = line.match(/^(\s*for\s+)(.+?)(\s+in\s+.*)$/);
    if (forGeneric) {
      const [, prefix, head, tail] = forGeneric;
      return `${prefix}${stripTypeAnnotationsInHead(head)}${tail}`;
    }

    return line;
  });

  return stripped.join("\n");
}

function rewriteCompoundAssignments(source) {
  return String(source || "").replace(
    /^(\s*)([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\n]+\]|\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(\+|-|\*|\/|%|\^|\.{2})=\s*(.+)$/gm,
    (_m, indent, target, op, rhs) => `${indent}${target} = ${target} ${op} (${rhs})`
  );
}

function stripSimpleLuauSyntax(source) {
  let out = String(source || "");

  // Drop Luau-only type aliases (including multiline table/function types).
  out = stripTypeAliasBlocks(out);

  // Remove casts: expr :: Type
  out = out.replace(/::\s*[A-Za-z_][A-Za-z0-9_<>\[\].,|&?\s()]*/g, "");

  // Remove generic parameter lists in function declarations: function foo<T>(...)
  out = out.replace(/(\bfunction\b[^(<\n]*)<[^>\n]+>(\s*\()/g, "$1$2");

  // Strip inline local / for annotations.
  out = stripInlineTypeAnnotations(out);

  // Rewrite Luau compound assignments into Lua-compatible assignments.
  out = rewriteCompoundAssignments(out);

  // Strip function parameter annotations in declarations.
  out = out.replace(/(\bfunction\b[^(]*\()([^)]*)(\))/g, (_m, head, params, tail) => {
    const strippedParams = params
      .replace(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[^,)\n]+/g, "$1")
      .replace(/\.\.\.\s*:\s*[^,)\n]+/g, "...");
    return `${head}${strippedParams}${tail}`;
  });

  // Remove function return annotations: function f(...) : T
  out = out.replace(/(\)\s*):\s*[^=\n]+(?=\s*(?:\n|do\b))/g, "$1");

  return out;
}

function parseWithLuats(source) {
  try {
    const ast = luats.parseLuau(source);
    if (ast && ast.type === "Program" && Array.isArray(ast.body) && ast.body.length > 0) {
      return { ast, error: null };
    }
    return { ast: null, error: null };
  } catch (err) {
    return { ast: null, error: err };
  }
}

function parseWithLuaparse(source) {
  const options = {
    comments: false,
    scope: false,
    locations: false,
    ranges: false,
    luaVersion: "5.3",
  };

  try {
    const ast = luaparse.parse(source, options);
    return { ast, error: null, mode: "raw" };
  } catch (rawError) {
    const cleaned = stripSimpleLuauSyntax(source);
    if (cleaned === source) {
      return { ast: null, error: rawError, mode: "raw" };
    }
    try {
      const ast = luaparse.parse(cleaned, options);
      return { ast, error: null, mode: "stripped" };
    } catch (strippedError) {
      return {
        ast: null,
        error: new Error(
          `raw parse failed: ${rawError.message}; stripped parse failed: ${strippedError.message}`
        ),
        mode: "stripped",
      };
    }
  }
}

function normalizeBinaryOperator(op) {
  return op === "//" ? "/" : op;
}

function normalizeProgram(program) {
  const scope = new ScopeStack();

  function toVarExpr(node) {
    if (!node) return builder.Nil();
    if (node.type === "Identifier") {
      return scope.has(node.name) ? builder.Local(node.name) : builder.Global(node.name);
    }
    if (node.type === "MemberExpression") {
      const obj = toVarExpr(node.base || node.object);
      return builder.IndexName(obj, node.identifier ? node.identifier.name : node.property.name);
    }
    if (node.type === "IndexExpression") {
      const obj = toVarExpr(node.base || node.object);
      return builder.IndexExpr(obj, toExpr(node.index));
    }
    return toExpr(node);
  }

  function toFunctionExpr(node) {
    const fnScope = new ScopeStack();
    fnScope.scopes = scope.scopes.map((set) => new Set(set));
    fnScope.push();

    const prevScopes = scope.scopes;
    scope.scopes = fnScope.scopes;

    const params = [];
    for (const p of node.parameters || []) {
      if (p.type === "VarargLiteral") {
        params.push({ node: builder.Vararg() });
      } else {
        const name = p.name;
        scope.declare(name);
        params.push({
          node: {
            kind: "local",
            name: builder.Token(name),
          },
        });
      }
    }

    const bodyStatements = toStatements(node.body || []);
    scope.scopes = prevScopes;

    return {
      kind: "expr",
      tag: "function",
      functionkeyword: builder.Token("function"),
      openparens: builder.Token("("),
      parameters: params,
      closeparens: builder.Token(")"),
      body: {
        kind: "stat",
        tag: "block",
        statements: bodyStatements,
      },
      endkeyword: builder.Token("end"),
      attributes: [],
    };
  }

  function toExpr(node) {
    if (!node) return builder.Nil();

    switch (node.type) {
      case "NumericLiteral":
        return builder.Number(node.value);
      case "StringLiteral":
        return builder.String(node.value, "double");
      case "BooleanLiteral":
        return builder.Bool(node.value);
      case "NilLiteral":
        return builder.Nil();
      case "Identifier":
        return scope.has(node.name) ? builder.Local(node.name) : builder.Global(node.name);
      case "UnaryExpression":
        return builder.Unary(node.operator, toExpr(node.argument));
      case "BinaryExpression":
      case "LogicalExpression":
        return builder.Binary(
          toExpr(node.left),
          normalizeBinaryOperator(node.operator),
          toExpr(node.right)
        );
      case "CallExpression": {
        const base = toExpr(node.base || node.callee);
        const args = (node.arguments || []).map((arg) => toExpr(arg));
        return builder.Call(base, args);
      }
      case "TableCallExpression": {
        const base = toExpr(node.base || node.callee);
        return builder.Call(base, [toExpr(node.arguments || node.argument)]);
      }
      case "StringCallExpression": {
        const base = toExpr(node.base || node.callee);
        return builder.Call(base, [toExpr(node.argument)]);
      }
      case "MemberExpression":
        return builder.IndexName(toExpr(node.base || node.object), node.identifier.name);
      case "IndexExpression":
        return builder.IndexExpr(toExpr(node.base || node.object), toExpr(node.index));
      case "TableConstructorExpression": {
        const items = [];
        for (const field of node.fields || []) {
          if (field.type === "TableKeyString") {
            items.push({ key: field.key.name, value: toExpr(field.value) });
          } else if (field.type === "TableKey") {
            items.push({ index: toExpr(field.key), value: toExpr(field.value) });
          } else {
            items.push(toExpr(field.value));
          }
        }
        return builder.Table(items);
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
        return toFunctionExpr(node);
      case "VarargLiteral":
        return builder.Vararg();
      default:
        return builder.Nil();
    }
  }

  function parseIfClause(clause) {
    if (clause.type === "IfClause" || clause.type === "ElseifClause") {
      scope.push();
      const body = toStatements(clause.body || []);
      scope.pop();
      return {
        condition: toExpr(clause.condition),
        body,
      };
    }
    scope.push();
    const elseBody = toStatements(clause.body || []);
    scope.pop();
    return { elseBody };
  }

  function toStatement(stmt) {
    switch (stmt.type) {
      case "LocalStatement": {
        const values = (stmt.init || []).map((v) => toExpr(v));
        const names = stmt.variables.map((v) => v.name);
        for (const name of names) scope.declare(name);
        return builder.LocalDecl(names, values.length > 0 ? values : null);
      }
      case "AssignmentStatement": {
        const targets = stmt.variables.map((v) => toVarExpr(v));
        const values = stmt.init.map((v) => toExpr(v));
        return builder.Assign(targets, values);
      }
      case "CallStatement":
        return builder.ExprStat(toExpr(stmt.expression));
      case "IfStatement": {
        const clauses = stmt.clauses || [];
        if (clauses.length === 0) {
          return builder.If(builder.Bool(false), []);
        }
        const first = parseIfClause(clauses[0]);
        const elseifs = [];
        let elseBody = null;
        for (let i = 1; i < clauses.length; i += 1) {
          const parsed = parseIfClause(clauses[i]);
          if (parsed.elseBody) {
            elseBody = parsed.elseBody;
          } else {
            elseifs.push(builder.ElseIf(parsed.condition, parsed.body));
          }
        }
        return builder.If(first.condition, first.body, elseifs, elseBody);
      }
      case "WhileStatement": {
        scope.push();
        const body = toStatements(stmt.body || []);
        scope.pop();
        return builder.While(toExpr(stmt.condition || stmt.test), body);
      }
      case "DoStatement": {
        scope.push();
        const body = toStatements(stmt.body || []);
        scope.pop();
        return {
          kind: "stat",
          tag: "do",
          dokeyword: builder.SpacedToken("do"),
          body: builder.Block(body),
          endkeyword: builder.NewlineToken("end"),
        };
      }
      case "RepeatStatement": {
        scope.push();
        const body = toStatements(stmt.body || []);
        const condition = toExpr(stmt.condition);
        scope.pop();
        return {
          kind: "stat",
          tag: "repeat",
          repeatkeyword: builder.Token("repeat"),
          body: builder.Block(body),
          untilkeyword: builder.SpacedToken("until"),
          condition,
        };
      }
      case "ForNumericStatement": {
        scope.push();
        scope.declare(stmt.variable.name);
        const body = toStatements(stmt.body || []);
        scope.pop();
        return {
          kind: "stat",
          tag: "for",
          forkeyword: builder.TrailingSpacedToken("for"),
          variable: { kind: "local", name: builder.Token(stmt.variable.name) },
          equals: builder.SurroundedSpacedToken("="),
          from: toExpr(stmt.start),
          tokeyword: builder.SurroundedSpacedToken("to"),
          to: toExpr(stmt.end),
          step: stmt.step ? toExpr(stmt.step) : null,
          dokeyword: builder.SpacedToken("do"),
          body: builder.Block(body),
          endkeyword: builder.NewlineToken("end"),
        };
      }
      case "ForGenericStatement": {
        scope.push();
        for (const v of stmt.variables || []) {
          scope.declare(v.name);
        }
        const body = toStatements(stmt.body || []);
        scope.pop();
        return {
          kind: "stat",
          tag: "forin",
          forkeyword: builder.TrailingSpacedToken("for"),
          variables: (stmt.variables || []).map((v, i, arr) => ({
            node: { kind: "local", name: builder.Token(v.name) },
            separator: i < arr.length - 1 ? builder.TrailingSpacedToken(",") : null,
          })),
          inkeyword: builder.SurroundedSpacedToken("in"),
          values: (stmt.iterators || []).map((v, i, arr) => ({
            node: toExpr(v),
            separator: i < arr.length - 1 ? builder.TrailingSpacedToken(",") : null,
          })),
          dokeyword: builder.SpacedToken("do"),
          body: builder.Block(body),
          endkeyword: builder.NewlineToken("end"),
        };
      }
      case "ReturnStatement":
        return {
          kind: "stat",
          tag: "return",
          returnkeyword: builder.TrailingSpacedToken("return"),
          expressions: (stmt.arguments || []).map((arg, i, arr) => ({
            node: toExpr(arg),
            separator: i < arr.length - 1 ? builder.TrailingSpacedToken(",") : null,
          })),
        };
      case "BreakStatement":
        return builder.Break();
      case "FunctionDeclaration": {
        const funcExpr = toFunctionExpr(stmt);
        if (stmt.isLocal && stmt.identifier) {
          scope.declare(stmt.identifier.name);
          return {
            kind: "stat",
            tag: "localfunction",
            localkeyword: builder.TrailingSpacedToken("local"),
            functionkeyword: builder.TrailingSpacedToken("function"),
            name: {
              kind: "expr",
              tag: "local",
              token: builder.Token(stmt.identifier.name),
              local: { kind: "local", name: builder.Token(stmt.identifier.name) },
              upvalue: false,
            },
            func: funcExpr,
          };
        }
        const target = stmt.identifier ? toVarExpr(stmt.identifier) : builder.Global("_anon");
        return builder.Assign([target], [funcExpr]);
      }
      default:
        return null;
    }
  }

  function toStatements(statements) {
    const out = [];
    for (const stat of statements) {
      const normalized = toStatement(stat);
      if (normalized) out.push(normalized);
    }
    return out;
  }

  const statements = toStatements(program.body || []);
  return {
    kind: "stat",
    tag: "block",
    statements,
  };
}

function parse(source) {
  const luaparseResult = parseWithLuaparse(source);
  if (luaparseResult.ast) {
    return {
      root: normalizeProgram(luaparseResult.ast),
      parser: luaparseResult.mode === "stripped" ? "luaparse-stripped" : "luaparse",
    };
  }

  const luatsResult = parseWithLuats(source);
  if (luatsResult.ast) {
    return { root: normalizeProgram(luatsResult.ast), parser: "luats" };
  }

  const luaparseMessage =
    luaparseResult.error && luaparseResult.error.message
      ? luaparseResult.error.message
      : "unknown luaparse parse failure";
  const luatsMessage =
    luatsResult.error && luatsResult.error.message
      ? luatsResult.error.message
      : "luats could not parse or returned no executable AST";

  throw new Error(
    `Unable to parse Luau source. luaparse: ${luaparseMessage}; luats: ${luatsMessage}`
  );
}

module.exports = {
  parse,
  stripSimpleLuauSyntax,
};
