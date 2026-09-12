using System.Globalization;
using System.Text.RegularExpressions;
using XHiderDeobfuscator.Model;

namespace XHiderDeobfuscator.Core;

public static partial class XHiderDecoder
{
    public static XHiderImage Decode(string source, WrapperAnalysis wrapper)
    {
        var payloadMatch = PayloadRegex().Match(source);
        if (!payloadMatch.Success)
        {
            throw new InvalidDataException("XHD payload was not found.");
        }

        var container = DecodeBase85(payloadMatch.Groups["payload"].Value, wrapper.ContainerTrim);
        var entries = DecodeReferencedStrings(source, container, wrapper);
        var vmBytes = entries
            .OrderByDescending(entry => entry.Length)
            .FirstOrDefault(entry => LooksLikeVmImage(entry))
            ?? throw new InvalidDataException("XHider VM image was not found in the string container.");

        return ParseVmImage(vmBytes);
    }

    private static IReadOnlyList<byte[]> DecodeReferencedStrings(
        string source,
        byte[] container,
        WrapperAnalysis wrapper)
    {
        var callRegex = new Regex(
            $@"\b{Regex.Escape(wrapper.StringDecoderName)}\(0x(?<offset>[0-9A-Fa-f]+)\)",
            RegexOptions.IgnoreCase);
        var entries = new List<byte[]>();

        foreach (var offset in callRegex.Matches(source)
                     .Select(match => int.Parse(
                         match.Groups["offset"].Value,
                         NumberStyles.HexNumber,
                         CultureInfo.InvariantCulture))
                     .Distinct())
        {
            if (offset < 0 || offset + 4 > container.Length)
            {
                continue;
            }

            var lengthBytes = new byte[4];
            for (var i = 0; i < 4; i++)
            {
                lengthBytes[i] = (byte)(container[offset + i] ^ wrapper.ContainerKey[i]);
            }

            var length = BitConverter.ToUInt32(lengthBytes, 0);
            if (length > int.MaxValue || offset + 4L + length > container.Length)
            {
                continue;
            }

            var value = new byte[length];
            for (var i = 0; i < value.Length; i++)
            {
                value[i] = (byte)(container[offset + 4 + i] ^ wrapper.ContainerKey[i % 4]);
            }
            entries.Add(value);
        }

        return entries;
    }

    private static byte[] DecodeBase85(string encoded, int trim)
    {
        var output = new List<byte>((encoded.Length / 5 + 1) * 4);
        for (var offset = 0; offset < encoded.Length;)
        {
            var count = Math.Min(5, encoded.Length - offset);
            long value = 0;
            for (var i = 0; i < count; i++)
            {
                value = value * 85 + encoded[offset + i] - 0x21;
            }
            for (var i = count; i < 5; i++)
            {
                value = value * 85 + 0x54;
            }

            output.Add((byte)(value / 0x1000000 % 0x100));
            output.Add((byte)(value / 0x10000 % 0x100));
            output.Add((byte)(value / 0x100 % 0x100));
            output.Add((byte)(value % 0x100));
            offset += count;
        }

        if (trim < 0 || trim > output.Count)
        {
            throw new InvalidDataException("Invalid Xhider base85 trim value.");
        }
        if (trim > 0)
        {
            output.RemoveRange(output.Count - trim, trim);
        }
        return output.ToArray();
    }

    private static bool LooksLikeVmImage(byte[] bytes)
    {
        if (bytes.Length < 16)
        {
            return false;
        }

        var functionCount = ReadUnsigned(bytes, 0, 3);
        return functionCount is > 0 and < 1024 &&
               3L + functionCount * 3 + 3 < bytes.Length;
    }

