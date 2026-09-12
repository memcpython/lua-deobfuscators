using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using IronBrew2.Bytecode_Library.IR;

namespace IronBrew2Deobfuscator;

internal static class CustomChunkReader
{
    public const int RawNumberXorKey = -1;

    private const int MaxConstants = 250_000;
    private const int MaxInstructions = 1_000_000;
    private const int MaxFunctions = 50_000;

    private static readonly IReadOnlyList<IReadOnlyList<ChunkStepKind>> StepOrders = BuildStepOrders();
    private static readonly IReadOnlyList<IReadOnlyDictionary<byte, ConstantType>> ConstantTypeMaps = BuildConstantTypeMaps();
    private static readonly IReadOnlyList<int> AllNumberXorKeys = new[] { RawNumberXorKey }.Concat(Enumerable.Range(0, 256)).ToArray();
    private static readonly Encoding LuaEncoding = Encoding.GetEncoding(28591);

    public static IReadOnlyList<ParseCandidate> RecoverCandidates(
        byte[] payload,
        int limit = 8,
        IReadOnlyList<int>? numberXorKeys = null)
    {
        var results = new List<ParseCandidate>();
        var keys = numberXorKeys is { Count: > 0 } ? numberXorKeys : AllNumberXorKeys;

        for (var xorKey = 0; xorKey < 256; xorKey++)
        {
            var bytes = Xor(payload, (byte)xorKey);
            if (bytes.Length < 8)
                continue;

            var constCount = BitConverter.ToInt32(bytes, 0);
            if (constCount is < 0 or > MaxConstants)
                continue;

            foreach (var typeMap in ConstantTypeMaps)
            {
                foreach (var order in StepOrders)
                {
                    var reader = new ByteCursor(bytes);
                    if (!TryReadChunk(reader, order, typeMap, out var chunk))
                        continue;

                    if (reader.Position != bytes.Length)
                        continue;

                    if (!Validate(chunk))
                        continue;

                    var (numberXorKey, numberScore) = SelectNumberXorKey(chunk, keys);
                    ApplyNumberXorKey(chunk, numberXorKey);

                    results.Add(new ParseCandidate
                    {
                        PrimaryXorKey = (byte)xorKey,
                        NumberXorKey = numberXorKey,
                        NumberScore = numberScore,
                        ConstantTypes = new Dictionary<byte, ConstantType>(typeMap),
                        StepOrder = order.ToList(),
                        Chunk = chunk,
                        InstructionCount = CountInstructions(chunk),
                        MaxVirtualOpcode = MaxVirtualOpcode(chunk)
                    });

                    if (results.Count >= limit * 8)
                        return results
                            .OrderByDescending(r => r.InstructionCount)
                            .ThenBy(r => r.NumberScore)
                            .ThenBy(r => r.PrimaryXorKey)
                            .ThenBy(r => r.NumberXorKey)
                            .Take(limit)
                            .ToList();
                }
            }
        }

        return results
            .OrderByDescending(r => r.InstructionCount)
            .ThenBy(r => r.NumberScore)
            .ThenBy(r => r.PrimaryXorKey)
            .ThenBy(r => r.NumberXorKey)
            .Take(limit)
            .ToList();
    }

