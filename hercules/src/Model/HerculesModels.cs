namespace HerculesDeobfuscator.Model;

public sealed record HerculesPayload(byte[] EncodedBytecode, byte[] Charset);

public enum HerculesConstantKind
{
    Nil,
    Boolean,
    Number,
    String
}

public sealed record HerculesConstant(
    HerculesConstantKind Kind,
    bool Boolean,
    double Number,
    byte[]? Bytes)
{
    public static HerculesConstant Nil { get; } =
        new(HerculesConstantKind.Nil, false, 0, null);

    public static HerculesConstant FromBoolean(bool value) =>
        new(HerculesConstantKind.Boolean, value, 0, null);

    public static HerculesConstant FromNumber(double value) =>
        new(HerculesConstantKind.Number, false, value, null);

    public static HerculesConstant FromString(byte[] value) =>
        new(HerculesConstantKind.String, false, 0, value);
}

public sealed record HerculesInstruction(uint Value, byte Opcode);

public sealed record HerculesChunk(
    byte UpvalueCount,
    byte ParameterCount,
    byte MaximumStack,
    IReadOnlyList<HerculesInstruction> Instructions,
    IReadOnlyList<HerculesConstant> Constants,
    IReadOnlyList<HerculesChunk> Prototypes);

public sealed record HerculesStatistics(int Functions, int Constants, int Instructions)
{
    public static HerculesStatistics From(HerculesChunk root)
    {
        var functions = 0;
        var constants = 0;
        var instructions = 0;
        Visit(root);
        return new HerculesStatistics(functions, constants, instructions);

        void Visit(HerculesChunk chunk)
        {
            functions++;
            constants += chunk.Constants.Count;
            instructions += chunk.Instructions.Count;
            foreach (var child in chunk.Prototypes)
            {
                Visit(child);
            }
        }
    }
}
