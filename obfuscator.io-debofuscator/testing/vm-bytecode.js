const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { deobfuscate } = require('../src');

const source = fs.readFileSync(path.join(__dirname, '..', 'samples', 'obfuscated (10).js'), 'utf8');

function assertLifted(result, label) {
  const vmPass = result.report.passes.find(p => p.name === '1:vm-devirtualize');
  assert.ok(vmPass, `${label}: first VM pass should be reported`);
  assert.strictEqual(vmPass.structuralDetection, true, `${label}: VM should be structurally detected`);
  assert.strictEqual(vmPass.decoderRecovered, true, `${label}: decoded VM metadata should be extracted`);
  assert.strictEqual(vmPass.recovered?.[0]?.strategy, 'bytecode-stack-lift', `${label}: VM should be lifted from bytecode, not guessed`);
  assert.strictEqual(vmPass.recovered?.[0]?.bytecodeLength, 48, `${label}: decoded bytecode length should be visible`);
  assert.strictEqual(vmPass.recovered?.[0]?.instructionCount, 24, `${label}: all 24 instructions should be lifted`);
  assert.strictEqual(vmPass.recovered?.[0]?.instructionConfidence, 1, `${label}: instruction pair orientation should be fully resolved`);
  assert.ok(vmPass.recovered?.[0]?.verifiedProbes >= 10, `${label}: lifted source should pass semantic verification`);
  assert.match(result.code, /function\s+capitalizeFirstLetter\(L_1\)[\s\S]*return\s+L_1\.charAt\(0\)\.toUpperCase\(\)\s*\+\s*L_1\.slice\(1\);/);
  assert.ok(!/vmg_|runner_RANDOM/.test(result.code), `${label}: VM interpreter must be removed after verified lifting`);
}

assertLifted(deobfuscate(source, { rename: true, maxIterations: 8 }), 'original names');

// Rename the current implementation prefixes throughout the bundle to prove that
// VM discovery does not depend on vme_* / vmg_* identifier naming conventions.
const renamed = source
  .replaceAll('vme_74d162', 'state_RANDOM')
  .replaceAll('vmg_6deb30', 'runner_RANDOM');
assertLifted(deobfuscate(renamed, { rename: true, maxIterations: 8 }), 'renamed VM bindings');

console.log('vm-bytecode PASS (structural detect / decoded 48 words / lifted 24 instructions)');
