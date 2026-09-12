#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { deobfuscateLuaObfuscator } from "./core/deobfuscator.js";

function printUsage() {
  console.log(`Usage:
  node src/cli.js <file-or-directory> [--out <directory>] [--stdout] [--summary]

Options:
  --out <directory>   Output directory. Defaults to deobfuscated/
  --stdout            Print a single deobfuscated file to stdout
  --no-cleanup        Disable readability cleanup passes
  --keep-banner       Keep LuaObfuscator banner comments
  --keep-decoder      Keep detected decoder prelude/function
  --summary           Print per-file transform stats
  --help              Show this help text
`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    outDir: "deobfuscated",
    stdout: false,
    cleanup: true,
    keepBanner: false,
    keepDecoder: false,
    summary: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--out" || arg === "-o") {
      args.outDir = argv[++i];
      if (!args.outDir) throw new Error("--out requires a directory");
    } else if (arg === "--stdout") {
      args.stdout = true;
    } else if (arg === "--no-cleanup") {
      args.cleanup = false;
    } else if (arg === "--keep-banner") {
      args.keepBanner = true;
    } else if (arg === "--keep-decoder") {
      args.keepDecoder = true;
    } else if (arg === "--summary") {
      args.summary = true;
    } else if (!args.input) {
      args.input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return args;
}

function collectLuaFiles(inputPath) {
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) return [inputPath];
  if (!stat.isDirectory()) throw new Error(`Input is not a file or directory: ${inputPath}`);

  return fs.readdirSync(inputPath)
    .filter((name) => /\.(?:lua|txt)$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(inputPath, name));
}

function formatSummary(file, result, outputPath) {
  const stats = result.stats;
  return [
    `${path.basename(file)} -> ${outputPath}`,
    `  decoders=${stats.decoders.length}`,
    `decodedStrings=${stats.decodedStrings}`,
    `vmPayloads=${stats.vmPayloads}`,
    `vmDecodedBytes=${stats.vmDecodedBytes}`,
    `vmInstructions=${stats.vmInstructions}`,
    `vmExpandedInstructions=${stats.vmExpandedInstructions}`,
    `vmPreservedInstructions=${stats.vmPreservedInstructions}`,
    `vmOutputMode=${stats.vmOutputMode}`,
    ...(stats.vmSuperinstructionError ? [`vmSuperinstructionError=${JSON.stringify(stats.vmSuperinstructionError)}`] : []),
    `foldedNumbers=${stats.foldedNumbers}`,
    `simplifiedNoise=${stats.simplifiedNoise}`,
    `removedBanner=${stats.removedBanner}`,
    `removedDecoder=${stats.removedDecoder}`
  ].join(" ");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const inputPath = path.resolve(args.input);
  const files = collectLuaFiles(inputPath);

  if (args.stdout && files.length !== 1) {
    throw new Error("--stdout can only be used with a single input file");
  }

  const outputRoot = path.resolve(args.outDir);
  if (!args.stdout) fs.mkdirSync(outputRoot, { recursive: true });

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const result = deobfuscateLuaObfuscator(source, {
      cleanup: args.cleanup,
      removeBanner: !args.keepBanner,
      removeDecoder: !args.keepDecoder
    });

    if (args.stdout) {
      process.stdout.write(result.code);
      continue;
    }

    const outputName = path.basename(file).replace(/\.(?:lua|txt)$/i, ".deobf.lua");
    const outputPath = path.join(outputRoot, outputName);
    fs.writeFileSync(outputPath, result.code, "utf8");
    if (args.summary) console.log(formatSummary(file, result, outputPath));
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
