# XHider Deobfuscator

Static C# source recovery for XHider v1.2.

The tool:

- decodes the keyed XHD base85 string container
- extracts the embedded VM image
- decodes functions, instructions, and typed constants
- identifies randomized opcodes from their handler semantics
- reconstructs lexical locals and closure captures without emitted environment tables
- inlines lifted closure helpers into normal nested Lua functions
- removes the injected XHider startup scaffold from its decoded instruction structure
- symbolically lifts VM operations into Lua expressions, calls, closures, and tables
- reconstructs forward conditionals, numeric and generic `for` loops, and backward-edge `while` loops
- emits source without executing the protected payload

Build:

```powershell
dotnet build src\XHiderDeobfuscator.csproj -c Release
```

Run:

```powershell
src\bin\Release\net8.0\XHiderDeobfuscator.exe samples\1086289726236654.lua output.lua
```

The process exits with code `3` if an instruction uses a handler whose semantics were not recognized. The supplied 18-file corpus, including `nonworking1.lua`, decodes with zero unknown instructions, and every generated file passes `luac -p`.
