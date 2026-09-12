# obfuscator.io deobfuscator

A Node.js deobfuscation/devirtualization pipeline focused on `javascript-obfuscator` / obfuscator.io output, including the supplied Pro VM-obfuscated sample.

The project is intentionally split into analysis passes instead of one large regex script. Every pass reparses the current JavaScript, transformations run to a fixpoint, Pro VM recovery is verified before interpreter removal, and every parseable result goes through a final readability/beautification stage.

## Install

```bash
npm install
```

Node.js 18 or newer is required.

## CLI

Single file:

```bash
node src/cli.js samples/input.js
node src/cli.js samples/input.js -o output.js
node src/cli.js samples/input.js --no-rename --passes 12
```

Whole directory (recursive):

```bash
node src/cli.js samples -o deobfuscated
```

Each input becomes `<name>.deobfuscated.js` by default. The CLI writes only deobfuscated source files; it does not create `report.json` sidecars. Files that are already syntactically invalid are preserved and marked `INVALID` instead of being guessed at.

Installed as a package:

```bash
npx obfio-deobfuscate input.js
```

## API

```js
const { deobfuscate } = require('./src');

const result = deobfuscate(source, {
  rename: true,
  format: true,
  maxIterations: 10
});

console.log(result.code);
console.log(result.report);
```

## Standard obfuscator.io recovery

The fixpoint pipeline currently includes:

- syntax validation and structural profiling
- literal/unary/binary constant folding
- structural string-array discovery (not tied to `_0x...` names)
- array-rotation recovery in a restricted Node `vm` context
- Base64 / RC4 / basic string decoder bootstrap
- decoder-wrapper and nested-wrapper replacement
- proxy object/function inlining
- alias and constant propagation
- computed-property normalization
- switch/loop control-flow unflattening
- sequence-expression splitting
- dead-branch removal
- self-defending / anti-tamper cleanup
- debug-protection / console-trap cleanup
- unused decoder/rotation/one-shot scaffold removal
- scope-aware obfuscated-identifier cleanup with dense `L_1`, `L_2`, … names
- literal normalization (`\x20` -> readable text when safe)
- temporary-return, empty-object assembly, dead-binding and declaration cleanup
- final parse-checked JavaScript beautification

## Pro VM devirtualization

The VM subsystem is separate from the ordinary AST passes and uses layered recovery.

### 1. Structural VM discovery

The runner is identified from the shape of its dense embedded dispatcher and the state object from its initialization/`Object.defineProperty` behavior. Recovery does **not** require current `vmg_*` / `vme_*` identifier prefixes. A regression test renames those bindings and still requires successful recovery.

### 2. Runtime metadata extraction

Only the embedded VM runtime is executed inside a restricted Node `vm` sandbox. The engine locates the VM program decoder structurally and extracts each wrapper's decoded metadata, including:

- bytecode words
- constant pool
- randomized metadata layout
- control-flow jump table when present
- handler table when present

The current Pro metadata slot permutation is solved from the decoded bytecode/constant-pool slots instead of hard-coding one sample's slot numbers.

### 3. Dispatcher/opcode classification

The VM's switch cases are classified from their implementation semantics rather than fixed opcode numbers. This is important because Pro builds can shuffle instruction numbers. The lifter recognizes, among other families:

- argument / constant / local loads and stores
- stack duplicate, swap and rotation
- property reads/writes
- calls
- encoded and direct binary operators
- unary operators
- arrays / objects and array append
- return / throw / pop / no-op
- unconditional jumps
- true/false conditional jumps
- nullish branches
- short-circuit branch forms used for logical `&&` / `||`

### 4. Bytecode + CFG lifting

The decoded instruction orientation is inferred automatically, then stack values and VM locals are lifted back into JavaScript expressions. For branch bytecode, the lifter follows the decoded jump table, forks abstract VM state, and merges verified return paths into structured conditional expressions.

The supplied Pro VM fixture currently decodes **48 bytecode words / 24 instructions**, classifies every opcode used by that program, reconstructs the protected function, and removes the ~127 KB interpreter.

### 5. Layered fallbacks

If bytecode lifting cannot safely finish a wrapper, the default fallback is direct symbolic execution at the VM wrapper boundary. Observational synthesis remains available only as an explicit API opt-in (`allowObservationalSynthesis: true`) for research/testing and is **disabled by default** so unrelated functions cannot be accepted from a small probe set.

Recovered code is compared against the live original VM wrapper on independent probes before the runtime is removed. If all wrappers cannot be verified, the original interpreter is retained. Unverified guessed source is never substituted.

### Current VM boundary

This release materially extends devirtualization beyond the one straight-line fixture, including decoded jump-table and conditional-CFG lifting. It does **not** pretend that every possible future Pro VM program is statically solved: arbitrary loops, complex exception regions, generators/async state machines, closures and previously unseen instruction families can still require another lifter implementation. Those cases fail closed and preserve the VM runtime so output is not corrupted.

## Beautification

Beautification is enabled by default for **every parseable input**, including files that do not match obfuscator.io. The formatter first uses `js-beautify` when installed and has a built-in token-aware fallback. Literal normalization and final cleanup happen before formatting, and the result is reparsed afterward.

Disable only when raw transformed source is wanted:

```bash
node src/cli.js input.js --no-format
```

## Tests

```bash
npm test
npm run test:regression
npm run test:vm
npm run test:vm-bytecode
npm run test:vm-cfg
npm run test:invalid
npm run test:shapes
npm run test:beautify
npm run test:large
npm run test:cli
npm run test:samples
```

The complete suite covers behavioral regression, VM semantic equivalence, direct decoded-bytecode lifting, conditional VM CFG reconstruction, randomized VM binding names, malformed-input preservation, recovered source shapes, beautification, large-input anti-leakage, CLI file-only output, and every file under `samples/`.

For the current corpus, 11 inputs are valid JavaScript and are transformed into valid readable JavaScript, including the newly supplied 68.6 KB Jest/Azure-style sample. `obfuscated (12).js` is an obfuscator validation-error message rather than JavaScript, and `obfuscated (14).js` is syntactically invalid in the supplied file; both are preserved and reported instead of silently repaired.

See `ARCHITECTURE.md` and `TEST_RESULTS.md` for implementation/test details.