    private static bool TryReadChunk(
        ByteCursor reader,
        IReadOnlyList<ChunkStepKind> order,
        IReadOnlyDictionary<byte, ConstantType> constantTypes,
        out RecoveredChunk chunk)
    {
        chunk = new RecoveredChunk();
        try
        {
            var constantCount = reader.ReadInt32();
            if (constantCount is < 0 or > MaxConstants)
                return false;

            for (var i = 0; i < constantCount; i++)
            {
                var typeId = reader.ReadByte();
                if (!constantTypes.TryGetValue(typeId, out var type))
                    return false;

                object? data = null;
                switch (type)
                {
                    case ConstantType.Nil:
                        break;
                    case ConstantType.Boolean:
                        data = reader.ReadByte() != 0;
                        break;
                    case ConstantType.Number:
                    {
                        var encoded = reader.ReadBytes(8);
                        data = DecodeNumber(encoded, RawNumberXorKey);
                        chunk.Constants.Add(new RecoveredConstant { Type = type, Data = data, EncodedNumberBytes = encoded });
                        continue;
                    }
                    case ConstantType.String:
                    {
                        var length = reader.ReadInt32();
                        if (length < 0 || length > reader.Remaining)
                            return false;

                        data = LuaEncoding.GetString(reader.ReadBytes(length));
                        break;
                    }
                    default:
                        return false;
                }

                chunk.Constants.Add(new RecoveredConstant { Type = type, Data = data });
            }

            foreach (var step in order)
            {
                switch (step)
                {
                    case ChunkStepKind.ParameterCount:
                        chunk.ParameterCount = reader.ReadByte();
                        break;
                    case ChunkStepKind.Instructions:
                    {
                        var instructionCount = reader.ReadInt32();
                        if (instructionCount is < 0 or > MaxInstructions)
                            return false;

                        for (var pc = 0; pc < instructionCount; pc++)
                        {
                            var descriptor = reader.ReadByte();
                            if ((descriptor & 1) == 1)
                            {
                                chunk.Instructions.Add(new RecoveredInstruction
                                {
                                    Pc = pc,
                                    IsData = true,
                                    EncodedType = InstructionType.Data,
                                    LuaType = InstructionType.ABC
                                });
                                continue;
                            }

                            var type = (InstructionType)((descriptor >> 1) & 0x3);
                            if (type is < InstructionType.ABC or > InstructionType.AsBxC)
                                return false;

                            var instruction = new RecoveredInstruction
                            {
                                Pc = pc,
                                EncodedType = type,
                                LuaType = type,
                                ConstantMask = (InstructionConstantMask)((descriptor >> 3) & 0x7),
                                VirtualOpcode = reader.ReadUInt16(),
                                A = reader.ReadUInt16()
                            };

                            switch (type)
                            {
                                case InstructionType.ABC:
                                    instruction.B = reader.ReadUInt16();
                                    instruction.C = reader.ReadUInt16();
                                    break;
                                case InstructionType.ABx:
                                    instruction.B = reader.ReadInt32();
                                    instruction.C = -1;
                                    break;
                                case InstructionType.AsBx:
                                    instruction.B = reader.ReadInt32() - (1 << 16);
                                    instruction.C = -1;
                                    break;
                                case InstructionType.AsBxC:
                                    instruction.B = reader.ReadInt32() - (1 << 16);
                                    instruction.C = reader.ReadUInt16();
                                    break;
                            }

                            chunk.Instructions.Add(instruction);
                        }

                        break;
                    }
                    case ChunkStepKind.Functions:
                    {
                        var functionCount = reader.ReadInt32();
                        if (functionCount is < 0 or > MaxFunctions)
                            return false;

                        for (var i = 0; i < functionCount; i++)
                        {
                            if (!TryReadChunk(reader, order, constantTypes, out var function))
                                return false;
                            chunk.Functions.Add(function);
                        }

                        break;
                    }
                    case ChunkStepKind.LineInfo:
                    {
                        var lineCount = reader.ReadInt32();
                        if (lineCount < 0 || lineCount > Math.Max(chunk.Instructions.Count, 1_000_000))
                            return false;

                        for (var i = 0; i < lineCount; i++)
                            chunk.Lines.Add(reader.ReadInt32());
                        break;
                    }
                }
            }

            return true;
        }
        catch
        {
            chunk = new RecoveredChunk();
            return false;
        }
    }

    private static bool Validate(RecoveredChunk chunk)
    {
        if (chunk.Instructions.Count == 0)
            return false;

        if (chunk.ParameterCount > 250)
            return false;

        if (chunk.Instructions.Any(i => !i.IsData && (i.VirtualOpcode < 0 || i.VirtualOpcode > 20_000)))
            return false;

        foreach (var function in chunk.Functions)
            if (!Validate(function))
                return false;

        return true;
    }

    private static int CountInstructions(RecoveredChunk chunk) =>
        chunk.Instructions.Count + chunk.Functions.Sum(CountInstructions);

    private static int MaxVirtualOpcode(RecoveredChunk chunk)
    {
        var local = chunk.Instructions.Where(i => !i.IsData).Select(i => i.VirtualOpcode).DefaultIfEmpty(0).Max();
        foreach (var function in chunk.Functions)
            local = Math.Max(local, MaxVirtualOpcode(function));

        return local;
    }

    private static (int Key, double Score) SelectNumberXorKey(RecoveredChunk chunk, IReadOnlyList<int> keys)
    {
        var numbers = EncodedNumbers(chunk).ToList();
        if (numbers.Count == 0)
            return (0, 0);

        var bestKey = keys[0];
        var bestScore = double.PositiveInfinity;
        foreach (var key in keys)
        {
            var score = 0.0;
            foreach (var encoded in numbers)
                score += ScoreNumber(DecodeNumber(encoded, key));

            if (key >= 0)
                score += 0.01;

            if (score >= bestScore)
                continue;

            bestScore = score;
            bestKey = key;
        }

        return (bestKey, bestScore);
    }

    private static IEnumerable<byte[]> EncodedNumbers(RecoveredChunk chunk)
    {
        foreach (var constant in chunk.Constants)
            if (constant.Type == ConstantType.Number && constant.EncodedNumberBytes != null)
                yield return constant.EncodedNumberBytes;

        foreach (var function in chunk.Functions)
        foreach (var encoded in EncodedNumbers(function))
            yield return encoded;
    }

    private static void ApplyNumberXorKey(RecoveredChunk chunk, int key)
    {
        foreach (var constant in chunk.Constants)
            if (constant.Type == ConstantType.Number && constant.EncodedNumberBytes != null)
                constant.Data = DecodeNumber(constant.EncodedNumberBytes, key);

        foreach (var function in chunk.Functions)
            ApplyNumberXorKey(function, key);
    }

