using System.Text;
using HerculesDeobfuscator.Model;

namespace HerculesDeobfuscator.Emit;

public static class Lua51ChunkWriter
{
    public static byte[] Write(HerculesChunk root, string sourceName)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.Latin1, true);
        writer.Write(new byte[] { 0x1B, (byte)'L', (byte)'u', (byte)'a' });
        writer.Write((byte)0x51);
        writer.Write((byte)0);
        writer.Write((byte)1);
        writer.Write((byte)4);
        writer.Write((byte)8);
        writer.Write((byte)4);
        writer.Write((byte)8);
        writer.Write((byte)0);
        WriteChunk(writer, root, Encoding.Latin1.GetBytes(sourceName), true);
        writer.Flush();
        return stream.ToArray();
    }

    private static void WriteChunk(
        BinaryWriter writer,
        HerculesChunk chunk,
        byte[] sourceName,
        bool writeSource)
    {
        WriteString(writer, writeSource ? sourceName : null);
        writer.Write(0);
        writer.Write(0);
        writer.Write(chunk.UpvalueCount);
        writer.Write(chunk.ParameterCount);
        writer.Write((byte)(chunk.Instructions.Any(instruction => instruction.Opcode == 37) ? 2 : 0));
        writer.Write(chunk.MaximumStack);

        writer.Write(chunk.Instructions.Count);
        foreach (var instruction in chunk.Instructions)
        {
            writer.Write(instruction.Value);
        }

        writer.Write(chunk.Constants.Count);
        foreach (var constant in chunk.Constants)
        {
            switch (constant.Kind)
            {
                case HerculesConstantKind.Nil:
                    writer.Write((byte)0);
                    break;
                case HerculesConstantKind.Boolean:
                    writer.Write((byte)1);
                    writer.Write((byte)(constant.Boolean ? 1 : 0));
                    break;
                case HerculesConstantKind.Number:
                    writer.Write((byte)3);
                    writer.Write(constant.Number);
                    break;
                case HerculesConstantKind.String:
                    writer.Write((byte)4);
                    WriteString(writer, constant.Bytes ?? []);
                    break;
            }
        }

        writer.Write(chunk.Prototypes.Count);
        foreach (var prototype in chunk.Prototypes)
        {
            WriteChunk(writer, prototype, sourceName, false);
        }

        writer.Write(0);
        writer.Write(0);
        writer.Write(0);
    }

    private static void WriteString(BinaryWriter writer, byte[]? bytes)
    {
        if (bytes is null)
        {
            writer.Write(0L);
            return;
        }
        writer.Write((long)bytes.Length + 1);
        writer.Write(bytes);
        writer.Write((byte)0);
    }
}
