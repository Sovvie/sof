"use strict";

const regalloc = require("./regalloc");
const builder = require("./builder");
const { randInt } = require("./utils/random");

const MAX_CHAIN = 4;
const ALLOW_STMT_MERGE = true;

function stateLocal() {
  return builder.Local("State");
}

function shallowClone(value) {
  if (Array.isArray(value)) {
    return value.slice();
  }
  if (value && typeof value === "object") {
    return { ...value };
  }
  return value;
}

function randomEqGuard(state, id) {
  const r = randInt(1, 2);
  if (r === 1) {
    return builder.Binary(state, "==", builder.Number(id));
  }
  return builder.Unary(
    "not",
    {
      kind: "expr",
      tag: "group",
      openparens: builder.Token("("),
      expression: builder.Binary(state, "~=", builder.Number(id)),
      closeparens: builder.Token(")"),
    }
  );
}

function safeTernary(cond, a, b) {
  function couldBeFalsy(node) {
    if (!node || typeof node !== "object") return true;
    if (node.tag === "nil") return true;
    if (node.tag === "boolean") return node.value === false || node.value == null;
    if (node.tag === "binary" || node.tag === "logical") return true;
    if (node.tag === "local" || node.tag === "global") return true;
    if (node.tag === "index" || node.tag === "indexname") return true;
    if (node.tag === "call" || node.tag === "methodcall") return true;
    return false;
  }

  if (couldBeFalsy(a)) {
    const tableA = builder.Table([builder.Group(a)]);
    const tableB = builder.Table([builder.Group(b)]);
    const logicTernary = builder.Logical(
      builder.Logical(cond, "and", tableA),
      "or",
      tableB
    );
    return builder.IndexExpr(builder.Group(logicTernary), builder.Number(1));
  }

  return builder.Group(
    builder.Logical(
      builder.Logical(cond, "and", builder.Group(a)),
      "or",
      builder.Group(b)
    )
  );
}

function isStrictlySame(a, b) {
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a == null || b == null) return a === b;

  for (const [key, value] of Object.entries(a)) {
    if (key === "leadingtrivia" || key === "trailingtrivia" || key === "location") continue;
    if (!isStrictlySame(value, b[key])) return false;
  }
  for (const key of Object.keys(b)) {
    if (key === "leadingtrivia" || key === "trailingtrivia" || key === "location") continue;
    if (a[key] === undefined) return false;
  }
  return true;
}

function getWrittenRegisters(stat) {
  const written = [];
  if (stat && stat.tag === "assign" && stat.kind === "stat") {
    for (const v of stat.variables || []) {
      written.push(v.node || v);
    }
  }
  return written;
}

function isUvBoxLocalDecl(stat) {
  if (
    !stat ||
    typeof stat !== "object" ||
    stat.kind !== "stat" ||
    stat.tag !== "local" ||
    !Array.isArray(stat.variables)
  ) {
    return false;
  }
  for (const vw of stat.variables) {
    const text = vw && vw.node && vw.node.name && vw.node.name.text;
    if (typeof text === "string" && text.startsWith("_p")) {
      return true;
    }
  }
  return false;
}

function nodeReads(node, target) {
  if (!node || typeof node !== "object") return false;
  if (isStrictlySame(node, target)) return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "leadingtrivia" || key === "trailingtrivia" || key === "location") continue;
    if (value && typeof value === "object" && nodeReads(value, target)) return true;
  }
  return false;
}

function statReadsAny(stat, targets) {
  if (stat && stat.tag === "assign" && stat.kind === "stat") {
    for (const entry of stat.values || []) {
      const n = entry.node || entry;
      for (const t of targets) {
        if (nodeReads(n, t)) return true;
      }
    }
  }
  return false;
}

