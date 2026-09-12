using HerculesDeobfuscator.Model;

namespace HerculesDeobfuscator.Core;

public static class HerculesDecoder
{
    private static readonly HashSet<string> LuaKeywords =
    [
        "and",
        "break",
        "do",
        "else",
        "elseif",
        "end",
        "false",
        "for",
        "function",
        "goto",
        "if",
        "in",
        "local",
        "nil",
        "not",
        "or",
        "repeat",
        "return",
        "then",
        "true",
        "until",
        "while"
    ];

    public static HerculesChunk Decode(HerculesPayload payload)
    {
        var serialized = DecodeBase94(payload.EncodedBytecode, payload.Charset);
        var bytes = RemoveDelimiters(serialized);
        var reader = new ByteReader(bytes);
        var chunk = ReadChunk(reader, 0);
        if (!reader.AtEnd)
        {
            throw new InvalidDataException("Hercules bytecode contains trailing data.");
        }
        return chunk;
    }

    private static byte[] DecodeBase94(byte[] encoded, byte[] charset)
    {
        var lookup = charset
            .Select((value, index) => (value, index))
            .ToDictionary(pair => pair.value, pair => pair.index);
        var output = new List<byte>(encoded.Length / 2);
        long number = 0;
        var hasDigit = false;

        foreach (var value in encoded.Append((byte)'_'))
        {
            if (value == (byte)'_')
            {
                if (!hasDigit || number > byte.MaxValue)
                {
                    throw new InvalidDataException("Invalid Hercules base-94 token.");
                }
                output.Add((byte)number);
                number = 0;
                hasDigit = false;
                continue;
            }
            if (!lookup.TryGetValue(value, out var digit))
            {
                throw new InvalidDataException("Invalid Hercules base-94 character.");
            }
            number = checked(number * charset.Length + digit);
            hasDigit = true;
        }
        return output.ToArray();
    }

    private static byte[] RemoveDelimiters(byte[] serialized)
    {
        if (serialized.Length % 2 != 0)
        {
            throw new InvalidDataException("Invalid Hercules serialized byte stream.");
        }
        var output = new byte[serialized.Length / 2];
        for (var index = 0; index < output.Length; index++)
        {
            output[index] = serialized[index * 2];
            if (serialized[index * 2 + 1] != (byte)'\\')
            {
                throw new InvalidDataException("Invalid Hercules byte delimiter.");
            }
        }
        return output;
    }

    private static HerculesChunk ReadChunk(ByteReader reader, int depth)
    {
        var start = reader.Position;
        var upvalues = reader.ReadByte();
        var parameters = reader.ReadByte();
        var maximumStack = reader.ReadByte();

        var instructionCount = reader.ReadCount("instruction", 10_000_000);
        Trace($"{new string(' ', depth * 2)}chunk@{start} up={upvalues} params={parameters} stack={maximumStack} instructions={instructionCount}");
        var instructions = new HerculesInstruction[instructionCount];
        for (var index = 0; index < instructionCount; index++)
        {
            var value = reader.ReadUInt32();
            var opcode = reader.ReadByte();
            var type = reader.ReadByte();
            reader.ReadUInt16();
            reader.ReadByte();
            reader.ReadByte();
            switch (type)
            {
                case 1:
                    reader.ReadUInt16();
                    reader.ReadUInt16();
                    break;
                case 2:
                case 3:
                    reader.ReadUInt32();
                    break;
                default:
                    throw new InvalidDataException($"Unknown Hercules instruction type {type}.");
            }
            instructions[index] = new HerculesInstruction(value, opcode);
        }

        var constantCount = reader.ReadCount("constant", 10_000_000);
        Trace($"{new string(' ', depth * 2)}constants@{reader.Position - 4} count={constantCount}");
        var parsedConstants = new List<HerculesConstant>(constantCount);
        var boundaries = new List<int>(constantCount + 1) { reader.Position };
        for (var index = 0; index < constantCount; index++)
        {
            var position = reader.Position;
            try
            {
                var type = reader.ReadByte();
                if (type is not (1 or 3 or 4))
                {
                    reader.Restore(position);
                    break;
                }
                var constant = type switch
                {
                    1 => HerculesConstant.FromBoolean(reader.ReadByte() != 0),
                    3 => HerculesConstant.FromNumber(reader.ReadDouble()),
                    4 => HerculesConstant.FromString(
                        reader.ReadBytes(reader.ReadCount("string", 100_000_000))),
                    _ => throw new InvalidDataException("Invalid Hercules constant type.")
                };
                parsedConstants.Add(constant);
                boundaries.Add(reader.Position);
            }
            catch (InvalidDataException)
            {
                reader.Restore(position);
                break;
            }
        }

        for (var actualCount = parsedConstants.Count; actualCount >= 0; actualCount--)
        {
            reader.Restore(boundaries[actualCount]);
            try
            {
                var prototypeCount = reader.ReadCount("prototype", 10_000);
                Trace(
                    $"{new string(' ', depth * 2)}prototypes@{reader.Position - 4} " +
                    $"count={prototypeCount} constants={actualCount}/{constantCount}");
                var prototypes = new HerculesChunk[prototypeCount];
                for (var index = 0; index < prototypeCount; index++)
                {
                    prototypes[index] = ReadChunk(reader, depth + 1);
                }

                var constants = RepairConstants(
                    instructions,
                    parsedConstants.Take(actualCount).ToArray(),
                    constantCount)
                    ?? throw new InvalidDataException(
                        "Hercules constant indexes did not match the instruction stream.");
                return new HerculesChunk(
                    upvalues,
                    parameters,
                    maximumStack,
                    instructions,
                    constants,
                    prototypes);
            }
            catch (InvalidDataException)
            {
            }
        }

        throw new InvalidDataException("Hercules constant/prototype boundary was not valid.");
    }

