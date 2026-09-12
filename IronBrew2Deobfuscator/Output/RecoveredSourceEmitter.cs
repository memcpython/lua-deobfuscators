using System;
using System.Globalization;
using System.Linq;
using System.Text;
using IronBrew2.Bytecode_Library.Bytecode;
using IronBrew2.Bytecode_Library.IR;

namespace IronBrew2Deobfuscator;

internal static class RecoveredSourceEmitter
{
    public static string Emit(RecoveredChunk chunk, string inputName, string reason)
    {
        var sb = new StringBuilder();
        sb.AppendLine("-- IronBrew2 recovered source fallback");
        sb.AppendLine("-- Input: " + inputName);
        if (!string.IsNullOrWhiteSpace(reason))
            sb.AppendLine("-- Decompiler unavailable/error: " + reason.ReplaceLineEndings(" "));
        sb.AppendLine("-- This file is generated from recovered VM IR. Prefer unluac output when available.");
        sb.AppendLine();
        WriteChunk(sb, chunk, "main", 0);
        return sb.ToString();
    }

    private static void WriteChunk(StringBuilder sb, RecoveredChunk chunk, string name, int indent)
    {
        var pad = new string(' ', indent);
        if (name == "main")
        {
            sb.AppendLine("-- constants: " + chunk.Constants.Count);
        }
        else
        {
            sb.AppendLine($"{pad}local function {name}({Parameters(chunk.ParameterCount)})");
            pad += "  ";
        }

        for (var i = 0; i < chunk.Functions.Count; i++)
            WriteChunk(sb, chunk.Functions[i], $"proto_{indent}_{i}", name == "main" ? indent : indent + 2);

        for (var pc = 0; pc < chunk.Instructions.Count; pc++)
        {
            var instruction = chunk.Instructions[pc];
            var comment = $"-- [{pc:D5}] {instruction.OpCode} {instruction.A} {instruction.B} {instruction.C}";
            sb.AppendLine(pad + EmitInstruction(instruction).PadRight(42) + " " + comment);
        }

        if (name != "main")
            sb.AppendLine(new string(' ', indent) + "end");
    }

    private static string EmitInstruction(RecoveredInstruction instruction)
    {
        static string R(int register) => "r" + register.ToString(CultureInfo.InvariantCulture);
        string K(int index) => "k" + index.ToString(CultureInfo.InvariantCulture);
        string Rk(int value) => value >= 256 ? K(value - 256) : R(value);

        return instruction.OpCode switch
        {
            Opcode.Move => $"{R(instruction.A)} = {R(instruction.B)}",
            Opcode.LoadConst => $"{R(instruction.A)} = {K(instruction.B)}",
            Opcode.LoadBool => $"{R(instruction.A)} = {(instruction.B != 0 ? "true" : "false")}",
            Opcode.LoadNil => $"for i = {instruction.A}, {instruction.B} do r[i] = nil end",
            Opcode.GetGlobal => $"{R(instruction.A)} = _ENV[{K(instruction.B)}]",
            Opcode.SetGlobal => $"_ENV[{K(instruction.B)}] = {R(instruction.A)}",
            Opcode.GetTable => $"{R(instruction.A)} = {R(instruction.B)}[{Rk(instruction.C)}]",
            Opcode.SetTable => $"{R(instruction.A)}[{Rk(instruction.B)}] = {Rk(instruction.C)}",
            Opcode.NewTable => $"{R(instruction.A)} = {{}}",
            Opcode.Self => $"{R(instruction.A + 1)} = {R(instruction.B)}; {R(instruction.A)} = {R(instruction.B)}[{Rk(instruction.C)}]",
            Opcode.Add => $"{R(instruction.A)} = {Rk(instruction.B)} + {Rk(instruction.C)}",
            Opcode.Sub => $"{R(instruction.A)} = {Rk(instruction.B)} - {Rk(instruction.C)}",
            Opcode.Mul => $"{R(instruction.A)} = {Rk(instruction.B)} * {Rk(instruction.C)}",
            Opcode.Div => $"{R(instruction.A)} = {Rk(instruction.B)} / {Rk(instruction.C)}",
            Opcode.Mod => $"{R(instruction.A)} = {Rk(instruction.B)} % {Rk(instruction.C)}",
            Opcode.Pow => $"{R(instruction.A)} = {Rk(instruction.B)} ^ {Rk(instruction.C)}",
            Opcode.Unm => $"{R(instruction.A)} = -{R(instruction.B)}",
            Opcode.Not => $"{R(instruction.A)} = not {R(instruction.B)}",
            Opcode.Len => $"{R(instruction.A)} = #{R(instruction.B)}",
            Opcode.Concat => $"{R(instruction.A)} = concat({instruction.B}, {instruction.C})",
            Opcode.Jmp => $"-- jump to {instruction.Pc + instruction.B + 1}",
            Opcode.Eq => $"-- if ({Rk(instruction.B)} == {Rk(instruction.C)}) ~= {(instruction.A != 0).ToString().ToLowerInvariant()} then skip",
            Opcode.Lt => $"-- if ({Rk(instruction.B)} < {Rk(instruction.C)}) ~= {(instruction.A != 0).ToString().ToLowerInvariant()} then skip",
            Opcode.Le => $"-- if ({Rk(instruction.B)} <= {Rk(instruction.C)}) ~= {(instruction.A != 0).ToString().ToLowerInvariant()} then skip",
            Opcode.Test => $"-- test {R(instruction.A)} C={instruction.C}",
            Opcode.TestSet => $"-- testset {R(instruction.A)} = {R(instruction.B)} C={instruction.C}",
            Opcode.Call => $"{R(instruction.A)} = {R(instruction.A)}(...)",
            Opcode.TailCall => $"return {R(instruction.A)}(...)",
            Opcode.Return => instruction.B == 1 ? "return" : $"return {R(instruction.A)}",
            Opcode.ForLoop => $"-- forloop base={instruction.A} jump={instruction.Pc + instruction.B + 1}",
            Opcode.ForPrep => $"-- forprep base={instruction.A} jump={instruction.Pc + instruction.B + 1}",
            Opcode.TForLoop => $"-- tforloop base={instruction.A} count={instruction.C}",
            Opcode.SetList => $"-- setlist table={R(instruction.A)} count={instruction.B} block={instruction.C}",
            Opcode.Close => $"-- close from {R(instruction.A)}",
            Opcode.Closure => $"{R(instruction.A)} = proto_{instruction.Pc}_{instruction.B}",
            Opcode.VarArg => $"{R(instruction.A)} = ...",
            _ => "-- unsupported"
        };
    }

    private static string Parameters(byte count) =>
        string.Join(", ", Enumerable.Range(0, count).Select(i => "p" + i.ToString(CultureInfo.InvariantCulture)));
}
