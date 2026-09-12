const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { deobfuscate } = require('../src');
const { parse } = require('../src/core/ast');

const source = fs.readFileSync(path.join(__dirname, '..', 'samples', 'obfuscated (15).js'), 'utf8');
const result = deobfuscate(source, { rename: true, format: true, maxIterations: 10 });

assert.doesNotThrow(() => parse(result.code));
assert.ok(source.length > 60000, 'fixture must remain a genuinely large obfuscated input');
assert.ok(result.code.includes('require("./index")'));
assert.ok(result.code.includes('require("../testing/defaultContext")'));
assert.ok(result.code.includes('test("Http trigger should return known text"'));
assert.ok(result.code.includes('toEqual("Hello Bill")'));
assert.ok(!result.code.includes('capitalizeFirstLetter'), 'unrelated demo semantics must never leak into this input');
assert.ok(!result.code.includes('Enter a string:'), 'unrelated prompt demo must never leak into this input');
assert.ok(!/\b(?:var|arg|fn|err)_\d+\b/.test(result.code), 'generated names should use L_N only');
assert.ok(/\bL_1\b/.test(result.code) && /\bL_2\b/.test(result.code), 'surviving obfuscated locals should be densely normalized');
assert.ok(result.code.length < 1500, 'decoder / self-defending scaffolding should be removed');

async function executeHarness(code) {
  const events = [];
  const pending = [];
  const context = {
    res: {},
    log(...args) {
      context.log.mock.calls.push(args);
      events.push(['log', ...args]);
    }
  };
  context.log.mock = { calls: [] };
  const httpFunction = async (ctx, req) => {
    events.push(['httpFunction', JSON.parse(JSON.stringify(req))]);
    ctx.log('called');
    ctx.res.body = `Hello ${req.query.name}`;
  };
  const sandbox = {
    require(spec) {
      events.push(['require', spec]);
      if (spec === './index') return httpFunction;
      if (spec === '../testing/defaultContext') return context;
      throw new Error(`unexpected require ${spec}`);
    },
    test(name, fn) {
      events.push(['test', name]);
      pending.push(Promise.resolve().then(fn));
    },
    expect(actual) {
      return {
        toBe(expected) {
          events.push(['toBe', actual, expected]);
          assert.strictEqual(actual, expected);
        },
        toEqual(expected) {
          events.push(['toEqual', actual, expected]);
          assert.deepStrictEqual(actual, expected);
        }
      };
    },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout() { return 0; }, clearTimeout() {},
    setInterval() { return 0; }, clearInterval() {}
  };
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInContext(code, vm.createContext(sandbox), { timeout: 5000 });
  await Promise.all(pending);
  return events;
}

const promise = (async () => {
  const before = await executeHarness(source);
  const after = await executeHarness(result.code);
  assert.deepStrictEqual(after, before, 'large-sample observable behavior must match');
  console.log(`large-regression PASS (${source.length} -> ${result.code.length} bytes, behavior equivalent, no demo leakage)`);
})();

if (require.main === module) {
  promise.catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = promise;