function compareNodes(a, b, deep) {
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a == null || b == null) return a === b;

  if (a.kind === "expr" && a.tag === "call") return false;

  if (a.tag !== b.tag || a.kind !== b.kind) {
    if (a.kind === "expr" && b.kind === "expr") {
      const isSafeToTernary = (node) => node && node.tag !== "nil" && node.tag !== "boolean";
      return isSafeToTernary(a) && isSafeToTernary(b);
    }
    return false;
  }

  const leafTags = {
    number: true,
    string: true,
    boolean: true,
    local: true,
    global: true,
    nil: true,
    vararg: true,
  };

  if (a.tag && leafTags[a.tag] && a.kind === "expr") {
    if (a.tag === "nil" || a.tag === "boolean") return isStrictlySame(a, b);
    if (a.tag === "string" || a.tag === "number") return isStrictlySame(a, b);
    if (a.tag === "local" || a.tag === "global" || a.tag === "vararg") return isStrictlySame(a, b);
    return true;
  }

  if (a.tag === "assign" && a.kind === "stat") {
    if (!Array.isArray(a.variables) || !Array.isArray(b.variables)) return false;
    if (a.variables.length !== b.variables.length) return false;
    if (!Array.isArray(a.values) || !Array.isArray(b.values)) return false;
    if (a.values.length !== b.values.length) return false;

    for (let i = 0; i < a.variables.length; i += 1) {
      const na = (a.variables[i] && (a.variables[i].node || a.variables[i])) || null;
      const nb = (b.variables[i] && (b.variables[i].node || b.variables[i])) || null;
      if (!na || !nb || na.tag !== nb.tag) return false;
      if (na.tag !== "index" && na.tag !== "indexname" && !isStrictlySame(na, nb)) return false;
      if (!compareNodes(na, nb, true)) return false;
    }

    for (let i = 0; i < a.values.length; i += 1) {
      const na = (a.values[i] && (a.values[i].node || a.values[i])) || null;
      const nb = (b.values[i] && (b.values[i].node || b.values[i])) || null;
      if (!na || !nb) return false;

      const ta = (a.variables[i] && (a.variables[i].node || a.variables[i])) || null;
      const tb = (b.variables[i] && (b.variables[i].node || b.variables[i])) || null;
      const targetsDiffer = !isStrictlySame(ta, tb);
      if (targetsDiffer && (na.tag === "assign" || nb.tag === "assign")) return false;
      if (!compareNodes(na, nb, true)) return false;
    }

    return true;
  }

  for (const [key, value] of Object.entries(a)) {
    if (key === "leadingtrivia" || key === "trailingtrivia" || key === "location") continue;
    const bv = b[key];
    if (bv === undefined) return false;
    if (typeof value === "object" && value !== null) {
      if (!compareNodes(value, bv, deep)) return false;
    } else if (value !== bv) {
      return false;
    }
  }

  for (const key of Object.keys(b)) {
    if (key === "leadingtrivia" || key === "trailingtrivia" || key === "location") continue;
    if (a[key] === undefined) return false;
  }
  return true;
}

function mergeNodes(a, b, cond) {
  if (typeof a !== typeof b) return a;
  if (typeof a !== "object" || a == null || b == null) return a;

  if (a.kind === "expr" && b.kind === "expr") {
    if (isStrictlySame(a, b)) return a;

    if (a.tag === b.tag) {
      if (a.tag === "index") {
        const out = shallowClone(a);
        out.expression = mergeNodes(a.expression, b.expression, cond);
        out.index = mergeNodes(a.index, b.index, cond);
        return out;
      }
      if (a.tag === "indexname") {
        const out = shallowClone(a);
        out.expression = mergeNodes(a.expression, b.expression, cond);
        out.index = a.index;
        return out;
      }
      if (a.tag === "call") {
        if (Array.isArray(a.arguments) && Array.isArray(b.arguments) && a.arguments.length === b.arguments.length && isStrictlySame(a.func, b.func)) {
          const out = shallowClone(a);
          out.arguments = a.arguments.map((arg, idx) => ({
            node: mergeNodes(arg.node, b.arguments[idx].node, cond),
            separator: arg.separator,
          }));
          return out;
        }
      }
      if (a.tag === "binary") {
        const logicalOps = { and: true, or: true };
        if (logicalOps[a.operator && a.operator.text] || logicalOps[b.operator && b.operator.text]) {
          return safeTernary(cond, a, b);
        }
        const lhsState = a.lhsoperand && a.lhsoperand.tag === "local" && a.lhsoperand.token && a.lhsoperand.token.text === "State";
        const cmp = a.operator && a.operator.text;
        if (lhsState && (cmp === "==" || cmp === "~=")) {
          return safeTernary(cond, a, b) || a;
        }
        if ((a.operator && a.operator.text) === (b.operator && b.operator.text)) {
          const out = shallowClone(a);
          out.lhsoperand = mergeNodes(a.lhsoperand, b.lhsoperand, cond);
          out.rhsoperand = mergeNodes(a.rhsoperand, b.rhsoperand, cond);
          return out;
        }
      }
    }

    return safeTernary(cond, a, b) || a;
  }

  if (a.tag === "assign" && a.kind === "stat" && b.tag === "assign" && b.kind === "stat") {
    const out = shallowClone(a);
    out.variables = a.variables.map((va, idx) => ({
      node: mergeNodes(va.node || va, (b.variables[idx].node || b.variables[idx]), cond),
      separator: va.separator,
    }));
    out.values = a.values.map((ea, idx) => ({
      node: mergeNodes(ea.node || ea, (b.values[idx].node || b.values[idx]), cond),
      separator: ea.separator,
    }));
    return out;
  }

  if (a.tag !== b.tag || a.kind !== b.kind) return a;

  const out = shallowClone(a);
  for (const [key, value] of Object.entries(a)) {
    if (key === "leadingtrivia" || key === "trailingtrivia" || key === "location") {
      out[key] = value;
      continue;
    }
    const bv = b[key];
    out[key] = value && typeof value === "object" ? mergeNodes(value, bv, cond) : value;
  }

  return out;
}

