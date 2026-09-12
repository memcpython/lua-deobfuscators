using System.Collections.Generic;
using IronBrew2.Bytecode_Library.Bytecode;
using IronBrew2.Bytecode_Library.IR;

namespace IronBrew2Deobfuscator;

internal enum ChunkStepKind
{
    ParameterCount,
    Instructions,
    Functions,
    LineInfo
}

internal sealed class PayloadCandidate
{
    public required string Description { get; init; }
    public required byte[] Bytes { get; init; }
}

internal sealed class ParseCandidate
{
    public required byte PrimaryXorKey { get; init; }
    public required int NumberXorKey { get; init; }
    public double NumberScore { get; init; }
    public required IReadOnlyDictionary<byte, ConstantType> ConstantTypes { get; init; }
    public required IReadOnlyList<ChunkStepKind> StepOrder { get; init; }
    public required RecoveredChunk Chunk { get; init; }
    public int InstructionCount { get; init; }
    public int MaxVirtualOpcode { get; init; }
}

internal sealed class RecoveredChunk
{
    public string Name { get; set; } = string.Empty;
    public int Line { get; set; }
    public int LastLine { get; set; }
    public byte UpvalueCount { get; set; }
    public byte ParameterCount { get; set; }
    public byte VarargFlag { get; set; }
    public byte StackSize { get; set; }
    public List<RecoveredConstant> Constants { get; } = new();
    public List<RecoveredInstruction> Instructions { get; } = new();
    public List<RecoveredChunk> Functions { get; } = new();
    public List<int> Lines { get; } = new();
}

internal sealed class RecoveredConstant
{
    public ConstantType Type { get; init; }
    public object? Data { get; set; }
    public byte[]? EncodedNumberBytes { get; init; }
}

internal sealed class RecoveredInstruction
{
    public int Pc { get; set; }
    public bool IsData { get; set; }
    public int VirtualOpcode { get; set; }
    public InstructionType EncodedType { get; set; }
    public InstructionConstantMask ConstantMask { get; set; }
    public int A { get; set; }
    public int B { get; set; }
    public int C { get; set; }
    public int Data { get; set; }
    public Opcode? OpCode { get; set; }
    public InstructionType LuaType { get; set; }
    public string HandlerName { get; set; } = string.Empty;
    public bool IsUnsupportedCustom { get; set; }
}

internal sealed class DispatchInfo
{
    public required string InstVar { get; init; }
    public required string InstrVar { get; init; }
    public required string InstrPointVar { get; init; }
    public required string EnumVar { get; init; }
    public required Dictionary<int, string> Bodies { get; init; }
}

internal sealed class HandlerCandidate
{
    public required string Name { get; init; }
    public required string CanonicalBody { get; init; }
}

internal sealed class HandlerInfo
{
    public required int VIndex { get; init; }
    public required string Body { get; init; }
    public HandlerCandidate? Basic { get; init; }
    public IReadOnlyList<HandlerCandidate>? SuperSequence { get; init; }
    public bool IsUnknown => Basic == null && SuperSequence == null;
    public bool IsSuper => SuperSequence is { Count: > 0 };
}

internal sealed class DevirtualizationResult
{
    public required RecoveredChunk Chunk { get; init; }
    public required Dictionary<int, HandlerInfo> Handlers { get; init; }
    public List<string> Warnings { get; } = new();
    public int UnsupportedCustomInstructionCount { get; set; }
    public int UnknownInstructionCount { get; set; }
}
