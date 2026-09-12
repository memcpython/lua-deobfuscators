using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace IronBrew2Deobfuscator;

internal static class Program
{
    private static Encoding LuaEncoding => Encoding.GetEncoding(28591);

    private static int Main(string[] args)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        if (args.Length is 0 or > 2)
        {
            PrintUsage();
            return 1;
        }

        var input = Path.GetFullPath(args[0]);
        if (!File.Exists(input) && !Directory.Exists(input))
        {
            Console.Error.WriteLine("Input file or directory does not exist: " + input);
            return 1;
        }

        var outputRoot = args.Length == 2
            ? Path.GetFullPath(args[1])
            : Path.Combine(File.Exists(input) ? Path.GetDirectoryName(input)! : input, "deobfuscated");

        Directory.CreateDirectory(outputRoot);

        var files = File.Exists(input)
            ? new[] { input }
            : Directory.GetFiles(input, "*.lua", SearchOption.TopDirectoryOnly);

        var failures = 0;
        foreach (var file in files)
        {
            try
            {
                ProcessFile(file, outputRoot);
            }
            catch (Exception ex)
            {
                failures++;
                Console.Error.WriteLine($"[FAIL] {Path.GetFileName(file)}: {ex.Message}");
            }
        }

        return failures == 0 ? 0 : 2;
    }

    private static void ProcessFile(string file, string outputRoot)
    {
        Console.WriteLine("[*] " + Path.GetFileName(file));
        var source = File.ReadAllText(file, LuaEncoding);
        var payloads = PayloadExtractor.Extract(source);
        if (payloads.Count == 0)
            throw new InvalidOperationException("No IronBrew bytecode payload candidate was found.");

        var numberXorKeys = DetectNumberXorKeys(source);
        Exception? lastError = null;
        ParseCandidate? bestParse = null;
        DevirtualizationResult? bestResult = null;
        int bestScore = int.MaxValue;
        foreach (var payload in payloads)
        {
            IReadOnlyList<ParseCandidate> parseCandidates;
            try
            {
                parseCandidates = CustomChunkReader.RecoverCandidates(payload.Bytes, limit: 12, numberXorKeys);
            }
            catch (Exception ex)
            {
                lastError = ex;
                continue;
            }

            foreach (var parse in parseCandidates)
            {
                try
                {
                    var dispatch = DispatchParser.Parse(source, parse.MaxVirtualOpcode);
                    if (Environment.GetEnvironmentVariable("IB2_DEBUG_DISPATCH") == "1")
                        Console.WriteLine($"    debug: maxvop={parse.MaxVirtualOpcode}, bodies={dispatch.Bodies.Count}, enum={dispatch.EnumVar}, inst={dispatch.InstVar}");
                    var handlers = new OpcodeClassifier(dispatch).Classify();
                    var used = UsedVirtualOpcodes(parse.Chunk).ToList();
                    var result = new Devirtualizer(handlers).Devirtualize(parse.Chunk);
                    var missing = used.Where(v => !handlers.TryGetValue(v, out var h) || h.IsUnknown).Distinct().OrderBy(v => v).ToList();
                    if (missing.Count > 0)
                        result.Warnings.Add("Unclassified virtual opcodes used by payload: " + string.Join(", ", missing.Take(32)));

                    var score = StructuralWarningScore(result);
                    if (score < bestScore)
                    {
                        bestScore = score;
                        bestParse = parse;
                        bestResult = result;
                    }

                    if (score == 0)
                    {
                        WriteSuccess(file, outputRoot, parse, result, handlers.Count);
                        return;
                    }
                }
                catch (Exception ex)
                {
                    lastError = ex;
                }
            }
        }

        if (bestParse != null && bestResult != null)
        {
            WriteSuccess(file, outputRoot, bestParse, bestResult, bestResult.Handlers.Count);
            return;
        }

        throw new InvalidOperationException(lastError?.Message ?? "Payload extraction succeeded, but no parse candidate devirtualized cleanly.");
    }

    private static void WriteSuccess(string file, string outputRoot, ParseCandidate parse, DevirtualizationResult result, int handlerCount)
    {
        var decompile = WriteOutputs(file, outputRoot, parse, result);
        Console.WriteLine($"    ok: {parse.InstructionCount} instructions, xor={parse.PrimaryXorKey}, numxor={NumberXorLabel(parse.NumberXorKey)}, handlers={handlerCount}");
        Console.WriteLine(decompile.Succeeded
            ? $"    source: {(decompile.Partial ? "partial unluac" : "unluac")} -> {Path.GetFileNameWithoutExtension(file)}_deobfuscated.lua"
            : $"    source: IR fallback -> {Path.GetFileNameWithoutExtension(file)}_deobfuscated.lua");

        foreach (var warning in result.Warnings.Take(8))
            Console.WriteLine("    warn: " + warning);
        if (result.Warnings.Count > 8)
            Console.WriteLine($"    warn: {result.Warnings.Count - 8} more warnings in the disassembly/map sidecars.");
    }

    private static IReadOnlyList<int>? DetectNumberXorKeys(string source)
    {
        if (source.Contains("discord.gg/25ms", StringComparison.OrdinalIgnoreCase) ||
            source.Contains("obfuscation: ib2 fork", StringComparison.OrdinalIgnoreCase) ||
            source.Contains("local function M()local e=l();local l=l();local P=1;local A=(n(l,1,20)*(2^32))+e", StringComparison.Ordinal))
            return new[] { CustomChunkReader.RawNumberXorKey };

        return null;
    }

    private static string NumberXorLabel(int key) =>
        key == CustomChunkReader.RawNumberXorKey ? "raw" : key.ToString();

    private static int StructuralWarningScore(DevirtualizationResult result)
    {
        return result.Warnings.Count(w =>
            !w.Contains("custom VM-only opcode", StringComparison.Ordinal) &&
            !w.StartsWith("Unclassified virtual opcodes", StringComparison.Ordinal));
    }

    private static DecompileResult WriteOutputs(string inputFile, string outputRoot, ParseCandidate parse, DevirtualizationResult result)
    {
        var stem = Path.GetFileNameWithoutExtension(inputFile);
        var luacPath = Path.Combine(outputRoot, stem + ".luac");
        var sourcePath = Path.Combine(outputRoot, stem + "_deobfuscated.lua");
        var disasmPath = Path.Combine(outputRoot, stem + ".disasm.txt");
        var mapPath = Path.Combine(outputRoot, stem + ".map.txt");
        var decompilerLogPath = Path.Combine(outputRoot, stem + ".decompiler.txt");

        File.WriteAllBytes(luacPath, LuaBytecodeWriter.Write(result.Chunk));
        var decompile = ExternalDecompiler.Create().Decompile(luacPath, sourcePath);
        if (decompile.Succeeded)
        {
            if (!string.IsNullOrWhiteSpace(decompile.Message))
                File.WriteAllText(decompilerLogPath, decompile.Message, LuaEncoding);
            else if (File.Exists(decompilerLogPath))
                File.Delete(decompilerLogPath);
        }
        else
        {
            File.WriteAllText(
                sourcePath,
                RecoveredSourceEmitter.Emit(result.Chunk, Path.GetFileName(inputFile), decompile.Message),
                LuaEncoding);
            File.WriteAllText(decompilerLogPath, decompile.Message, LuaEncoding);
        }

        var disasm = new StringBuilder();
        disasm.AppendLine("; Source: " + inputFile);
        disasm.AppendLine("; Unknown placeholders: " + result.UnknownInstructionCount);
        disasm.AppendLine("; Unsupported custom placeholders: " + result.UnsupportedCustomInstructionCount);
        if (result.Warnings.Count > 0)
        {
            disasm.AppendLine("; Warnings:");
            foreach (var warning in result.Warnings)
                disasm.AppendLine(";   " + warning);
        }

        disasm.AppendLine();
        disasm.Append(Disassembler.WriteDisassembly(result.Chunk));
        File.WriteAllText(disasmPath, disasm.ToString(), LuaEncoding);
        File.WriteAllText(mapPath, Disassembler.WriteMap(result.Handlers, parse), LuaEncoding);
        return decompile;
    }

    private static IEnumerable<int> UsedVirtualOpcodes(RecoveredChunk chunk)
    {
        foreach (var instruction in chunk.Instructions)
            if (!instruction.IsData)
                yield return instruction.VirtualOpcode;

        foreach (var function in chunk.Functions)
        foreach (var value in UsedVirtualOpcodes(function))
            yield return value;
    }

    private static void PrintUsage()
    {
        Console.WriteLine("Usage: IronBrew2Deobfuscator <input.lua | input-directory> [output-directory]");
        Console.WriteLine("Outputs one _deobfuscated.lua, .luac, .disasm.txt, and .map.txt per input script.");
    }
}
