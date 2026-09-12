# luaobfuscator.com Deobfuscator

Static JavaScript deobfuscator for the common LuaObfuscator.com wrapper found in `samples/`.

It currently handles:

- LuaObfuscator XOR string decoder calls, such as `v7("\\217...", "\\126...")`
- Removal of the generated decoder prelude when it becomes unused
- LuaObfuscator VM payload decoding into recovered Lua source where possible
- Source-lift VM devirtualization fallback for larger chaotic payloads
- AST-based discovery and expansion of newer superinstruction dispatchers
- Dispatcher-free register Lua with explicit branches, numeric/generic loops, closures, varargs, and mutable upvalues
- Complete decoded VM IR safety fallback when an unknown VM cannot be lifted without dropping instructions
- Simple source recovery heuristics for common virtualized `print(...)`, numeric `print(...)`, and `loadstring(game:HttpGet(...))()` samples
- Numeric constant folding for simple arithmetic noise
- Basic Lua cleanup/line splitting for readable output
- Batch processing of `.lua` and `.txt` files

## Usage

```powershell
node src/cli.js samples --out out
```

Single file:

```powershell
node src/cli.js samples\741aeb8b85352e51.lua --out out
```

Dry-run to stdout:

```powershell
node src/cli.js samples\0054b21ea354e019.lua --stdout
```

Useful flags:

- `--no-cleanup`: only decode strings and remove the banner/prelude
- `--keep-banner`: keep the LuaObfuscator banner comment
- `--keep-decoder`: keep the XOR decoder function
- `--summary`: print transform stats for each file

The summary reports `vmOutputMode`:

- `recovered-source`: high-confidence source reconstruction
- `source-lift`: opcode semantics were known well enough for readable source lifting
- `devirtualized`: superinstructions were expanded and the VM dispatcher was replaced with executable register-level Lua
- `vm-ir`: the complete decoded instruction stream was preserved because a safe semantic lift was not available

`devirtualized` output preserves exact control flow with labels when the original payload was itself flattened. It removes the VM layer without pretending that flattened payload logic has already been reconstructed into its original source layout.

`vm-ir` output is intentionally verbose and is used only as a lossless fallback for an unrecognized VM variant.
