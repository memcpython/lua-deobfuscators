const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { deobfuscate } = require('../src');
const { parse } = require('../src/core/ast');

const sample = path.join(__dirname, '..', 'samples', 'obfuscated (10).js');
const source = fs.readFileSync(sample, 'utf8');

function execute(code, promptValue) {
  const logs = [];
  const sandbox = {
    prompt(message) { logs.push(['prompt', message]); return promptValue; },
    console: {
      log(...args) { logs.push(['log', ...args]); },
      warn() {}, error() {}, info() {}, debug() {}
    },
    setInterval() { return 0; }, clearInterval() {},
    setTimeout() { return 0; }, clearTimeout() {}
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  vm.runInContext(code, vm.createContext(sandbox), { timeout: 4000 });
  return logs;
}

const result = deobfuscate(source, { rename: true, maxIterations: 8 });
assert.doesNotThrow(() => parse(result.code));
assert.ok(result.code.length < source.length * 0.05, 'VM runtime should be removed after verified recovery');
assert.ok(!/\bvm[eg]_[A-Za-z0-9_$]+\b/.test(result.code), 'VM runtime/state identifiers should be gone');
assert.match(result.code, /charAt\(0\)\.toUpperCase\(\)\s*\+\s*\w+\.slice\(1\)/);

for (const input of ['hello', 'world', 'a', 'Test String', '']) {
  assert.deepStrictEqual(execute(result.code, input), execute(source, input), `VM semantic mismatch for ${JSON.stringify(input)}`);
}

console.log('vm recovery PASS (5 semantic probes)');
