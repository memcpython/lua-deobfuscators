const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { deobfuscate } = require('../src');
const { parse } = require('../src/core/ast');

const sample = n => fs.readFileSync(path.join(__dirname, '..', 'samples', `obfuscated (${n}).js`), 'utf8');

const vm = deobfuscate(sample(10), { rename: true, format: true, maxIterations: 8 });
assert.doesNotThrow(() => parse(vm.code));
assert.ok(vm.code.includes('\n  return L_1.charAt(0).toUpperCase() + L_1.slice(1);\n'));
assert.ok(vm.code.includes('prompt("Enter a string: ")'));
assert.ok(!/\\x[0-9a-f]{2}|\\u00[0-9a-f]{2}/i.test(vm.code), 'readable literals should not keep unnecessary hex escapes');
assert.ok(!vm.code.includes('vmg_') && !vm.code.includes('vme_'), 'VM plumbing should not survive verified recovery');

const classic = deobfuscate(sample(3), { rename: true, format: true, maxIterations: 8 });
assert.doesNotThrow(() => parse(classic.code));
assert.ok(classic.code.split('\n').length >= 8, 'classic output should be multiline/beautified');
assert.ok(!classic.code.includes('\\x20'));

const minified = 'function demo(a){if(a){return 1;}else{return 2;}}console.log(demo(true));';
const pretty = deobfuscate(minified, { rename: false, format: true, maxIterations: 1 });
assert.doesNotThrow(() => parse(pretty.code));
assert.ok(pretty.code.includes('\n'), 'final formatter should run even when no obfuscator-specific pass is needed');
assert.match(pretty.code, /function demo\(a\) \{/);

console.log('beautify PASS (VM/classic/plain JavaScript normalized)');