    private static XHiderImage ParseVmImage(byte[] bytes)
    {
        var cursor = 0;
        var functionCount = ReadUnsigned(bytes, cursor, 3);
        cursor += 3;
        EnsureCount(functionCount, 1024, "function");

        var functions = new List<int>(functionCount);
        for (var i = 0; i < functionCount; i++)
        {
            functions.Add(ReadUnsigned(bytes, cursor, 3));
            cursor += 3;
        }

        var constantCount = ReadUnsigned(bytes, cursor, 3);
        cursor += 3;
        EnsureCount(constantCount, 1_000_000, "constant");
        var constantOffsets = new List<int>(constantCount);
        for (var i = 0; i < constantCount; i++)
        {
            constantOffsets.Add(ReadUnsigned(bytes, cursor, 4));
            cursor += 4;
        }

        var instructionCount = ReadUnsigned(bytes, cursor, 3);
        cursor += 3;
        EnsureCount(instructionCount, 5_000_000, "instruction");
        var instructionBase = cursor;
        var constantBase = checked(instructionBase + instructionCount * 4);
        if (constantBase > bytes.Length)
        {
            throw new InvalidDataException("Xhider instruction stream exceeds the VM image.");
        }

        var instructions = new List<XHiderInstruction>(instructionCount);
        for (var index = 0; index < instructionCount; index++)
        {
            var position = instructionBase + index * 4;
            instructions.Add(new XHiderInstruction(
                index + 1,
                bytes[position],
                (ushort)ReadUnsigned(bytes, position + 1, 2),
                ReadUnsigned(bytes, position + 1, 3),
                bytes[position + 3]));
        }

        var constants = constantOffsets
            .Select(offset => DecodeConstant(bytes, checked(constantBase + offset)))
            .ToArray();
        return new XHiderImage(functions, constants, instructions);
    }

    private static XHiderConstant DecodeConstant(byte[] bytes, int position)
    {
        EnsureAvailable(bytes, position, 1);
        var type = bytes[position];
        return type switch
        {
            0 => DecodeString(bytes, position),
            1 => XHiderConstant.FromNumber(ReadUInt32(bytes, position + 1)),
            2 => XHiderConstant.FromNumber(-ReadUInt32(bytes, position + 1)),
            3 => XHiderConstant.FromNumber(DecodeDouble(bytes, position + 1)),
            _ => throw new InvalidDataException($"Unknown Xhider constant type 0x{type:X2}.")
        };
    }

    private static XHiderConstant DecodeString(byte[] bytes, int position)
    {
        var length = ReadUnsigned(bytes, position + 1, 4);
        EnsureAvailable(bytes, position + 5, length);
        var value = new byte[length];
        Buffer.BlockCopy(bytes, position + 5, value, 0, length);
        return XHiderConstant.FromString(value);
    }

    private static double DecodeDouble(byte[] bytes, int position)
    {
        EnsureAvailable(bytes, position, 8);
        var sign = bytes[position] > 0x7F ? -1d : 1d;
        long mantissa = bytes[position + 1] % 0x10;
        for (var i = 2; i < 8; i++)
        {
            mantissa = mantissa * 0x100 + bytes[position + i];
        }

        var exponent = (bytes[position] % 0x80) * 0x10 + bytes[position + 1] / 0x10;
        if (exponent == 0)
        {
            return 0;
        }

        return Math.ScaleB(Math.ScaleB(mantissa, -52) + 1, exponent - 0x3FF) * sign;
    }

    private static int ReadUnsigned(byte[] bytes, int position, int width)
    {
        EnsureAvailable(bytes, position, width);
        long value = 0;
        long multiplier = 1;
        for (var i = 0; i < width; i++)
        {
            value += bytes[position + i] * multiplier;
            if (i + 1 < width)
            {
                multiplier *= 0x100;
            }
        }
        return checked((int)value);
    }

    private static uint ReadUInt32(byte[] bytes, int position)
    {
        EnsureAvailable(bytes, position, 4);
        return (uint)(
            bytes[position] |
            bytes[position + 1] << 8 |
            bytes[position + 2] << 16 |
            bytes[position + 3] << 24);
    }

    private static void EnsureAvailable(byte[] bytes, int position, int length)
    {
        if (position < 0 || length < 0 || position + (long)length > bytes.Length)
        {
            throw new InvalidDataException("Xhider VM image is truncated.");
        }
    }

    private static void EnsureCount(int value, int maximum, string name)
    {
        if (value < 0 || value > maximum)
        {
            throw new InvalidDataException($"Invalid Xhider {name} count: {value}.");
        }
    }

    [GeneratedRegex(@"\[(?<equals>=*)\[XHD:(?<payload>.*?)\]\k<equals>\]", RegexOptions.Singleline)]
    private static partial Regex PayloadRegex();
}
