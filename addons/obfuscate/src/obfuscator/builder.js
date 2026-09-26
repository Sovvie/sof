"use strict";

function isObject(value) {
  return value !== null && typeof value === "object";
}

function makeLocation() {
  return Symbol("luau-location");
}

function leftmost(node) {
  if (!node) return null;
  if (node.istoken) return node;

  if (node.tag === "expression") return leftmost(node.expression);
  if (node.tag === "assign") return leftmost(node.variables[0] && node.variables[0].node);
  if (node.tag === "local") {
    if (node.kind === "expr") return leftmost(node.token);
    return leftmost(node.localkeyword);
  }
  if (node.tag === "while") return leftmost(node.whilekeyword);
  if (node.tag === "conditional") return leftmost(node.ifkeyword);
  if (node.tag === "break") return node;
  if (node.tag === "call") return leftmost(node.func);
  if (node.tag === "global") return leftmost(node.name);
  if (node.tag === "index") return leftmost(node.expression);
  if (node.tag === "indexname") return leftmost(node.expression);

  return null;
}

function rightmost(node) {
  if (!node) return null;
  if (node.istoken) return node;

  if (node.tag === "expression") return rightmost(node.expression);
  if (node.tag === "assign") {
    const lastValue = node.values && node.values[node.values.length - 1];
    return rightmost(lastValue && lastValue.node);
  }
  if (node.tag === "local") {
    if (node.kind === "expr") return rightmost(node.token);
    if (node.values && node.values.length > 0) {
      return rightmost(node.values[node.values.length - 1].node);
    }
    const lastVar = node.variables && node.variables[node.variables.length - 1];
    return rightmost(lastVar && lastVar.node && lastVar.node.name);
  }
  if (node.tag === "while" || node.tag === "conditional") return rightmost(node.endkeyword);
  if (node.tag === "break") return node;
  if (node.tag === "call") return rightmost(node.closeparens);
  if (node.tag === "global") return rightmost(node.name);
  if (node.tag === "index") return rightmost(node.closebrackets);
  if (node.tag === "indexname") return rightmost(node.index);
  if (node.tag === "group") return rightmost(node.closeparens);
  if (node.tag === "binary") return rightmost(node.rhsoperand);
  if (node.tag === "unary") return rightmost(node.operand);
  if (node.tag === "return") {
    if (node.expressions && node.expressions.length > 0) {
      return rightmost(node.expressions[node.expressions.length - 1].node);
    }
    return rightmost(node.returnkeyword);
  }
  if (node.tag === "table") return rightmost(node.closebrace);
  if (node.tag === "function") return rightmost(node.endkeyword);
  if (node.tag === "block") return rightmost(node.statements[node.statements.length - 1]);

  return null;
}

