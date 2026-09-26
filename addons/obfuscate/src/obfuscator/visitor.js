"use strict";

const builder = require("./builder");
const regalloc = require("./regalloc");
const emit = require("./emit");

function cloneNode(value) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => cloneNode(item));
  }
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = cloneNode(child);
  }
  return out;
}

function wrapReturnStatement() {
  return {
    kind: "stat",
    tag: "return",
    returnkeyword: builder.TrailingSpacedToken("return"),
    expressions: [],
  };
}

function toExpression(node) {
  if (!node || typeof node !== "object") {
    return builder.Nil();
  }

  switch (node.tag) {
    case "number":
      return builder.Number(typeof node.value === "number" ? node.value : Number(node.text || 0));
    case "string":
      return builder.String(node.text || "", node.quotestyle || "double");
    case "boolean":
      return builder.Bool(Boolean(node.value));
    case "nil":
      return builder.Nil();
    case "local":
      return builder.Local(node.token && node.token.text ? node.token.text : "_");
    case "global":
      return builder.Global(node.name && node.name.text ? node.name.text : "_G");
    case "group":
      return builder.Group(toExpression(node.expression));
    case "index":
      return builder.IndexExpr(toExpression(node.expression), toExpression(node.index));
    case "indexname":
      return builder.IndexName(
        toExpression(node.expression),
        node.index && node.index.text ? node.index.text : "_"
      );
    case "call":
      return builder.Call(
        toExpression(node.func),
        (node.arguments || []).map((arg) => toExpression(arg.node || arg))
      );
    case "binary":
      return builder.Binary(
        toExpression(node.lhsoperand),
        node.operator && node.operator.text ? node.operator.text : "==",
        toExpression(node.rhsoperand)
      );
    case "unary":
      return builder.Unary(
        node.operator && node.operator.text ? node.operator.text : "not",
        toExpression(node.operand)
      );
    case "table": {
      const entries = [];
      for (const entry of node.entries || []) {
        if (entry.kind === "record") {
          entries.push({ key: entry.key && entry.key.text ? entry.key.text : "_", value: toExpression(entry.value) });
        } else if (entry.kind === "general") {
          entries.push({ index: toExpression(entry.key), value: toExpression(entry.value) });
        } else {
          entries.push(toExpression(entry.value));
        }
      }
      return builder.Table(entries);
    }
    case "function": {
      const params = [];
      for (const p of node.parameters || []) {
        const param = p.node || p;
        if (param.tag === "vararg") {
          params.push({ node: builder.Vararg() });
        } else {
          params.push({
            node: {
              kind: "local",
              name: builder.Token((param.name && param.name.text) || (param.token && param.token.text) || "_"),
            },
          });
        }
      }
      const body = compileBlock(node.body || { tag: "block", statements: [] });
      return {
        kind: "expr",
        tag: "function",
        functionkeyword: builder.Token("function"),
        openparens: builder.Token("("),
        parameters: params,
        closeparens: builder.Token(")"),
        body,
        endkeyword: builder.Token("end"),
        attributes: [],
      };
    }
    case "vararg":
      return builder.Vararg();
    default:
      return cloneNode(node);
  }
}

