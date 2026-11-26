// @ts-check
/**
 * AST Constant & Matcher Argument Evaluation Facade (`src/kernel/gate/constant-eval.mjs`).
 *
 * Composed cleanly from acyclic submodules:
 * - `constant-primitives.mjs` — constant/tautology folding, vacuous regexes & callback return extraction
 * - `matcher-arg-eval.mjs`    — self-referential DOM oracle & vacuous matcher argument inspection
 */
export {
  extractCallbackReturnExprs,
  extractSingleReturnCallbackExpr,
  isBooleanTrueLiteralAst,
  isConstantExpressionAst,
  isSemanticVacuousRegex,
} from './constant-primitives.mjs';
export {
  SELF_REF_DOM_READERS,
  hasArithmeticOrSubstantiveDerivation,
  inspectMatcherExpectedArgAst,
} from './matcher-arg-eval.mjs';