function buildChunk(sorted, lo, hi, ctx) {
  const count = hi - lo + 1;
  if (count === 1) {
    return builder.If(randomEqGuard(stateLocal(), sorted[lo].StateId), sorted[lo].Body);
  }

  const minId = sorted[lo].StateId;
  const maxId = sorted[hi].StateId;

  const rangeCond = builder.Logical(
    builder.Binary(stateLocal(), ">=", builder.Number(minId)),
    "and",
    builder.Binary(stateLocal(), "<=", builder.Number(maxId))
  );

  const chunkBody = [];
  if (ctx.SharedNode) {
    chunkBody.push(ctx.SharedNode);
  }

  let fallbackBody = shallowClone(sorted[hi].Body);
  for (let i = hi - 1; i >= lo; i -= 1) {
    const bodyA = shallowClone(sorted[i].Body);
    const bodyB = fallbackBody;
    const ids = sorted[i].StateId;
    const cond = randomEqGuard(stateLocal(), ids);

    let mergedCount = 0;
    const writtenA = [];
    const writtenB = [];

    while (
      ALLOW_STMT_MERGE &&
      mergedCount + 1 <= bodyA.length &&
      mergedCount + 1 <= bodyB.length
    ) {
      const stA = bodyA[mergedCount];
      const stB = bodyB[mergedCount];

      if (statReadsAny(stA, writtenB) || statReadsAny(stB, writtenA)) break;
      if (isUvBoxLocalDecl(stA) || isUvBoxLocalDecl(stB)) break;

      if (compareNodes(stA, stB)) {
        writtenA.push(...getWrittenRegisters(stA));
        writtenB.push(...getWrittenRegisters(stB));
        mergedCount += 1;
      } else {
        break;
      }
    }

    const nextFallback = [];
    if (mergedCount > 0) {
      const condVar = `_c${ctx.Counter}`;
      ctx.Counter += 1;
      nextFallback.push(builder.Append(builder.LocalDecl([condVar], [cond]), ";"));
      const stableCond = builder.Local(condVar);

      for (let j = 0; j < mergedCount; j += 1) {
        let merged = mergeNodes(bodyA[0], bodyB[0], stableCond);
        if (merged.tag === "assign" && merged.kind === "stat") {
          merged = shallowClone(merged);
        }
        merged = builder.Append(merged, ";");
        nextFallback.push(merged);
        bodyA.shift();
        bodyB.shift();
      }

      if (bodyA.length > 0 || bodyB.length > 0) {
        nextFallback.push(builder.If(stableCond, bodyA, [], bodyB));
      }
    } else {
      nextFallback.push(builder.If(cond, bodyA, [], bodyB));
    }

    fallbackBody = nextFallback;
  }

  chunkBody.push(...fallbackBody);
  return builder.If(rangeCond, chunkBody);
}