function compileStatement(stat) {
  if (!stat || typeof stat !== "object") return null;

  switch (stat.tag) {
    case "local":
      return builder.LocalDecl(
        (stat.variables || []).map((v) => {
          const node = v.node || v;
          return node.name && node.name.text ? node.name.text : "_";
        }),
        (stat.values || []).map((v) => toExpression(v.node || v))
      );
    case "assign":
      return builder.Assign(
        (stat.variables || []).map((v) => toExpression(v.node || v)),
        (stat.values || []).map((v) => toExpression(v.node || v))
      );
    case "expression":
      return builder.ExprStat(toExpression(stat.expression));
    case "conditional": {
      const elseifs = (stat.elseifs || []).map((elseifNode) =>
        builder.ElseIf(
          toExpression(elseifNode.condition),
          compileBlock(elseifNode.thenblock || { tag: "block", statements: [] }).statements
        )
      );
      const elseBody = stat.elseblock
        ? compileBlock(stat.elseblock).statements
        : null;
      return builder.If(
        toExpression(stat.condition),
        compileBlock(stat.thenblock || { tag: "block", statements: [] }).statements,
        elseifs,
        elseBody
      );
    }
    case "while":
      return builder.While(
        toExpression(stat.condition),
        compileBlock(stat.body || { tag: "block", statements: [] }).statements
      );
    case "for":
      return {
        kind: "stat",
        tag: "for",
        forkeyword: builder.TrailingSpacedToken("for"),
        variable: {
          kind: "local",
          name: builder.Token((stat.variable && stat.variable.name && stat.variable.name.text) || "_"),
        },
        equals: builder.SurroundedSpacedToken("="),
        from: toExpression(stat.from),
        tokeyword: builder.TrailingSpacedToken(","),
        to: toExpression(stat.to),
        step: stat.step ? toExpression(stat.step) : null,
        dokeyword: builder.SpacedToken("do"),
        body: compileBlock(stat.body || { tag: "block", statements: [] }),
        endkeyword: builder.Token("end"),
      };
    case "forin":
      return {
        kind: "stat",
        tag: "forin",
        forkeyword: builder.TrailingSpacedToken("for"),
        variables: (stat.variables || []).map((v, i, arr) => {
          const node = v.node || v;
          return {
            node: {
              kind: "local",
              name: builder.Token((node.name && node.name.text) || "_"),
            },
            separator: i < arr.length - 1 ? builder.TrailingSpacedToken(",") : null,
          };
        }),
        inkeyword: builder.SurroundedSpacedToken("in"),
        values: (stat.values || []).map((v, i, arr) => ({
          node: toExpression(v.node || v),
          separator: i < arr.length - 1 ? builder.TrailingSpacedToken(",") : null,
        })),
        dokeyword: builder.SpacedToken("do"),
        body: compileBlock(stat.body || { tag: "block", statements: [] }),
        endkeyword: builder.Token("end"),
      };
    case "do":
      return {
        kind: "stat",
        tag: "do",
        dokeyword: builder.Token("do"),
        body: compileBlock(stat.body || { tag: "block", statements: [] }),
        endkeyword: builder.Token("end"),
      };
    case "repeat":
      return {
        kind: "stat",
        tag: "repeat",
        repeatkeyword: builder.Token("repeat"),
        body: compileBlock(stat.body || { tag: "block", statements: [] }),
        untilkeyword: builder.TrailingSpacedToken("until"),
        condition: toExpression(stat.condition),
      };
    case "return":
      return {
        kind: "stat",
        tag: "return",
        returnkeyword: builder.TrailingSpacedToken("return"),
        expressions: (stat.expressions || []).map((expr, i, arr) => ({
          node: toExpression(expr.node || expr),
          separator: i < arr.length - 1 ? builder.TrailingSpacedToken(",") : null,
        })),
      };
    case "break":
      return builder.Break();
    case "continue":
      return {
        kind: "stat",
        tag: "continue",
      };
    case "localfunction": {
      const name = (stat.name && stat.name.token && stat.name.token.text) || "_";
      const func = toExpression(stat.func);
      return {
        kind: "stat",
        tag: "localfunction",
        localkeyword: builder.TrailingSpacedToken("local"),
        functionkeyword: builder.TrailingSpacedToken("function"),
        name: builder.Local(name),
        func,
      };
    }
    default:
      return cloneNode(stat);
  }
}

function compileBlock(blockNode) {
  const statements = [];
  for (const statement of blockNode.statements || []) {
    const compiled = compileStatement(statement);
    if (compiled) statements.push(compiled);
  }
  return {
    kind: "stat",
    tag: "block",
    statements,
  };
}

function compile(astRoot) {
  const alloc = regalloc.new();
  const emitCtx = emit.new();

  const entry = emit.CreateBlock(emitCtx);
  const done = emit.CreateBlock(emitCtx);
  emit.SetCurrent(emitCtx, entry);

  const compiledRoot = compileBlock(astRoot);
  for (const statement of compiledRoot.statements) {
    emit.Push(emitCtx, statement);
  }

  emit.Push(emitCtx, builder.Assign([builder.Local("State")], [builder.Number(done.StateId)]));
  emit.SetCurrent(emitCtx, done);
  emit.Push(emitCtx, wrapReturnStatement());

  return {
    Alloc: alloc,
    EmitCtx: emitCtx,
  };
}

function generate(compiled) {
  return emit.Generate(compiled.EmitCtx, compiled.Alloc);
}

module.exports = {
  compile,
  generate,
  compileBlock,
  compileStatement,
  toExpression,
};
