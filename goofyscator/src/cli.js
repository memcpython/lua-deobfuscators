#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { devirtualizeFile } from './index.js';

const USAGE = `Usage: goofy-deobf <input.lua> [options]

Options:
  -o, --output <file>       Write recovered Lua to <file>
      --no-optimize         Emit the unoptimized lifted program
      --lua <command>       Use a specific Lua runtime
      --probe-timeout <ms>  Override the VM-capture timeout
      --debug               Print full error stacks
  -h, --help                Show this help`;

function failUsage(message = null) {
  if (message) process.stderr.write(`goofy-deobf: ${message}\n\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = { input: null, output: null, optimize: true, lua: null, probeTimeoutMs: undefined, debug: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-o' || arg === '--output') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a file path`);
      options.output = value;
    } else if (arg === '--lua') {
      const value = argv[++i];
      if (!value) throw new Error('--lua requires a command or executable path');
      options.lua = value;
    } else if (arg === '--probe-timeout') {
      const value = Number(argv[++i]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('--probe-timeout requires a positive integer in milliseconds');
      options.probeTimeoutMs = value;
    } else if (arg === '--no-optimize') options.optimize = false;
    else if (arg === '--debug') options.debug = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else if (!options.input) options.input = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return options;
}

function writeAtomic(file, code) {
  const absolute = path.resolve(file);
  const directory = path.dirname(absolute);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(absolute)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, code, 'latin1');
    try {
      fs.renameSync(temp, absolute);
    } catch (error) {
      // Windows can reject replacing an existing destination with rename().
      if (process.platform !== 'win32' || !['EEXIST','EPERM','EACCES'].includes(error?.code)) throw error;
      fs.rmSync(absolute, { force: true });
      fs.renameSync(temp, absolute);
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  failUsage(error.message);
}

if (args) {
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
  } else if (!args.input) {
    failUsage('missing input file');
  } else {
    try {
      const result = devirtualizeFile(args.input, {
        optimize: args.optimize,
        lua: args.lua,
        probeTimeoutMs: args.probeTimeoutMs,
      });
      if (args.output) writeAtomic(args.output, result.code);
      else process.stdout.write(result.code);
    } catch (error) {
      const detail = args.debug ? (error?.stack ?? String(error)) : (error?.message ?? String(error));
      process.stderr.write(`goofy-deobf: ${detail}\n`);
      process.exitCode = 1;
    }
  }
}
