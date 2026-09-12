import { removeLuaObfuscatorBanner } from "../transforms/banner.js";
import { decodeXorStrings } from "../transforms/decodeXorStrings.js";
import { decodeLuaObfuscatorVm } from "../transforms/decodeVmPayload.js";
import { foldNumericNoise } from "../transforms/foldNumericNoise.js";
import { simplifySourceNoise } from "../transforms/simplifySourceNoise.js";
import { cleanupLua } from "../transforms/cleanupLua.js";

export function deobfuscateLuaObfuscator(source, options = {}) {
  const config = {
    cleanup: options.cleanup !== false,
    removeBanner: options.removeBanner !== false,
    removeDecoder: options.removeDecoder !== false
  };

  const stats = {
    decoders: [],
    decodedStrings: 0,
    foldedNumbers: 0,
    simplifiedNoise: 0,
    vmPayloads: 0,
    vmDecodedBytes: 0,
    vmInstructions: 0,
    vmExpandedInstructions: 0,
    vmPreservedInstructions: 0,
    vmOutputMode: "source",
    vmSuperinstructionError: null,
    removedBanner: false,
    removedDecoder: false
  };

  let code = source;

  if (config.removeBanner) {
    const result = removeLuaObfuscatorBanner(code);
    code = result.code;
    stats.removedBanner = result.removed;
  }

  const decoded = decodeXorStrings(code, {
    removeDecoder: config.removeDecoder
  });
  code = decoded.code;
  stats.decoders = decoded.decoders;
  stats.decodedStrings = decoded.decodedStrings;
  stats.removedDecoder = decoded.removedDecoder;

  const vmDecoded = decodeLuaObfuscatorVm(code);
  code = vmDecoded.code;
  stats.vmPayloads = vmDecoded.decodedPayloads;
  stats.vmDecodedBytes = vmDecoded.decodedBytes;
  stats.vmInstructions = vmDecoded.instructionCount;
  stats.vmExpandedInstructions = vmDecoded.expandedInstructionCount;
  stats.vmPreservedInstructions = vmDecoded.preservedInstructions;
  stats.vmOutputMode = vmDecoded.outputMode;
  stats.vmSuperinstructionError = vmDecoded.superinstructionError;

  if (config.cleanup) {
    if (stats.vmPayloads === 0) {
      for (let pass = 0; pass < 2; pass += 1) {
        const simplified = simplifySourceNoise(code);
        code = simplified.code;
        stats.simplifiedNoise += simplified.simplified;

        const folded = foldNumericNoise(code);
        code = folded.code;
        stats.foldedNumbers += folded.folded;
      }

      code = cleanupLua(code);
    }
  }

  return { code, stats };
}
