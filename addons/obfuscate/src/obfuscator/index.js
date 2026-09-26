"use strict";

const parser = require("./parser");
const visitor = require("./visitor");
const hardening = require("./hardening");
const polymorphism = require("./post/polymorphism");
const printer = require("./printer");

function obfuscate(source, options = {}) {
  const parsed = parser.parse(source);
  const compiled = visitor.compile(parsed.root);

  if (options.hardening !== false) {
    hardening.run(compiled, options.hardeningOptions || {});
  }

  const generatedAst = visitor.generate(compiled);

  if (options.postProcess !== false) {
    polymorphism.Run(generatedAst);
  }

  const output = printer.print(generatedAst);
  return output;
}

module.exports = {
  obfuscate,
  parse: parser.parse,
  print: printer.print,
  hardening,
};
