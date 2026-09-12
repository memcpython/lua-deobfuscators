const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { parse } = require('../src/core/ast');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obfio-cli-'));
const input = path.join(dir, 'input.js');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'synthetic-obfuscated.js'), input);
const cli = path.join(__dirname, '..', 'src', 'cli.js');
const run = spawnSync(process.execPath, [cli, input], { encoding: 'utf8' });
assert.strictEqual(run.status, 0, run.stderr);
const output = path.join(dir, 'input.deobfuscated.js');
assert.ok(fs.existsSync(output), 'CLI should write the deobfuscated file by default');
assert.doesNotThrow(() => parse(fs.readFileSync(output, 'utf8')));
assert.deepStrictEqual(fs.readdirSync(dir).filter(x => x.endsWith('.json')), [], 'CLI must not generate report.json files');
fs.rmSync(dir, { recursive: true, force: true });
console.log('cli-output PASS (deobfuscated file only, no report.json)');