    private static IReadOnlyList<HerculesConstant>? RepairConstants(
        IReadOnlyList<HerculesInstruction> instructions,
        IReadOnlyList<HerculesConstant> serialized,
        int declaredCount)
    {
        var requirements = new Dictionary<int, ConstantRequirement>();
        var maximumIndex = -1;
        foreach (var instruction in instructions)
        {
            var value = instruction.Value;
            var opcode = (int)(value & 0x3F);
            var b = (int)((value >> 23) & 0x1FF);
            var c = (int)((value >> 14) & 0x1FF);
            var bx = (int)((value >> 14) & 0x3FFFF);

            switch (opcode)
            {
                case 1:
                    Require(bx, ConstantRequirement.NonNil);
                    break;
                case 5:
                case 7:
                    Require(bx, ConstantRequirement.String);
                    break;
                case 6:
                    RequireRk(c, ConstantRequirement.TableKey);
                    break;
                case 11:
                    RequireRk(c, ConstantRequirement.TableKey);
                    break;
                case 9:
                    RequireRk(b, ConstantRequirement.TableKey);
                    RequireRk(c, ConstantRequirement.Any);
                    break;
                case 12:
                case 13:
                case 14:
                case 15:
                case 16:
                case 17:
                    RequireRk(b, ConstantRequirement.Arithmetic);
                    RequireRk(c, ConstantRequirement.Arithmetic);
                    break;
                case 23:
                    RequireRk(b, ConstantRequirement.Any);
                    RequireRk(c, ConstantRequirement.Any);
                    break;
                case 24:
                case 25:
                    RequireRk(b, ConstantRequirement.NonNil);
                    RequireRk(c, ConstantRequirement.NonNil);
                    break;
            }
        }

        var targetCount = Math.Max(
            serialized.Count,
            Math.Max(declaredCount, maximumIndex + 1));
        const int impossible = int.MinValue / 4;
        var memo = new Dictionary<(int Slot, int Source), int>();
        var choices = new Dictionary<(int Slot, int Source), bool>();
        var output = new HerculesConstant[targetCount];
        if (Solve(0, 0) == impossible)
        {
            return null;
        }

        var outputSlot = 0;
        var outputSource = 0;
        while (outputSlot < targetCount)
        {
            if (choices[(outputSlot, outputSource)])
            {
                output[outputSlot] = serialized[outputSource++];
            }
            else
            {
                output[outputSlot] = HerculesConstant.Nil;
            }
            outputSlot++;
        }
        return output;

        int Solve(int slot, int source)
        {
            if (slot == targetCount)
            {
                return source == serialized.Count ? 0 : impossible;
            }
            if (memo.TryGetValue((slot, source), out var cached))
            {
                return cached;
            }

            var remainingSlots = targetCount - slot;
            var remainingValues = serialized.Count - source;
            var requirement = requirements.GetValueOrDefault(slot);
            var best = impossible;
            if (source < serialized.Count &&
                Fits(serialized[source], requirement))
            {
                var next = Solve(slot + 1, source + 1);
                if (next != impossible)
                {
                    best = next + MatchScore(serialized[source], requirement);
                    choices[(slot, source)] = true;
                }
            }

            if (remainingSlots > remainingValues &&
                requirement is ConstantRequirement.Any or ConstantRequirement.TableKey)
            {
                var next = Solve(slot + 1, source);
                if (next > best)
                {
                    best = next;
                    choices[(slot, source)] = false;
                }
            }
            memo[(slot, source)] = best;
            return best;
        }

        void RequireRk(int operand, ConstantRequirement requirement)
        {
            if (operand >= 256)
            {
                Require(operand - 256, requirement);
            }
        }

        void Require(int index, ConstantRequirement requirement)
        {
            maximumIndex = Math.Max(maximumIndex, index);
            var existing = requirements.GetValueOrDefault(index);
            requirements[index] = Merge(existing, requirement);
        }
    }

