const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { deobfuscate } = require('../src');

const checks = new Map([
  [3, ['is palindrome:', '.reverse().join']],
  [4, ['Hello, World!']],
  [5, ['10 + 5 =', '10 - 5 =', '10 * 5 =', '10 / 5 =']],
  [6, ['Original:', 'Doubled:', 'Sum:', '.map(', '.reduce(']],
  [7, ['Enter a string:', '.charAt(0).toUpperCase()', '.slice(1)']],
  [8, ['Enter a string:', '.charAt(0).toUpperCase()', '.slice(1)']],
  [9, ['Enter a string:', '.charAt(0).toUpperCase()', '.slice(1)']],
  [10, ['Enter a string:', '.charAt(0).toUpperCase()', '.slice(1)']],
  [11, ['Enter a string:', '.charAt(0).toUpperCase()', '.slice(1)']],
  [13, ['Enter a string:', '.charAt(0).toUpperCase()', '.slice(1)']]
]);

for (const [n, needles] of checks) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'samples', `obfuscated (${n}).js`), 'utf8');
  const { code, report } = deobfuscate(source, { rename: true, maxIterations: 8 });
  assert.ok(!report.parseError, `sample ${n} should parse`);
  for (const needle of needles) assert.ok(code.includes(needle), `sample ${n} should expose ${needle}`);
  assert.ok(!/_0x[0-9a-f]{4,}/i.test(code), `sample ${n} should not retain classic hex identifiers`);
}
console.log('recovered-shapes PASS (10 valid samples)');
