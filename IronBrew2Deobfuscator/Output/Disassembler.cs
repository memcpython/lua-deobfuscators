using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using IronBrew2.Bytecode_Library.Bytecode;
using IronBrew2.Bytecode_Library.IR;

namespace IronBrew2Deobfuscator;

internal static class Disassembler
{
    public static string WriteDisassembly(RecoveredChunk chunk)
    {
        var sb = new StringBuilder();
        WriteChunk(sb, chunk, "root", 0);
        return sb.ToString();
    }

    public static string WriteMap(Dictionary<int, HandlerInfo> handlers, ParseCandidate parse)
    {
        var sb = new StringBuilder();
        sb.AppendLine("IronBrew2 deobfuscation map");
        sb.AppendLine("Primary XOR key: " + parse.PrimaryXorKey.ToString(CultureInfo.InvariantCulture));
        sb.AppendLine("Number XOR key: " + (parse.NumberXorKey == CustomChunkReader.RawNumberXorKey
            ? "raw"
            : parse.NumberXorKey.ToString(CultureInfo.InvariantCulture)));
        sb.AppendLine("Number score: " + parse.NumberScore.ToString("R", CultureInfo.InvariantCulture));
        sb.AppendLine("Chunk order: " + string.Join(", ", parse.StepOrder));
        sb.AppendLine("Constant type IDs:");
        foreach (var pair in parse.ConstantTypes.OrderBy(p => p.Key))
            sb.AppendLine($"  {pair.Key} => {pair.Value}");

        sb.AppendLine();
        sb.AppendLine("Virtual opcodes:");
        foreach (var (index, handler) in handlers.OrderBy(p => p.Key))
        {
            if (handler.IsSuper)
                sb.AppendLine($"  {index:D4}: SUPER({string.Join(", ", handler.SuperSequence!.Select(c => c.Name))})");
            else if (handler.Basic != null)
                sb.AppendLine($"  {index:D4}: {handler.Basic.Name}");
            else
                sb.AppendLine($"  {index:D4}: <unknown> {Trim(handler.Body)}");
        }

        return sb.ToString();
    }

    private static string Trim(string value)
    {
        value = value.Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
        return value.Length <= 240 ? value : value[..240] + "...";
    }

    private static void WriteChunk(StringBuilder sb, RecoveredChunk chunk, string name, int indent)
    {
        var pad = new string(' ', indent);
        sb.AppendLine($"{pad}.function {name} params={chunk.ParameterCount} upvalues={chunk.UpvalueCount} stack={chunk.StackSize} vararg={chunk.VarargFlag}");

        if (chunk.Constants.Count > 0)
        {
            sb.AppendLine($"{pad}.constants");
            for (var i = 0; i < chunk.Constants.Count; i++)
                sb.AppendLine($"{pad}  [{i}] {FormatConstant(chunk.Constants[i])}");
        }

        sb.AppendLine($"{pad}.code");
        for (var i = 0; i < chunk.Instructions.Count; i++)
        {
            var instruction = chunk.Instructions[i];
            var opcode = instruction.OpCode?.ToString() ?? "<null>";
            var handler = string.IsNullOrEmpty(instruction.HandlerName) ? string.Empty : $" ; {instruction.HandlerName} v{instruction.VirtualOpcode}";
            sb.AppendLine($"{pad}  {i:D5}: {opcode,-10} {instruction.A,4} {instruction.B,6} {instruction.C,6}{handler}");
        }

        for (var i = 0; i < chunk.Functions.Count; i++)
        {
            sb.AppendLine();
            WriteChunk(sb, chunk.Functions[i], $"{name}.{i}", indent + 2);
        }

        sb.AppendLine($"{pad}.end");
    }

    private static string FormatConstant(RecoveredConstant constant)
    {
        return constant.Type switch
        {
            ConstantType.Nil => "nil",
            ConstantType.Boolean => ((bool)(constant.Data ?? false)).ToString().ToLowerInvariant(),
            ConstantType.Number => Convert.ToDouble(constant.Data).ToString("R", CultureInfo.InvariantCulture),
            ConstantType.String => QuoteString(constant.Data?.ToString() ?? string.Empty),
            _ => "<unknown>"
        };
    }

    private static string QuoteString(string value)
    {
        const int max = 120;
        var trimmed = value.Length > max ? value[..max] + "..." : value;
        return "\"" + trimmed
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal)
            .Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal) + "\"";
    }
}