    private static bool Fits(
        HerculesConstant constant,
        ConstantRequirement requirement) =>
        requirement switch
        {
            ConstantRequirement.Any => true,
            ConstantRequirement.NonNil => constant.Kind != HerculesConstantKind.Nil,
            ConstantRequirement.TableKey => true,
            ConstantRequirement.Arithmetic => constant.Kind != HerculesConstantKind.Nil,
            ConstantRequirement.String => IsLuaIdentifier(constant),
            _ => false
        };

    private static int MatchScore(
        HerculesConstant constant,
        ConstantRequirement requirement)
    {
        if (requirement == ConstantRequirement.TableKey)
        {
            return constant.Kind == HerculesConstantKind.Nil ? 0 : 40;
        }
        if (requirement != ConstantRequirement.Arithmetic)
        {
            return 0;
        }
        if (constant.Kind == HerculesConstantKind.Number)
        {
            return 20;
        }
        if (constant.Kind == HerculesConstantKind.String &&
            constant.Bytes is { } bytes &&
            double.TryParse(
                System.Text.Encoding.Latin1.GetString(bytes),
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture,
                out _))
        {
            return 10;
        }
        return 0;
    }

    private static ConstantRequirement Merge(
        ConstantRequirement left,
        ConstantRequirement right)
    {
        if (left == ConstantRequirement.String || right == ConstantRequirement.String)
        {
            return ConstantRequirement.String;
        }
        if (left == ConstantRequirement.Arithmetic ||
            right == ConstantRequirement.Arithmetic)
        {
            return ConstantRequirement.Arithmetic;
        }
        if (left == ConstantRequirement.NonNil || right == ConstantRequirement.NonNil)
        {
            return ConstantRequirement.NonNil;
        }
        if (left == ConstantRequirement.TableKey || right == ConstantRequirement.TableKey)
        {
            return ConstantRequirement.TableKey;
        }
        return ConstantRequirement.Any;
    }

    private static bool IsLuaIdentifier(HerculesConstant constant)
    {
        if (constant.Kind != HerculesConstantKind.String ||
            constant.Bytes is not { Length: > 0 } bytes)
        {
            return false;
        }

        static bool IsStart(byte value) =>
            value == (byte)'_' ||
            value is >= (byte)'A' and <= (byte)'Z' ||
            value is >= (byte)'a' and <= (byte)'z';

        static bool IsPart(byte value) =>
            IsStart(value) ||
            value is >= (byte)'0' and <= (byte)'9';

        if (!IsStart(bytes[0]) || bytes.Skip(1).Any(value => !IsPart(value)))
        {
            return false;
        }

        return !LuaKeywords.Contains(System.Text.Encoding.ASCII.GetString(bytes));
    }

    private enum ConstantRequirement
    {
        Any,
        NonNil,
        TableKey,
        Arithmetic,
        String
    }

    private static void Trace(string message)
    {
        if (Environment.GetEnvironmentVariable("HERCULES_TRACE") == "1")
        {
            Console.Error.WriteLine(message);
        }
    }

    private sealed class ByteReader(byte[] bytes)
    {
        private int _position;
        public bool AtEnd => _position == bytes.Length;
        public int Position => _position;

        public void Restore(int position) =>
            _position = position is >= 0 and <= int.MaxValue && position <= bytes.Length
                ? position
                : throw new ArgumentOutOfRangeException(nameof(position));

        public byte ReadByte()
        {
            Ensure(1);
            return bytes[_position++];
        }

        public ushort ReadUInt16()
        {
            Ensure(2);
            var value = BitConverter.ToUInt16(bytes, _position);
            _position += 2;
            return value;
        }

        public uint ReadUInt32()
        {
            Ensure(4);
            var value = BitConverter.ToUInt32(bytes, _position);
            _position += 4;
            return value;
        }

        public double ReadDouble()
        {
            Ensure(8);
            var value = BitConverter.ToDouble(bytes, _position);
            _position += 8;
            return value;
        }

        public byte[] ReadBytes(int count)
        {
            Ensure(count);
            var value = bytes.AsSpan(_position, count).ToArray();
            _position += count;
            return value;
        }

        public int ReadCount(string name, int maximum)
        {
            var value = ReadUInt32();
            if (value > maximum)
            {
                throw new InvalidDataException($"Invalid Hercules {name} count: {value}.");
            }
            return (int)value;
        }

        private void Ensure(int count)
        {
            if (count < 0 || _position + (long)count > bytes.Length)
            {
                throw new InvalidDataException("Hercules bytecode is truncated.");
            }
        }
    }
}
