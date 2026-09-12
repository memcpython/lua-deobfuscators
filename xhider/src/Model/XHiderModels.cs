namespace XHiderDeobfuscator.Model;

public sealed record WrapperRoles(
    string ProgramCounter,
    string Arguments,
    string Globals,
    string ParentEnvironment,
    string Environment,
    string Stack,
    string StackTop,
    string Position,
    string InstructionBase,
    string Opcode,
    string Bytes,
    string DispatchFlag);

public sealed record HandlerSource(byte Opcode, string Body);

public sealed record WrapperAnalysis(
    byte[] ContainerKey,
    int ContainerTrim,
    string StringDecoderName,
    WrapperRoles Roles,
    IReadOnlyList<HandlerSource> Handlers);

public enum ConstantKind
{
    String,
    Number
}

public sealed record XHiderConstant(ConstantKind Kind, byte[]? Bytes, double Number)
{
    public static XHiderConstant FromString(byte[] value) => new(ConstantKind.String, value, 0);
    public static XHiderConstant FromNumber(double value) => new(ConstantKind.Number, null, value);
}

public sealed record XHiderInstruction(int Pc, byte Opcode, ushort Operand16, int Operand24, byte OperandByte);

public sealed record XHiderImage(
    IReadOnlyList<int> FunctionEntries,
    IReadOnlyList<XHiderConstant> Constants,
    IReadOnlyList<XHiderInstruction> Instructions);

public enum SemanticKind
{
    Nop,
    PushConstant,
    PushClosure,
    PushEnvironment,
    SetEnvironment,
    SetEnvironmentIndexed,
    EnterEnvironment,
    LeaveEnvironment,
    GetGlobal,
    GetArgument,
    PushArgument,
    PushVarargs,
    NewTable,
    PushBoolean,
    PushNil,
    LogicalNot,
    Length,
    Pop,
    Swap,
    Duplicate,
    First,
    GetTableKeepKey,
    GetTable,
    SetTable,
    SetTableImmediate,
    AppendTableResults,
    SetTableFromResult,
    SetGlobal,
    SetGlobalIndexed,
    Call,
    ExpandResults,
    FramePush,
    FrameCaptureTop,
    FrameClone,
    FrameReset,
    FrameRestore,
    FrameRestoreKeepTop,
    Jump,
    BranchTruePop,
    NumericFor,
    GenericFor,
    BinaryReduce,
    BinaryReplace,
    BinaryTopTwo,
    ReturnTop,
    ReturnEmpty,
    Unknown
}

public sealed record HandlerSemantic(SemanticKind Kind, string? Operator = null, string? CanonicalBody = null);

public sealed record EmitResult(string Source, int UnknownInstructions);