const Builder = {
  makeLocation,

  Prepend(node, trivia) {
    const tok = leftmost(node);
    if (tok) {
      tok.leadingtrivia.splice(0, 0, {
        tag: "whitespace",
        text: trivia,
      });
    }
    return node;
  },

  Clone(node) {
    if (node == null) return null;
    if (typeof node === "number" || typeof node === "boolean" || typeof node === "string") {
      return node;
    }
    if (typeof node === "symbol") return node;

    const copy = {};
    for (const [key, value] of Object.entries(node)) {
      copy[key] = value;
    }
    return copy;
  },

  DeepClone(node) {
    if (node == null) return null;
    if (typeof node === "number" || typeof node === "boolean" || typeof node === "string") {
      return node;
    }
    if (typeof node === "symbol") return node;

    const copy = {};
    for (const [key, value] of Object.entries(node)) {
      if (isObject(value)) {
        copy[key] = Builder.Clone(value);
      } else {
        copy[key] = value;
      }
    }
    return copy;
  },

  Append(node, trivia) {
    const tok = rightmost(node);
    if (tok) {
      tok.trailingtrivia.push({
        tag: "whitespace",
        text: trivia,
      });
    }
    return node;
  },

  Token(text) {
    return {
      text,
      istoken: true,
      leadingtrivia: [],
      trailingtrivia: [],
      location: makeLocation(),
    };
  },

  SpacedToken(text) {
    return {
      text,
      istoken: true,
      leadingtrivia: [{ tag: "whitespace", text: " " }],
      trailingtrivia: [],
      location: makeLocation(),
    };
  },

  TrailingSpacedToken(text) {
    return {
      text,
      istoken: true,
      leadingtrivia: [],
      trailingtrivia: [{ tag: "whitespace", text: " " }],
      location: makeLocation(),
    };
  },

  SurroundedSpacedToken(text) {
    return {
      text,
      istoken: true,
      leadingtrivia: [{ tag: "whitespace", text: " " }],
      trailingtrivia: [{ tag: "whitespace", text: " " }],
      location: makeLocation(),
    };
  },

  NewlineToken(text) {
    return {
      text,
      istoken: true,
      leadingtrivia: [{ tag: "whitespace", text: "\n" }],
      trailingtrivia: [],
      location: makeLocation(),
    };
  },

  Group(expr) {
    return {
      kind: "expr",
      tag: "group",
      openparens: Builder.Token("("),
      expression: expr,
      closeparens: Builder.Token(")"),
    };
  },

  Global(name) {
    return {
      kind: "expr",
      tag: "global",
      name: Builder.Token(name),
    };
  },

  Local(name) {
    const loc = {
      kind: "local",
      name: Builder.Token(name),
    };

    return {
      kind: "expr",
      tag: "local",
      token: Builder.Token(name),
      local: loc,
      upvalue: false,
    };
  },

  Number(value, spaced) {
    return {
      kind: "expr",
      tag: "number",
      text: String(value),
      value,
      istoken: true,
      leadingtrivia: spaced ? [{ tag: "whitespace", text: " " }] : [],
      trailingtrivia: [],
      location: makeLocation(),
    };
  },

  String(text, quote, spaced) {
    return {
      kind: "expr",
      tag: "string",
      text,
      quotestyle: quote || "double",
      blockdepth: 0,
      istoken: true,
      leadingtrivia: spaced ? [{ tag: "whitespace", text: " " }] : [],
      trailingtrivia: [],
      location: makeLocation(),
    };
  },

  Bool(value, spaced) {
    return {
      kind: "expr",
      tag: "boolean",
      text: value ? "true" : "false",
      value: Boolean(value),
      istoken: true,
      leadingtrivia: spaced ? [{ tag: "whitespace", text: " " }] : [],
      trailingtrivia: [],
      location: makeLocation(),
    };
  },

  Nil(spaced) {
    return {
      kind: "expr",
      tag: "nil",
      text: "nil",
      istoken: true,
      leadingtrivia: spaced ? [{ tag: "whitespace", text: " " }] : [],
      trailingtrivia: [],
      location: makeLocation(),
    };
  },

  IndexExpr(obj, index) {
    return {
      kind: "expr",
      tag: "index",
      expression: obj,
      openbrackets: Builder.Token("["),
      index,
      closebrackets: Builder.Token("]"),
    };
  },

  IndexName(obj, name) {
    return {
      kind: "expr",
      tag: "indexname",
      expression: obj,
      accessor: Builder.Token("."),
      index: Builder.Token(name),
    };
  },

  Call(func, args) {
    const punctuated = [];
    for (let i = 0; i < args.length; i += 1) {
      punctuated.push({
        node: args[i],
        separator: i < args.length - 1 ? Builder.TrailingSpacedToken(",") : null,
      });
    }

    return {
      kind: "expr",
      tag: "call",
      func,
      openparens: Builder.Token("("),
      arguments: punctuated,
      closeparens: Builder.Token(")"),
      self: false,
    };
  },

  Binary(lhs, op, rhs) {
    return {
      kind: "expr",
      tag: "binary",
      lhsoperand: lhs,
      operator: Builder.SurroundedSpacedToken(op),
      rhsoperand: rhs,
    };
  },

  Unary(op, operand) {
    return {
      kind: "expr",
      tag: "unary",
      operator: Builder.TrailingSpacedToken(op),
      operand,
    };
  },

  Vararg() {
    return {
      kind: "expr",
      tag: "vararg",
      trailingtrivia: [],
      leadingtrivia: [],
      location: makeLocation(),
      istoken: true,
      text: "...",
    };
  },

  Logical(lhs, op, rhs) {
    return {
      kind: "expr",
      tag: "binary",
      lhsoperand: lhs,
      operator: Builder.SurroundedSpacedToken(op),
      rhsoperand: rhs,
    };
  },

  ExprStat(expr) {
    return {
      kind: "stat",
      tag: "expression",
      expression: expr,
    };
  },

  Assign(targets, values) {
    const varPunct = [];
    for (let i = 0; i < targets.length; i += 1) {
      varPunct.push({
        node: targets[i],
        separator: i < targets.length - 1 ? Builder.TrailingSpacedToken(",") : null,
      });
    }

    const valPunct = [];
    for (let i = 0; i < values.length; i += 1) {
      valPunct.push({
        node: values[i],
        separator: i < values.length - 1 ? Builder.TrailingSpacedToken(",") : null,
      });
    }

    return {
      kind: "stat",
      tag: "assign",
      variables: varPunct,
      equals: Builder.SurroundedSpacedToken("="),
      values: valPunct,
    };
  },

  LocalDecl(names, values) {
    const varPunct = [];
    for (let i = 0; i < names.length; i += 1) {
      varPunct.push({
        node: {
          kind: "local",
          name: i > 0 ? Builder.SpacedToken(names[i]) : Builder.Token(names[i]),
        },
        separator: i < names.length - 1 ? Builder.Token(",") : null,
      });
    }

    const valPunct = [];
    if (values) {
      for (let i = 0; i < values.length; i += 1) {
        valPunct.push({
          node: values[i],
          separator: i < values.length - 1 ? Builder.TrailingSpacedToken(",") : null,
        });
      }
    }

    return {
      kind: "stat",
      tag: "local",
      localkeyword: Builder.TrailingSpacedToken("local"),
      variables: varPunct,
      equals: values ? Builder.SurroundedSpacedToken("=") : null,
      values: valPunct,
      token: { text: names[0], istoken: true, location: makeLocation() },
    };
  },

  Table(items) {
    const punctuated = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const entry = {
        istableitem: true,
        separator: i < items.length - 1 ? Builder.TrailingSpacedToken(",") : null,
      };

      if (item && Object.prototype.hasOwnProperty.call(item, "key")) {
        entry.kind = "record";
        entry.key = typeof item.key === "string" ? Builder.Token(item.key) : item.key;
        entry.equals = Builder.SurroundedSpacedToken("=");
        entry.value = item.value;
      } else if (item && Object.prototype.hasOwnProperty.call(item, "index")) {
        entry.kind = "general";
        entry.indexeropen = Builder.Token("[");
        entry.key = item.index;
        entry.indexerclose = Builder.Token("]");
        entry.equals = Builder.SurroundedSpacedToken("=");
        entry.value = item.value;
      } else {
        entry.kind = "list";
        const isAstNode =
          item &&
          typeof item === "object" &&
          (Object.prototype.hasOwnProperty.call(item, "tag") ||
            Object.prototype.hasOwnProperty.call(item, "kind"));
        if (isAstNode) {
          entry.value = item;
        } else if (item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, "value")) {
          entry.value = item.value;
        } else {
          entry.value = item;
        }
      }
      punctuated.push(entry);
    }

    return {
      kind: "expr",
      tag: "table",
      openbrace: Builder.Token("{"),
      entries: punctuated,
      closebrace: Builder.Token("}"),
    };
  },

  While(condition, body) {
    return {
      kind: "stat",
      tag: "while",
      whilekeyword: Builder.TrailingSpacedToken("while"),
      condition,
      dokeyword: Builder.SpacedToken("do"),
      body: Builder.Block(body),
      endkeyword: Builder.NewlineToken("end"),
    };
  },

  If(condition, thenBody, elseifs, elseBody) {
    return {
      kind: "stat",
      tag: "conditional",
      ifkeyword: Builder.TrailingSpacedToken("if"),
      condition,
      thenkeyword: Builder.SpacedToken("then"),
      thenblock: Builder.Block(thenBody),
      elseifs: elseifs || [],
      elsekeyword: elseBody ? Builder.NewlineToken("else") : null,
      elseblock: elseBody ? Builder.Block(elseBody) : null,
      endkeyword: Builder.NewlineToken("end"),
    };
  },

  ElseIf(condition, body) {
    const elseifKw = Builder.TrailingSpacedToken("elseif");
    elseifKw.leadingtrivia.splice(0, 0, { tag: "whitespace", text: "\n" });

    return {
      elseifkeyword: elseifKw,
      condition,
      thenkeyword: Builder.SpacedToken("then"),
      thenblock: Builder.Block(body),
    };
  },

  Break() {
    return {
      kind: "stat",
      tag: "break",
      text: "break",
      istoken: true,
      leadingtrivia: [{ tag: "whitespace", text: "\n" }],
      trailingtrivia: [],
      location: makeLocation(),
    };
  },

  Block(statements) {
    for (const stat of statements) {
      Builder.Prepend(stat, "\n");
    }

    return {
      kind: "stat",
      tag: "block",
      statements,
    };
  },
};

module.exports = Builder;
