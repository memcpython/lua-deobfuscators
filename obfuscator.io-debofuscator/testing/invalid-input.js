const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { deobfuscate } = require('../src');

for (const name of ['obfuscated (12).js', 'obfuscated (14).js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'samples', name), 'utf8');
  const result = deobfuscate(source);
  assert.ok(result.report.parseError, `${name} should be reported as invalid input`);
  assert.strictEqual(result.code, source, `${name} must not be guessed/repaired destructively`);
}
console.log('invalid-input PASS (2 malformed fixtures preserved)');
