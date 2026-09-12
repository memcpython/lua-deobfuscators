import fs from 'node:fs';
import { parseWrapper } from '../parser/lua-object.js';
import { discoverV10 } from '../discovery/v10.js';
import { runProbe } from '../runtime/probe.js';
import { liftBundle } from '../lift/lift-program.js';
import { optimizeBundle } from '../optimize/index.js';
import { emitSourceLua } from '../emit/source-lua.js';
import { runPhase } from '../errors.js';
import { validateProbeBundle, validateV10Discovery } from '../validate/v10.js';

const FORBIDDEN_EXTRACTED_SEMANTICS = new Set(['unknown', 'dispatch_wrapper', 'inline', 'invalid_inline']);

function assertExtractionComplete(probe) {
  const failures = [];
  for (const program of probe.programs ?? []) {
    for (const instruction of program.instructions ?? []) {
      if (FORBIDDEN_EXTRACTED_SEMANTICS.has(instruction.semantic) || instruction.expandError || instruction.prototypeError) {
        failures.push({
          program: program.id,
          pc: instruction.pc,
          semantic: instruction.semantic,
          error: instruction.expandError ?? instruction.prototypeError ?? null,
        });
      }
    }
  }
  if (failures.length) {
    throw new Error(`VM extraction incomplete: ${JSON.stringify(failures.slice(0, 8))}`);
  }
}

export function analyzeSource(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');

  const wrapper = runPhase('parse', () => parseWrapper(source));
  const discovery = runPhase('discovery', () => validateV10Discovery(discoverV10(wrapper)));
  const probe = runPhase('probe', () => validateProbeBundle(runProbe({
    wrapperSource: wrapper,
    discovery,
    tempRoot: options.tempRoot ?? null,
    luaCommand: options.lua ?? null,
    timeoutMs: options.probeTimeoutMs,
  })));
  runPhase('probe', () => assertExtractionComplete(probe));

  const rawIr = runPhase('lift', () => liftBundle(probe, discovery));
  const optimized = options.optimize === false
    ? { bundle: structuredClone(rawIr), stats: { disabled: true } }
    : runPhase('optimize', () => optimizeBundle(structuredClone(rawIr)));

  return {
    wrapper,
    discovery,
    probe,
    rawIr,
    ir: optimized.bundle,
    optimization: optimized.stats,
  };
}

export function devirtualizeSource(source, options = {}) {
  const analysis = analyzeSource(source, options);
  const code = runPhase('emit', () => emitSourceLua(analysis.ir, options));
  return { ...analysis, code };
}

export function devirtualizeFile(file, options = {}) {
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('file must be a non-empty path string');
  const source = runPhase('read', () => fs.readFileSync(file, 'latin1'));
  return devirtualizeSource(source, options);
}
