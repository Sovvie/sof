"use strict";

const constantTable = require("./constant-table");
const stateTransformer = require("./state-transformer");
const mbaPass = require("./mba-pass");

const DEFAULT_PASSES = [constantTable, mbaPass];

function run(ctx, options = {}) {
  let passes = options.passes || DEFAULT_PASSES;
  if (options.enableStateTransformer) {
    passes = [constantTable, stateTransformer, mbaPass];
  }
  for (const pass of passes) {
    if (pass && typeof pass.Run === "function") {
      pass.Run(ctx);
    }
  }
}

module.exports = {
  run,
  passes: {
    constantTable,
    stateTransformer,
    mbaPass,
  },
};
