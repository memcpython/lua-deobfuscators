#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { deobfuscate } = require('./index');

function usage() {
  console.log(`Usage:
  node src/cli.js <input.js> [-o output.js]
  node src/cli.js <input-directory> [-o output-directory]

Options:
  -o, --output <path>       Output file or directory
  --no-rename               Preserve obfuscated identifier names
  --no-format               Disable final beautification
  --passes <N>              Maximum fixpoint iterations (default: 10)
  --inline-named-functions  Allow inlining meaningful named functions
  -h, --help                Show this help

By default a file is written beside the input as <name>.deobfuscated.js.
No report.json file is generated.`);
}

function parseArgs(argv) {
  let input = null, output = null;
  let rename = true, format = true, inlineNamedFunctions = false, maxIterations = 10;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') output = argv[++i];
    else if (a === '--no-rename') rename = false;
    else if (a === '--no-format') format = false;
    else if (a === '--inline-named-functions') inlineNamedFunctions = true;
    else if (a === '--passes') maxIterations = Math.max(1, Number(argv[++i]) || 10);
    else if (!a.startsWith('-') && !input) input = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { input, output, options: { rename, format, maxIterations, inlineNamedFunctions } };
}

function jsFilesRecursive(root) {
  const out = [];
  function visit(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'testing/output') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) visit(full);
      else if (ent.isFile() && /\.(?:js|cjs|mjs)$/i.test(ent.name) && !/\.deobfuscated\.(?:js|cjs|mjs)$/i.test(ent.name)) out.push(full);
    }
  }
  visit(root);
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function outputName(input, output) {
  if (output) return output;
  const ext = path.extname(input) || '.js';
  return path.join(path.dirname(input), `${path.basename(input, path.extname(input))}.deobfuscated${ext}`);
}

function processFile(input, output, options) {
  const source = fs.readFileSync(input, 'utf8');
  const result = deobfuscate(source, options);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, result.code);
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    usage();
    process.exit(argv.length ? 0 : 1);
  }

  let args;
  try { args = parseArgs(argv); }
  catch (error) { console.error(error.message); usage(); process.exit(2); }
  if (!args.input) { usage(); process.exit(2); }

  const input = path.resolve(args.input);
  if (!fs.existsSync(input)) { console.error(`Input not found: ${args.input}`); process.exit(2); }
  const stat = fs.statSync(input);

  if (stat.isDirectory()) {
    const files = jsFilesRecursive(input);
    const outputRoot = path.resolve(args.output || `${input}-deobfuscated`);
    let parseErrors = 0, totalChanges = 0;
    for (const file of files) {
      const rel = path.relative(input, file);
      const ext = path.extname(rel);
      const outRel = path.join(path.dirname(rel), `${path.basename(rel, ext)}.deobfuscated${ext}`);
      const outFile = path.join(outputRoot, outRel);
      const result = processFile(file, outFile, args.options);
      totalChanges += result.report.totalChanges || 0;
      if (result.report.parseError) parseErrors++;
      const status = result.report.parseError ? 'INVALID' : 'OK';
      console.error(`[${status}] ${rel} -> ${path.relative(outputRoot, outFile)}`);
    }
    console.error(`complete: ${files.length} files, ${parseErrors} invalid input(s), output: ${outputRoot}`);
    if (parseErrors) process.exitCode = 3;
    return;
  }

  const output = path.resolve(outputName(input, args.output));
  const result = processFile(input, output, args.options);
  if (result.report.parseError) {
    console.error(`Input parse error: ${result.report.parseError}`);
    console.error(`Preserved input at: ${output}`);
    process.exitCode = 3;
  } else {
    console.error(`deobfuscated -> ${output}`);
  }
}

main();