function buildDispatchTree(sorted, lo, hi, ctx) {
  if (lo > hi) return null;
  const count = hi - lo + 1;
  if (count <= MAX_CHAIN) {
    return buildChunk(sorted, lo, hi, ctx);
  }

  const pivotOffset = Math.floor(count / 2) - 1;
  const pivot = lo + pivotOffset;

  const leftTree = buildDispatchTree(sorted, lo, pivot, ctx);
  const rightTree = buildDispatchTree(sorted, pivot + 1, hi, ctx);
  const pivotStateId = sorted[pivot].StateId;
  const rightFirstStateId = sorted[pivot + 1].StateId;

  const r = randInt(1, 6);
  if (r === 1) {
    return builder.If(
      builder.Binary(stateLocal(), "<=", builder.Number(pivotStateId)),
      [leftTree],
      [],
      [rightTree]
    );
  }
  if (r === 2) {
    return builder.If(
      builder.Binary(stateLocal(), ">", builder.Number(pivotStateId)),
      [rightTree],
      [],
      [leftTree]
    );
  }
  if (r === 3) {
    return builder.If(
      builder.Binary(stateLocal(), "<", builder.Number(rightFirstStateId)),
      [leftTree],
      [],
      [rightTree]
    );
  }
  if (r === 4) {
    return builder.If(
      builder.Binary(stateLocal(), ">=", builder.Number(rightFirstStateId)),
      [rightTree],
      [],
      [leftTree]
    );
  }
  if (r === 5) {
    return builder.If(
      builder.Unary(
        "not",
        {
          kind: "expr",
          tag: "group",
          openparens: builder.Token("("),
          expression: builder.Binary(stateLocal(), ">", builder.Number(pivotStateId)),
          closeparens: builder.Token(")"),
        }
      ),
      [leftTree],
      [],
      [rightTree]
    );
  }
  return builder.If(
    builder.Unary(
      "not",
      {
        kind: "expr",
        tag: "group",
        openparens: builder.Token("("),
        expression: builder.Binary(stateLocal(), "<", builder.Number(rightFirstStateId)),
        closeparens: builder.Token(")"),
      }
    ),
    [rightTree],
    [],
    [leftTree]
  );
}

