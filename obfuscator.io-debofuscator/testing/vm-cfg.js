const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parse } = require('../src/core/ast');
const { switchCaseCatalog } = require('../src/vm/runtime-inspector');
const { liftProgram } = require('../src/vm/bytecode-lifter');

// Reuse the actual Pro dispatcher catalog, but feed a small synthetic decoded
// program through it so the test covers branch reconstruction independently of
// the one straight-line VM fixture in samples/.
const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'samples', 'obfuscated (10).js'), 'utf8');
const catalog = switchCaseCatalog(parse(runtimeSource), runtimeSource);
const program = {
  // push arg0; jump-if-false -> pc4; push 1; return; push 0; return
  bytecode: { values: [0, 100, -1, 127, 1, 105, -1, 274, 0, 105, -1, 274] },
  constants: { values: [0, 1] },
  jumpTable: { values: [0, 4, 0, 0, 0, 0] }
};
const lifted = liftProgram(program, ['x'], catalog);
assert.strictEqual(lifted.ok, true, lifted.reason);
assert.strictEqual(lifted.controlFlowRecovered, true);
assert.strictEqual(lifted.semanticCoverage, 1);
assert.match(lifted.expression, /x\s*\?\s*1\s*:\s*0/);
const fn = Function('x', `return ${lifted.expression};`);
for (const x of [true, false, 1, 0, 'yes', '']) assert.strictEqual(fn(x), x ? 1 : 0);
console.log('vm-cfg PASS (conditional jump reconstructed)');
