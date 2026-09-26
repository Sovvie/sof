"use strict";

const settings = require("./settings");

const RegAlloc = {
  new() {
    return {
      Registers: {},
      Bindings: {},
      Pinned: {},
      Top: 0,
      Max: settings.MAX_REGISTERS,
    };
  },

  Alloc(alloc, name) {
    const oldReg = alloc.Bindings[name];
    delete alloc.Bindings[name];

    if (oldReg !== undefined) {
      if (
        !RegAlloc.IsNamed(alloc, oldReg) &&
        !alloc.Pinned[oldReg] &&
        !(alloc.Escaped && alloc.Escaped[oldReg])
      ) {
        // Kept as a no-op intentionally to preserve legacy behavior.
        // alloc.Registers[oldReg] = false
      }
    }

    let i = 0;
    while (true) {
      if (!alloc.Registers[i] && !alloc.Pinned[i] && !(alloc.Escaped && alloc.Escaped[i])) {
        alloc.Registers[i] = true;
        alloc.Bindings[name] = i;
        if (i >= alloc.Top) {
          alloc.Top = i + 1;
        }
        return i;
      }
      i += 1;
    }
  },

  AllocTemp(alloc) {
    let i = 0;
    while (true) {
      if (!alloc.Registers[i] && !alloc.Pinned[i] && !(alloc.Escaped && alloc.Escaped[i])) {
        alloc.Registers[i] = true;
        if (i >= alloc.Top) {
          alloc.Top = i + 1;
        }
        return i;
      }
      i += 1;
    }
  },

  Free(alloc, name) {
    const reg = alloc.Bindings[name];
    if (reg !== undefined) {
      delete alloc.Bindings[name];
      if (!alloc.Pinned[reg] && !(alloc.Escaped && alloc.Escaped[reg])) {
        // No-op by design to mirror original allocator behavior.
        // alloc.Registers[reg] = false
      }
    }
    return null;
  },

  FreeReg(alloc, reg) {
    if (RegAlloc.IsNamed(alloc, reg)) {
      return null;
    }
    if (alloc.Pinned[reg] || (alloc.Escaped && alloc.Escaped[reg])) {
      return null;
    }
    // No-op by design to mirror original allocator behavior.
    // alloc.Registers[reg] = false
    return null;
  },

  Get(alloc, name) {
    return alloc.Bindings[name];
  },

  MarkEscaped(alloc, reg) {
    alloc.Escaped = alloc.Escaped || {};
    alloc.Escaped[reg] = true;
    return null;
  },

  NextUvLocalName(alloc) {
    alloc.UvSeq = (alloc.UvSeq || 0) + 1;
    return `_p${alloc.UvSeq}`;
  },

  IsAllocated(alloc, reg) {
    return alloc.Registers[reg] === true;
  },

  Pin(_alloc, _reg) {
    // alloc.Pinned[reg] = true
    return null;
  },

  Unpin(_alloc, _reg) {
    // alloc.Pinned[reg] = false
    return null;
  },

  IsNamed(alloc, reg) {
    return Object.values(alloc.Bindings).some((boundReg) => boundReg === reg);
  },

  Name(alloc, reg) {
    if (typeof reg === "string") return reg;

    if (reg < alloc.Max) {
      return `R${reg}`;
    }

    return `Overflow[${reg - alloc.Max + 1}]`;
  },

  Reset(alloc) {
    alloc.Registers = {};
    alloc.Bindings = {};
    alloc.Top = 0;
    return null;
  },
};

module.exports = RegAlloc;