const Emit = {
  new() {
    return {
      Blocks: {},
      Current: null,
      Counter: 0,
      UsedIds: {},
      FirstStateId: null,
      Transforms: {},
      TransformStats: {},
      StringDecryptorNode: null,
      ConstantNode: null,
      SharedNode: null,
      LoopStack: [],
      CapturedEntryDecls: [],
    };
  },

  CreateBlock(ctx) {
    let id;
    do {
      id = randInt(1000, 100000);
    } while (ctx.UsedIds[id]);

    ctx.UsedIds[id] = true;
    if (!ctx.FirstStateId) {
      ctx.FirstStateId = id;
    }

    const block = { StateId: id, Body: [] };
    ctx.Blocks[id] = block;
    return block;
  },

  SetCurrent(ctx, block) {
    ctx.Current = block;
    return null;
  },

  Push(ctx, node) {
    ctx.Current.Body.push(node);
    return null;
  },

  CurrentPC(ctx) {
    return ctx.Current.Body.length;
  },

  GetBlock(ctx, stateId) {
    return ctx.Blocks[stateId];
  },

  CreateTransforms(ctx, count) {
    const transforms = [];
    const funcStats = {};

    for (let i = 1; i <= count; i += 1) {
      const name = `_transformer${i}`;
      const offset = randInt(100, 999);
      const multiplier = randInt(2, 5);
      transforms.push({
        Name: name,
        Encode: (id) => id * multiplier + offset,
        Decode: (s) => (s - offset) / multiplier,
      });
    }

    ctx.Transforms = transforms;
    ctx.TransformStats = funcStats;
    return transforms;
  },

  Generate(ctx, alloc) {
    const stmts = [];

    const funcExpr = {
      kind: "expr",
      tag: "function",
      functionkeyword: builder.Token("function"),
      openparens: builder.Token("("),
      parameters: [],
      closeparens: builder.Token(")"),
      body: {
        kind: "stat",
        tag: "block",
        statements: [
          {
            kind: "stat",
            tag: "return",
            returnkeyword: builder.TrailingSpacedToken("return"),
            expressions: [{ node: builder.Global("_ENV") }],
          },
        ],
      },
      endkeyword: builder.Prepend(builder.Token("end"), "\n"),
      attributes: {},
    };

    stmts.push(
      builder.LocalDecl(
        ["getfenv"],
        [builder.Logical(builder.Global("getfenv"), "or", funcExpr)]
      )
    );

    for (const trStat of Object.values(ctx.TransformStats || {})) {
      stmts.push(trStat);
    }

    if (ctx.StringDecryptorNode) {
      stmts.push(ctx.StringDecryptorNode);
    }

    stmts.push(builder.LocalDecl(["Env"], [builder.Call(builder.Local("getfenv"), [])]));
    stmts.push(builder.LocalDecl(["bit32"], [builder.Global("bit32")]));
    stmts.push(builder.LocalDecl(["table"], [builder.Global("table")]));
    stmts.push(builder.LocalDecl(["string"], [builder.Global("string")]));

    if (ctx.ConstantNode) {
      stmts.push(ctx.ConstantNode);
    }

    const inlineCount = Math.min(alloc.Top, alloc.Max);
    if (inlineCount > 0) {
      const regNames = [];
      for (let i = 0; i < inlineCount; i += 1) {
        regNames.push(`R${i}`);
      }
      stmts.push(builder.Prepend(builder.LocalDecl(regNames), ""));
    }

    if (alloc.Top > alloc.Max) {
      stmts.push(
        builder.Prepend(
          builder.LocalDecl(["Overflow"], [
            {
              kind: "expr",
              tag: "table",
              openbrace: builder.Token("{"),
              entries: [],
              closebrace: builder.Token("}"),
            },
          ]),
          "\n"
        )
      );
    }

    stmts.push(builder.Prepend(builder.LocalDecl(["State"], [builder.Number(ctx.FirstStateId || 0)]), ""));
    stmts.push(builder.Prepend(builder.LocalDecl(["CallEntry"], [builder.Nil()]), ""));
    stmts.push(
      builder.Prepend(
        builder.LocalDecl(["_args"], [
          {
            kind: "expr",
            tag: "table",
            openbrace: builder.Token("{"),
            entries: [],
            closebrace: builder.Token("}"),
          },
        ]),
        ""
      )
    );

    const sorted = Object.values(ctx.Blocks).sort((a, b) => a.StateId - b.StateId);
    const dispatchTree = buildDispatchTree(sorted, 0, sorted.length - 1, ctx);
    const whileStat = builder.While(builder.Bool(true), [dispatchTree]);

    const runBodyStmts = [];
    const cap = ctx.CapturedEntryDecls || [];
    if (cap.length > 0) {
      for (let i = cap.length - 1; i >= 0; i -= 1) {
        const c = cap[i];
        runBodyStmts.unshift(
          builder.Prepend(builder.LocalDecl([c.uvName], [c.valueExpr]), "\n\t")
        );
      }
      cap.length = 0;
    }
    runBodyStmts.push(builder.Prepend(whileStat, "\n\t"));

    const runFunc = {
      kind: "expr",
      tag: "function",
      functionkeyword: builder.Token("function"),
      openparens: builder.Token("("),
      vararg: builder.Token("..."),
      parameters: [],
      closeparens: builder.Token(")"),
      body: {
        kind: "stat",
        tag: "block",
        statements: runBodyStmts,
      },
      endkeyword: builder.Prepend(builder.Token("end"), "\n"),
      attributes: {},
    };

    stmts.push(builder.Prepend(builder.LocalDecl(["_Run"]), ""));
    stmts.push(builder.Prepend(builder.Assign([builder.Local("_Run")], [runFunc]), "\n"));
    stmts.push({
      kind: "stat",
      tag: "return",
      returnkeyword: {
        trailingtrivia: [{ tag: "whitespace", text: " ", location: builder.makeLocation() }],
        leadingtrivia: [{ tag: "whitespace", text: "\n\t\t", location: builder.makeLocation() }],
        location: builder.makeLocation(),
        text: "return",
        istoken: true,
      },
      expressions: [{ node: builder.Call(builder.Local("_Run"), []), separator: null }],
    });

    return builder.Block(stmts);
  },
};

Emit.BuildDispatchTree = buildDispatchTree;

module.exports = Emit;
