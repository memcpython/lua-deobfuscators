# IronBrew2Deobfuscator

Static IronBrew 2 devirtualizer for the local IronBrew2 fork in this repository.

## Usage

```powershell
dotnet run --project .\IronBrew2Deobfuscator\IronBrew2Deobfuscator.csproj -- <input.lua | input-directory> [output-directory]
```

For every input script the tool writes:

- `_deobfuscated.lua`: recovered Lua source. The tool reconstructs Lua 5.1 bytecode, runs the bundled `tools\unluac.jar`, folds IronBrew's inlined XOR string decryptors back into plaintext string literals, reduces open-call temporary lists, and cleans common temp-register `if`, method-call, and short table-argument scaffolding. If Java or unluac is unavailable, it writes a readable recovered-source fallback instead.
- `.luac`: reconstructed Lua 5.1 bytecode where the VM-only opcodes can be represented as Lua bytecode.
- `.disasm.txt`: full recovered instruction listing, including warnings and placeholders.
- `.map.txt`: recovered payload settings and virtual opcode dispatch map.
- `.decompiler.txt`: unluac diagnostics, only when the external decompiler reports a message.

## Layout

- `Core`: shared models for payloads, chunks, opcodes, and output state.
- `Extraction`: IronBrew wrapper and encoded payload recovery.
- `Parsing`: Lua tokenizer helpers, VM dispatch parser, and IronBrew custom chunk reader.
- `Devirtualization`: virtual opcode classification and conversion back to Lua 5.1 instructions.
- `Output`: Lua bytecode writing, disassembly, unluac integration, IronBrew string decryptor folding, open-call cleanup, source fallback, and source cleanup/simplification.

IronBrew's custom inlining opcode `OpSetTop` has no vanilla Lua 5.1 opcode. The tool emits a `MOVE 0 0` placeholder in the `.luac` and preserves the exact location in the disassembly warnings. The generated `_deobfuscated.lua`, `.disasm.txt`, and `.map.txt` are the main recovery artifacts for those cases.
