using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using IronBrew2.Bytecode_Library.Bytecode;
using IronBrew2.Bytecode_Library.IR;

namespace IronBrew2Deobfuscator;

internal static class LuaBytecodeWriter
{
    private static readonly Encoding LuaEncoding = Encoding.GetEncoding(28591);

    public static byte[] Write(RecoveredChunk chunk)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream);

        writer.Write((byte)0x1B);
        writer.Write(LuaEncoding.GetBytes("Lua"));
        writer.Write((byte)0x51);
        writer.Write((byte)0);
        writer.Write((byte)1);
        writer.Write((byte)4);
        writer.Write((byte)8);
        writer.Write((byte)4);
        writer.Write((byte)8);
        writer.Write((byte)0);

        WriteChunk(writer, chunk);
        return stream.ToArray();
    }

    private static void WriteChunk(BinaryWriter writer, RecoveredChunk chunk)
    {
        WriteString(writer, chunk.Name);
        writer.Write(chunk.Line);
        writer.Write(chunk.LastLine);
        writer.Write(chunk.UpvalueCount);
        writer.Write(chunk.ParameterCount);
        writer.Write(chunk.VarargFlag);
        writer.Write(chunk.StackSize);

        writer.Write(chunk.Instructions.Count);
        foreach (var instruction in chunk.Instructions)
            writer.Write(EncodeInstruction(instruction));

        writer.Write(chunk.Constants.Count);
        foreach (var constant in chunk.Constants)
            WriteConstant(writer, constant);

        writer.Write(chunk.Functions.Count);
        foreach (var function in chunk.Functions)
            WriteChunk(writer, function);

        if (chunk.Lines.Count == chunk.Instructions.Count)
        {
            writer.Write(chunk.Lines.Count);
            foreach (var line in chunk.Lines)
                writer.Write(line);
        }
        else
        {
            writer.Write(0);
        }

        writer.Write(0); // locals
        writer.Write(0); // upvalue names
    }

    private static void WriteConstant(BinaryWriter writer, RecoveredConstant constant)
    {
        switch (constant.Type)
        {
            case ConstantType.Nil:
                writer.Write((byte)0);
                break;
            case ConstantType.Boolean:
                writer.Write((byte)1);
                writer.Write((byte)((bool)(constant.Data ?? false) ? 1 : 0));
                break;
            case ConstantType.Number:
                writer.Write((byte)3);
                writer.Write(Convert.ToDouble(constant.Data));
                break;
            case ConstantType.String:
                writer.Write((byte)4);
                WriteString(writer, constant.Data?.ToString() ?? string.Empty);
                break;
            default:
                throw new InvalidOperationException($"Unsupported constant type: {constant.Type}");
        }
    }

    private static void WriteString(BinaryWriter writer, string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            writer.Write(0L);
            return;
        }

        var bytes = LuaEncoding.GetBytes(value);
        writer.Write((long)bytes.Length + 1L);
        writer.Write(bytes);
        writer.Write((byte)0);
    }

    private static uint EncodeInstruction(RecoveredInstruction instruction)
    {
        var opcode = instruction.OpCode ?? Opcode.Move;
        if ((int)opcode > (int)Opcode.VarArg)
            opcode = Opcode.Move;

        var a = ClampField(instruction.A, 0xFF);
        var b = instruction.B;
        var c = instruction.C;

        uint result = (uint)opcode;
        result |= (uint)a << 6;

        switch (LuaInstructionType(opcode))
        {
            case InstructionType.ABx:
                result |= (uint)ClampField(b, 0x3FFFF) << 14;
                break;
            case InstructionType.AsBx:
                result |= (uint)ClampField(b + 131071, 0x3FFFF) << 14;
                break;
            default:
                result |= (uint)ClampField(c, 0x1FF) << 14;
                result |= (uint)ClampField(b, 0x1FF) << 23;
                break;
        }

        return result;
    }

    private static int ClampField(int value, int max)
    {
        if (value < 0)
            return 0;
        if (value > max)
            return max;
        return value;
    }

    public static InstructionType LuaInstructionType(Opcode opcode) =>
        opcode switch
        {
            Opcode.LoadConst or Opcode.GetGlobal or Opcode.SetGlobal or Opcode.Closure => InstructionType.ABx,
            Opcode.Jmp or Opcode.ForLoop or Opcode.ForPrep => InstructionType.AsBx,
            _ => InstructionType.ABC
        };
}