    private static double DecodeNumber(byte[] encoded, int key)
    {
        if (key == RawNumberXorKey)
            return BitConverter.ToDouble(encoded, 0);

        var bytes = new byte[encoded.Length];
        Buffer.BlockCopy(encoded, 0, bytes, 0, encoded.Length);
        for (var i = 0; i < bytes.Length; i++)
            bytes[i] ^= (byte)((key + i) % 256);

        return BitConverter.ToDouble(bytes, 0);
    }

    private static double ScoreNumber(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value))
            return 1_000_000;

        if (value == 0)
            return -8;

        var abs = Math.Abs(value);
        var score = 0.0;
        if (abs < 1e-9)
            score += 500 + Math.Abs(Math.Log10(abs));
        else if (abs > 1e15)
            score += 500 + Math.Log10(abs);
        else if (abs > 1e10)
            score += 50 + Math.Log10(abs);

        var nearest = Math.Round(value);
        if (Math.Abs(value - nearest) < 1e-9 && Math.Abs(nearest) < 1e12)
        {
            score -= 4;
            if (Math.Abs(nearest) <= 4096)
                score -= 2;
            if (IsCommonVmNumber(nearest))
                score -= 4;
        }
        else
        {
            score += 2;
            if (abs > 1e6)
                score += Math.Log10(abs) - 4;
        }

        return score;
    }

    private static bool IsCommonVmNumber(double value) =>
        value is 1 or 2 or 3 or 4 or 5 or 8 or 16 or 20 or 21 or 31 or 32 or 36 or 52 or 193 or 255 or 256 or 1023 or 2047 or 65536 or 16777216;

    private static byte[] Xor(byte[] input, byte key)
    {
        var output = new byte[input.Length];
        for (var i = 0; i < input.Length; i++)
            output[i] = (byte)(input[i] ^ key);

        return output;
    }

    private static IReadOnlyList<IReadOnlyDictionary<byte, ConstantType>> BuildConstantTypeMaps()
    {
        var result = new List<IReadOnlyDictionary<byte, ConstantType>>();
        var ids = new byte[] { 0, 1, 2, 3 };
        var types = new[] { ConstantType.Nil, ConstantType.Boolean, ConstantType.Number, ConstantType.String };

        foreach (var permutation in Permute(ids))
        {
            var map = new Dictionary<byte, ConstantType>();
            for (var i = 0; i < permutation.Count; i++)
                map[permutation[i]] = types[i];
            result.Add(map);
        }

        return result;
    }

    private static IReadOnlyList<IReadOnlyList<ChunkStepKind>> BuildStepOrders()
    {
        var result = new List<IReadOnlyList<ChunkStepKind>>();
        var required = new[] { ChunkStepKind.ParameterCount, ChunkStepKind.Instructions, ChunkStepKind.Functions };
        result.AddRange(Permute(required).Select(p => (IReadOnlyList<ChunkStepKind>)p));

        var withLines = new[]
        {
            ChunkStepKind.ParameterCount,
            ChunkStepKind.Instructions,
            ChunkStepKind.Functions,
            ChunkStepKind.LineInfo
        };
        result.AddRange(Permute(withLines).Select(p => (IReadOnlyList<ChunkStepKind>)p));
        return result;
    }

    private static IReadOnlyList<IReadOnlyList<T>> Permute<T>(IReadOnlyList<T> items)
    {
        var result = new List<IReadOnlyList<T>>();
        var used = new bool[items.Count];
        var current = new List<T>();

        void Walk()
        {
            if (current.Count == items.Count)
            {
                result.Add(current.ToList());
                return;
            }

            for (var i = 0; i < items.Count; i++)
            {
                if (used[i])
                    continue;

                used[i] = true;
                current.Add(items[i]);
                Walk();
                current.RemoveAt(current.Count - 1);
                used[i] = false;
            }
        }

        Walk();
        return result;
    }

    private sealed class ByteCursor
    {
        private readonly byte[] _bytes;

        public ByteCursor(byte[] bytes) => _bytes = bytes;

        public int Position { get; private set; }
        public int Remaining => _bytes.Length - Position;

        public byte ReadByte()
        {
            Ensure(1);
            return _bytes[Position++];
        }

        public byte[] ReadBytes(int count)
        {
            Ensure(count);
            var output = new byte[count];
            Buffer.BlockCopy(_bytes, Position, output, 0, count);
            Position += count;
            return output;
        }

        public int ReadUInt16()
        {
            Ensure(2);
            var value = _bytes[Position] | (_bytes[Position + 1] << 8);
            Position += 2;
            return value;
        }

        public int ReadInt32()
        {
            Ensure(4);
            var value = BitConverter.ToInt32(_bytes, Position);
            Position += 4;
            return value;
        }

        public double ReadDouble()
        {
            Ensure(8);
            var value = BitConverter.ToDouble(_bytes, Position);
            Position += 8;
            return value;
        }

        private void Ensure(int count)
        {
            if (count < 0 || Remaining < count)
                throw new InvalidOperationException("Unexpected end of bytecode payload.");
        }
    }
}
