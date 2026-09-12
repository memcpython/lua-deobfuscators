function fail(message) {
  throw new Error(`V10 discovery invariant failed: ${message}`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is missing`);
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value)) fail(`${label} is not a safe integer`);
}

function requirePositiveInteger(value, label) {
  requireInteger(value, label);
  if (value <= 0) fail(`${label} must be positive`);
}

export function validateV10Discovery(discovery) {
  if (!discovery || discovery.version !== 'V10') fail('unsupported or missing version');
  requireString(discovery.entryMethod, 'entry method');
  requireString(discovery.builderKey, 'handler builder key');

  if ((discovery.unknownHandlers ?? []).length) {
    fail(`unmapped handler families: ${discovery.unknownHandlers.join(', ')}`);
  }
  if (Object.keys(discovery.binary?.ops ?? {}).length !== 16) {
    fail(`binary selector map is incomplete (${Object.keys(discovery.binary?.ops ?? {}).length}/16)`);
  }

  const runner = discovery.runner ?? {};
  requireString(runner.key, 'runner key');
  requirePositiveInteger(runner.pcKey, 'runner PC key');
  requirePositiveInteger(runner.baseLeft, 'runner PC base-left key');
  requirePositiveInteger(runner.baseRight, 'runner PC base-right key');

  const bootstrap = discovery.bootstrap ?? {};
  for (const field of ['key','stateField','envField','handlerField','bitField','payloadSeedField','secondaryField','loaderField','geKey','executorKey','b91Key','primaryExecKey']) {
    requireString(bootstrap[field], `bootstrap ${field}`);
  }
  if (bootstrap.antiField != null) requireString(bootstrap.antiField, 'bootstrap antiField');
  requireInteger(bootstrap.primaryCallbackId, 'bootstrap primary callback id');
  requirePositiveInteger(bootstrap.paramProtoKey, 'bootstrap prototype parameter key');
  if (!Array.isArray(bootstrap.emptyFields)) fail('bootstrap empty field list is missing');
  if (typeof bootstrap.alphabet !== 'string' || bootstrap.alphabet.length !== 91) fail('Base91 alphabet is invalid');

  const resolver = discovery.resolver ?? {};
  requireString(resolver.key, 'operand resolver key');
  for (const field of ['valueKey','kindKey','defaultKind','regKind','immKind','registerStateKey','constantsStateKey']) {
    requireInteger(resolver[field], `operand resolver ${field}`);
  }
  if (!Array.isArray(resolver.constKinds) || resolver.constKinds.length < 1) fail('operand constant-kind set is missing');

  const dest = discovery.dest ?? {};
  for (const field of ['key','bias','multiplier','modulus']) requireInteger(dest[field], `destination decoder ${field}`);
  if (dest.modulus <= 0) fail('destination decoder modulus must be positive');

  const layout = discovery.instructionLayout ?? {};
  for (const field of ['extraKey','operandsKey','primaryOperandKey','secondaryOperandKey']) {
    requirePositiveInteger(layout[field], `instruction layout ${field}`);
  }
  if ((discovery.inlineIds ?? []).length) requirePositiveInteger(layout.inlineListKey, 'instruction layout inline list key');

  const prototype = discovery.prototypeLayout ?? {};
  requirePositiveInteger(prototype.constantPoolKey, 'prototype constant-pool key');

  const closure = discovery.closureLayout ?? {};
  requireString(closure.builderKey, 'closure prototype builder key');
  requirePositiveInteger(closure.processedKey, 'closure processed key');
  if (!Array.isArray(closure.rawKeys) || closure.rawKeys.length !== 3 || closure.rawKeys.some(x => !Number.isSafeInteger(x))) {
    fail('closure raw-key layout is invalid');
  }

  return discovery;
}

export function validateProbeBundle(probe) {
  if (!probe || probe.version !== 'V10') throw new Error('Probe returned an invalid V10 bundle');
  if (!Array.isArray(probe.programs) || probe.programs.length === 0) throw new Error('Probe captured no VM prototypes');
  for (const [index, program] of probe.programs.entries()) {
    if (!program || !Array.isArray(program.instructions)) throw new Error(`Probe program ${index} has no instruction list`);
    for (const instruction of program.instructions) {
      if (!Number.isFinite(instruction?.pc)) throw new Error(`Probe program ${index} contains an instruction without a PC`);
      if (typeof instruction?.semantic !== 'string') throw new Error(`Probe program ${index} pc ${instruction?.pc}: semantic is missing`);
    }
  }
  return probe;
}
