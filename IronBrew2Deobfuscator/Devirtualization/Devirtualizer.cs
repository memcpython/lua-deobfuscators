using System;
using System.Collections.Generic;
using System.Linq;
using IronBrew2.Bytecode_Library.Bytecode;
using IronBrew2.Bytecode_Library.IR;

namespace IronBrew2Deobfuscator;

internal sealed class Devirtualizer
{
    private readonly Dictionary<int, HandlerInfo> _handlers;
    private readonly List<string> _warnings = new();
    private int _unknownInstructions;
    private int _unsupportedCustomInstructions;

    public Devirtualizer(Dictionary<int, HandlerInfo> handlers) => _handlers = handlers;

    public DevirtualizationResult Devirtualize(RecoveredChunk chunk)
    {
        ApplyChunk(chunk, "root");
        InferMetadata(chunk, isRoot: true);
        ValidateChunk(chunk, "root");

        var result = new DevirtualizationResult
        {
            Chunk = chunk,
            Handlers = _handlers,
            UnknownInstructionCount = _unknownInstructions,
            UnsupportedCustomInstructionCount = _unsupportedCustomInstructions
        };
        result.Warnings.AddRange(_warnings);
        return result;
    }

    private void ApplyChunk(RecoveredChunk chunk, string path)
    {
        for (var i = 0; i < chunk.Instructions.Count;)
        {
            var instruction = chunk.Instructions[i];
            instruction.Pc = i;

            if (instruction.IsData)
            {
                MakeNoop(instruction, "DataPlaceholder");
                i++;
                continue;
            }

            if (!_handlers.TryGetValue(instruction.VirtualOpcode, out var handler) || handler.IsUnknown)
            {
                MakeNoop(instruction, "UnknownVOpcode");
                _unknownInstructions++;
                _warnings.Add($"{path}:{i:D4}: unknown virtual opcode {instruction.VirtualOpcode}; emitted MOVE 0 0 placeholder.");
                i++;
                continue;
            }

            if (handler.IsSuper)
            {
                var sequence = handler.SuperSequence!;
                for (var j = 0; j < sequence.Count; j++)
                {
                    if (i + j >= chunk.Instructions.Count)
                    {
                        _warnings.Add($"{path}:{i:D4}: super operator {instruction.VirtualOpcode} overruns chunk; remaining entries skipped.");
                        break;
                    }

                    ApplyBasic(sequence[j], chunk.Instructions[i + j], i + j, chunk, path);
                }

                i += Math.Max(sequence.Count, 1);
                continue;
            }

            ApplyBasic(handler.Basic!, instruction, i, chunk, path);
            i++;
        }

        for (var i = 0; i < chunk.Functions.Count; i++)
            ApplyChunk(chunk.Functions[i], path + "." + i.ToString("D2"));
    }

    private void ApplyBasic(HandlerCandidate candidate, RecoveredInstruction instruction, int pc, RecoveredChunk chunk, string path)
    {
        var handlerName = ResolveAmbiguousHandler(candidate.Name, instruction);
        instruction.HandlerName = handlerName;
        instruction.IsData = false;
        instruction.IsUnsupportedCustom = false;

        switch (handlerName)
        {
            case "OpMove":
                SetAbc(instruction, Opcode.Move, instruction.A, instruction.B, 0);
                break;
            case "OpLoadK":
                SetAbx(instruction, Opcode.LoadConst, instruction.B - 1);
                break;
            case "OpLoadBool":
                SetAbc(instruction, Opcode.LoadBool, instruction.A, instruction.B, 0);
                break;
            case "OpLoadBoolC":
                SetAbc(instruction, Opcode.LoadBool, instruction.A, instruction.B, 1);
                break;
            case "OpLoadNil":
                SetAbc(instruction, Opcode.LoadNil, instruction.A, instruction.B, 0);
                break;
            case "OpGetUpval":
                SetAbc(instruction, Opcode.GetUpval, instruction.A, instruction.B, 0);
                break;
            case "OpGetGlobal":
                SetAbx(instruction, Opcode.GetGlobal, instruction.B - 1);
                break;
            case "OpGetTable":
                SetAbc(instruction, Opcode.GetTable);
                break;
            case "OpGetTableConst":
                SetAbc(instruction, Opcode.GetTable, instruction.A, instruction.B, RestoreConstantOperand(instruction.C));
                break;
            case "OpSetGlobal":
                SetAbx(instruction, Opcode.SetGlobal, instruction.B - 1);
                break;
            case "OpSetUpval":
                SetAbc(instruction, Opcode.SetUpval, instruction.A, instruction.B, 0);
                break;
            case "OpSetTable":
                SetAbc(instruction, Opcode.SetTable);
                break;
            case "OpSetTableB":
                SetAbc(instruction, Opcode.SetTable, instruction.A, RestoreConstantOperand(instruction.B), instruction.C);
                break;
            case "OpSetTableC":
                SetAbc(instruction, Opcode.SetTable, instruction.A, instruction.B, RestoreConstantOperand(instruction.C));
                break;
            case "OpSetTableBC":
                SetAbc(instruction, Opcode.SetTable, instruction.A, RestoreConstantOperand(instruction.B), RestoreConstantOperand(instruction.C));
                break;
            case "OpNewTableB0":
                SetAbc(instruction, Opcode.NewTable);
                break;
            case "OpSelf":
                SetAbc(instruction, Opcode.Self);
                break;
            case "OpSelfC":
                SetAbc(instruction, Opcode.Self, instruction.A, instruction.B, RestoreConstantOperand(instruction.C));
                break;
            case "OpAdd":
            case "OpAddB":
            case "OpAddC":
            case "OpAddBC":
                ApplyBinaryRk(instruction, Opcode.Add, handlerName);
                break;
            case "OpSub":
            case "OpSubB":
            case "OpSubC":
            case "OpSubBC":
                ApplyBinaryRk(instruction, Opcode.Sub, handlerName);
                break;
            case "OpMul":
            case "OpMulB":
            case "OpMulC":
            case "OpMulBC":
                ApplyBinaryRk(instruction, Opcode.Mul, handlerName);
                break;
            case "OpDiv":
            case "OpDivB":
            case "OpDivC":
            case "OpDivBC":
                ApplyBinaryRk(instruction, Opcode.Div, handlerName);
                break;
            case "OpMod":
            case "OpModB":
            case "OpModC":
            case "OpModBC":
                ApplyBinaryRk(instruction, Opcode.Mod, handlerName);
                break;
            case "OpPow":
            case "OpPowB":
            case "OpPowC":
            case "OpPowBC":
                ApplyBinaryRk(instruction, Opcode.Pow, handlerName);
                break;
            case "OpUnm":
                SetAbc(instruction, Opcode.Unm, instruction.A, instruction.B, 0);
                break;
            case "OpNot":
                SetAbc(instruction, Opcode.Not, instruction.A, instruction.B, 0);
                break;
            case "OpLen":
                SetAbc(instruction, Opcode.Len, instruction.A, instruction.B, 0);
                break;
            case "OpConcat":
                SetAbc(instruction, Opcode.Concat);
                break;
            case "OpJmp":
                SetAsBx(instruction, Opcode.Jmp, instruction.B - pc - 1);
                instruction.A = 0;
                break;
            case "OpEq":
            case "OpEqB":
            case "OpEqC":
            case "OpEqBC":
                ApplyCompare(instruction, Opcode.Eq, handlerName, inverted: false);
                break;
            case "OpNe":
            case "OpNeB":
            case "OpNeC":
            case "OpNeBC":
                ApplyCompare(instruction, Opcode.Eq, handlerName, inverted: true);
                break;
            case "OpLt":
            case "OpLtB":
            case "OpLtC":
            case "OpLtBC":
                ApplyCompare(instruction, Opcode.Lt, handlerName, inverted: false);
                break;
            case "OpGe":
            case "OpGeB":
            case "OpGeC":
            case "OpGeBC":
                ApplyCompare(instruction, Opcode.Lt, handlerName, inverted: true);
                break;
            case "OpLe":
            case "OpLeB":
            case "OpLeC":
            case "OpLeBC":
                ApplyCompare(instruction, Opcode.Le, handlerName, inverted: false);
                break;
            case "OpGt":
            case "OpGtB":
            case "OpGtC":
            case "OpGtBC":
                ApplyCompare(instruction, Opcode.Le, handlerName, inverted: true);
                break;
            case "OpTest":
                SetAbc(instruction, Opcode.Test, instruction.A, 0, 0);
                break;
            case "OpTestC":
                SetAbc(instruction, Opcode.Test, instruction.A, 0, 1);
                break;
            case "OpTestSet":
                SetAbc(instruction, Opcode.TestSet, instruction.A, instruction.C, 0);
                break;
            case "OpTestSetC":
                SetAbc(instruction, Opcode.TestSet, instruction.A, instruction.C, 1);
                break;
            case "OpCall":
                SetAbc(instruction, Opcode.Call, instruction.A, instruction.B - instruction.A + 1, instruction.C - instruction.A + 2);
                break;
            case "OpCallB2":
                SetAbc(instruction, Opcode.Call, instruction.A, 2, instruction.C - instruction.A + 2);
                break;
            case "OpCallB0":
                SetAbc(instruction, Opcode.Call, instruction.A, 0, instruction.C - instruction.A + 2);
                break;
            case "OpCallB1":
                SetAbc(instruction, Opcode.Call, instruction.A, 1, instruction.C - instruction.A + 2);
                break;
            case "OpCallC0":
                SetAbc(instruction, Opcode.Call, instruction.A, instruction.B - instruction.A + 1, 0);
                break;
            case "OpCallC0B2":
                SetAbc(instruction, Opcode.Call, instruction.A, 2, 0);
                break;
            case "OpCallC1":
                SetAbc(instruction, Opcode.Call, instruction.A, instruction.B - instruction.A + 1, 1);
                break;
            case "OpCallC1B2":
                SetAbc(instruction, Opcode.Call, instruction.A, 2, 1);
                break;
            case "OpCallB0C0":
                SetAbc(instruction, Opcode.Call, instruction.A, 0, 0);
                break;
            case "OpCallB0C1":
                SetAbc(instruction, Opcode.Call, instruction.A, 0, 1);
                break;
            case "OpCallB1C0":
                SetAbc(instruction, Opcode.Call, instruction.A, 1, 0);
                break;
            case "OpCallB1C1":
                SetAbc(instruction, Opcode.Call, instruction.A, 1, 1);
                break;
            case "OpCallC2":
                SetAbc(instruction, Opcode.Call, instruction.A, instruction.B - instruction.A + 1, 2);
                break;
            case "OpCallC2B2":
                SetAbc(instruction, Opcode.Call, instruction.A, 2, 2);
                break;
            case "OpCallB0C2":
                SetAbc(instruction, Opcode.Call, instruction.A, 0, 2);
                break;
            case "OpCallB1C2":
                SetAbc(instruction, Opcode.Call, instruction.A, 1, 2);
                break;
            case "OpTailCall":
                SetAbc(instruction, Opcode.TailCall, instruction.A, instruction.B - instruction.A + 1, 0);
                break;
            case "OpTailCallB0":
                SetAbc(instruction, Opcode.TailCall, instruction.A, 0, 0);
                break;
            case "OpTailCallB1":
                SetAbc(instruction, Opcode.TailCall, instruction.A, 1, 0);
                break;
            case "OpReturn":
                SetAbc(instruction, Opcode.Return, instruction.A, instruction.B + 2, 0);
                break;
            case "OpReturnB2":
                SetAbc(instruction, Opcode.Return, instruction.A, 2, 0);
                break;
            case "OpReturnB3":
                SetAbc(instruction, Opcode.Return, instruction.A, 3, 0);
                break;
            case "OpReturnB0":
                SetAbc(instruction, Opcode.Return, instruction.A, 0, 0);
                break;
            case "OpReturnB1":
                SetAbc(instruction, Opcode.Return, instruction.A, 1, 0);
                break;
            case "OpForLoop":
                SetAsBx(instruction, Opcode.ForLoop, instruction.B - pc - 1);
                break;
            case "OpForPrep":
                SetAsBx(instruction, Opcode.ForPrep, instruction.B - pc - 2);
                break;
            case "OpTForLoop":
                SetAbc(instruction, Opcode.TForLoop, instruction.A, 0, instruction.C);
                break;
            case "OpSetList":
                SetAbc(instruction, Opcode.SetList, instruction.A, instruction.B - instruction.A, instruction.C);
                break;
            case "OpSetListB0":
                SetAbc(instruction, Opcode.SetList, instruction.A, InferOpenSetListCount(chunk, pc, instruction.A), instruction.C);
                break;
            case "OpSetListC0":
                SetAbc(instruction, Opcode.SetList, instruction.A, Math.Max(0, instruction.B - instruction.A), 1);
                _warnings.Add($"{path}:{pc:D4}: SETLIST C=0 extension data is not serialized by IronBrew; emitted C=1 with the recovered element count.");
                break;
            case "OpClose":
                SetAbc(instruction, Opcode.Close, instruction.A, 0, 0);
                break;
            case "OpClosure":
            {
                var upvalueCount = instruction.C;
                SetAbx(instruction, Opcode.Closure, instruction.B);
                if (instruction.B >= 0 && instruction.B < chunk.Functions.Count)
                    chunk.Functions[instruction.B].UpvalueCount = (byte)Math.Clamp(upvalueCount, 0, 255);
                break;
            }
            case "OpClosureNU":
                SetAbx(instruction, Opcode.Closure, instruction.B);
                if (instruction.B >= 0 && instruction.B < chunk.Functions.Count)
                    chunk.Functions[instruction.B].UpvalueCount = 0;
                break;
            case "OpVarArg":
                SetAbc(instruction, Opcode.VarArg, instruction.A, instruction.B - instruction.A + 1, 0);
                break;
            case "OpVarArgB0":
                SetAbc(instruction, Opcode.VarArg, instruction.A, 0, 0);
                break;
            case "OpSetTop":
            case "OpPushStk":
            case "OpNewStk":
            case "OpSetFEnv":
                MakeNoop(instruction, handlerName);
                instruction.IsUnsupportedCustom = true;
                _unsupportedCustomInstructions++;
                _warnings.Add($"{path}:{pc:D4}: custom VM-only opcode {handlerName}; emitted MOVE 0 0 placeholder in luac.");
                break;
            default:
                MakeNoop(instruction, handlerName);
                _unknownInstructions++;
                _warnings.Add($"{path}:{pc:D4}: unhandled handler {handlerName}; emitted MOVE 0 0 placeholder.");
                break;
        }
    }

    private static string ResolveAmbiguousHandler(string name, RecoveredInstruction instruction)
    {
        var hasConstantB = (instruction.ConstantMask & InstructionConstantMask.RB) != 0;
        return name switch
        {
            "OpGetGlobal" when !hasConstantB => "OpGetUpval",
            "OpGetUpval" when hasConstantB => "OpGetGlobal",
            "OpSetGlobal" when !hasConstantB => "OpSetUpval",
            "OpSetUpval" when hasConstantB => "OpSetGlobal",
            _ => name
        };
    }

    private static void ApplyBinaryRk(RecoveredInstruction instruction, Opcode opcode, string name)
    {
        var b = name.EndsWith("B", StringComparison.Ordinal) || name.EndsWith("BC", StringComparison.Ordinal)
            ? RestoreConstantOperand(instruction.B)
            : instruction.B;
        var c = name.EndsWith("C", StringComparison.Ordinal) || name.EndsWith("BC", StringComparison.Ordinal)
            ? RestoreConstantOperand(instruction.C)
            : instruction.C;

        SetAbc(instruction, opcode, instruction.A, b, c);
    }

    private static void ApplyCompare(RecoveredInstruction instruction, Opcode opcode, string name, bool inverted)
    {
        var bConst = name.EndsWith("B", StringComparison.Ordinal) || name.EndsWith("BC", StringComparison.Ordinal);
        var cConst = name.EndsWith("C", StringComparison.Ordinal) || name.EndsWith("BC", StringComparison.Ordinal);

        var b = bConst ? RestoreConstantOperand(instruction.A) : instruction.A;
        var c = cConst ? RestoreConstantOperand(instruction.C) : instruction.C;
        SetAbc(instruction, opcode, inverted ? 1 : 0, b, c);
    }

    private static int RestoreConstantOperand(int value) => value + 255;

    private static int InferOpenSetListCount(RecoveredChunk chunk, int pc, int tableRegister)
    {
        if (pc <= 0)
            return 0;

        var producer = chunk.Instructions[pc - 1];
        if (producer.OpCode is Opcode.Call && producer.C == 0)
        {
            var count = Math.Max(0, producer.A - tableRegister);
            if (count > 0)
                producer.C = 2;
            return count;
        }

        return 0;
    }

    private static void SetAbc(RecoveredInstruction instruction, Opcode opcode) =>
        SetAbc(instruction, opcode, instruction.A, instruction.B, instruction.C);

    private static void SetAbc(RecoveredInstruction instruction, Opcode opcode, int a, int b, int c)
    {
        instruction.OpCode = opcode;
        instruction.LuaType = InstructionType.ABC;
        instruction.A = a;
        instruction.B = b;
        instruction.C = c;
    }

    private static void SetAbx(RecoveredInstruction instruction, Opcode opcode, int b)
    {
        instruction.OpCode = opcode;
        instruction.LuaType = InstructionType.ABx;
        instruction.B = b;
        instruction.C = -1;
    }

    private static void SetAsBx(RecoveredInstruction instruction, Opcode opcode, int b)
    {
        instruction.OpCode = opcode;
        instruction.LuaType = InstructionType.AsBx;
        instruction.B = b;
        instruction.C = -1;
    }

    private static void MakeNoop(RecoveredInstruction instruction, string handlerName)
    {
        instruction.HandlerName = handlerName;
        instruction.OpCode = Opcode.Move;
        instruction.LuaType = InstructionType.ABC;
        instruction.A = 0;
        instruction.B = 0;
        instruction.C = 0;
    }

    private static void InferMetadata(RecoveredChunk chunk, bool isRoot)
    {
        foreach (var function in chunk.Functions)
            InferMetadata(function, isRoot: false);

        chunk.VarargFlag = isRoot ? (byte)2 : chunk.Instructions.Any(i => i.OpCode == Opcode.VarArg) ? (byte)3 : (byte)0;
        chunk.StackSize = InferStackSize(chunk);
    }

    private static byte InferStackSize(RecoveredChunk chunk)
    {
        var max = Math.Max(1, (int)chunk.ParameterCount);
        foreach (var instruction in chunk.Instructions)
        {
            if (instruction.OpCode == null)
                continue;

            max = Math.Max(max, instruction.A + 1);
            switch (instruction.OpCode)
            {
                case Opcode.Move:
                case Opcode.LoadNil:
                case Opcode.GetUpval:
                case Opcode.SetUpval:
                case Opcode.Unm:
                case Opcode.Not:
                case Opcode.Len:
                case Opcode.Concat:
                    max = Math.Max(max, instruction.B + 1);
                    max = Math.Max(max, instruction.C + 1);
                    break;
                case Opcode.GetTable:
                case Opcode.SetTable:
                case Opcode.Add:
                case Opcode.Sub:
                case Opcode.Mul:
                case Opcode.Div:
                case Opcode.Mod:
                case Opcode.Pow:
                case Opcode.Eq:
                case Opcode.Lt:
                case Opcode.Le:
                case Opcode.Self:
                    if (instruction.B is >= 0 and < 256)
                        max = Math.Max(max, instruction.B + 1);
                    if (instruction.C is >= 0 and < 256)
                        max = Math.Max(max, instruction.C + 1);
                    break;
                case Opcode.Call:
                case Opcode.TailCall:
                case Opcode.Return:
                case Opcode.VarArg:
                case Opcode.SetList:
                    if (instruction.B > 0 && instruction.B < 256)
                        max = Math.Max(max, instruction.A + instruction.B + 2);
                    if (instruction.C > 0 && instruction.C < 256)
                        max = Math.Max(max, instruction.A + instruction.C + 2);
                    break;
            }
        }

        return (byte)Math.Clamp(max + 4, 2, 250);
    }

    private void ValidateChunk(RecoveredChunk chunk, string path)
    {
        for (var pc = 0; pc < chunk.Instructions.Count; pc++)
        {
            var instruction = chunk.Instructions[pc];
            if (instruction.OpCode == null)
                continue;

            CheckRegister(path, pc, "A", instruction.A, chunk.StackSize);

            if ((int)instruction.OpCode.Value > (int)Opcode.VarArg)
                _warnings.Add($"{path}:{pc:D4}: non-vanilla opcode {instruction.OpCode} remains.");

            switch (instruction.OpCode.Value)
            {
                case Opcode.Move:
                case Opcode.LoadNil:
                case Opcode.Unm:
                case Opcode.Not:
                case Opcode.Len:
                    CheckRegister(path, pc, "B", instruction.B, chunk.StackSize);
                    break;
                case Opcode.LoadConst:
                case Opcode.GetGlobal:
                case Opcode.SetGlobal:
                    CheckConstant(path, pc, instruction.B, chunk.Constants.Count);
                    break;
                case Opcode.GetTable:
                case Opcode.SetTable:
                case Opcode.Add:
                case Opcode.Sub:
                case Opcode.Mul:
                case Opcode.Div:
                case Opcode.Mod:
                case Opcode.Pow:
                case Opcode.Eq:
                case Opcode.Lt:
                case Opcode.Le:
                case Opcode.Self:
                    if (instruction.B is >= 0 and < 256)
                        CheckRegister(path, pc, "B", instruction.B, chunk.StackSize);
                    if (instruction.C is >= 0 and < 256)
                        CheckRegister(path, pc, "C", instruction.C, chunk.StackSize);
                    if (instruction.B >= 256)
                        CheckConstant(path, pc, instruction.B - 256, chunk.Constants.Count);
                    if (instruction.C >= 256)
                        CheckConstant(path, pc, instruction.C - 256, chunk.Constants.Count);
                    break;
                case Opcode.Concat:
                    CheckRegister(path, pc, "B", instruction.B, chunk.StackSize);
                    CheckRegister(path, pc, "C", instruction.C, chunk.StackSize);
                    break;
                case Opcode.TestSet:
                    CheckRegister(path, pc, "B", instruction.B, chunk.StackSize);
                    break;
                case Opcode.Call:
                case Opcode.TailCall:
                    if (instruction.B > 0)
                        CheckRegister(path, pc, "call B range", instruction.A + instruction.B - 1, chunk.StackSize);
                    if (instruction.C > 1)
                        CheckRegister(path, pc, "call C range", instruction.A + instruction.C - 2, chunk.StackSize);
                    break;
                case Opcode.Return:
                    if (instruction.B > 1)
                        CheckRegister(path, pc, "return range", instruction.A + instruction.B - 2, chunk.StackSize);
                    break;
                case Opcode.GetUpval:
                case Opcode.SetUpval:
                    if (instruction.B < 0 || instruction.B >= chunk.UpvalueCount)
                        _warnings.Add($"{path}:{pc:D4}: upvalue index {instruction.B} is outside upvalue count {chunk.UpvalueCount}.");
                    break;
                case Opcode.Jmp:
                case Opcode.ForLoop:
                case Opcode.ForPrep:
                {
                    var target = pc + instruction.B + 1;
                    if (target < 0 || target >= chunk.Instructions.Count)
                        _warnings.Add($"{path}:{pc:D4}: jump target {target} is outside the chunk.");
                    break;
                }
                case Opcode.Closure:
                    if (instruction.B < 0 || instruction.B >= chunk.Functions.Count)
                        _warnings.Add($"{path}:{pc:D4}: closure proto index {instruction.B} is outside the function table.");
                    else
                    {
                        var needed = chunk.Functions[instruction.B].UpvalueCount;
                        for (var i = 1; i <= needed; i++)
                        {
                            if (pc + i >= chunk.Instructions.Count ||
                                chunk.Instructions[pc + i].OpCode is not (Opcode.Move or Opcode.GetUpval))
                            {
                                _warnings.Add($"{path}:{pc:D4}: closure expects {needed} upvalue init instructions, but slot {i} is not MOVE/GETUPVAL.");
                                break;
                            }
                        }
                    }
                    break;
                case Opcode.VarArg:
                    if (chunk.VarargFlag == 0)
                        _warnings.Add($"{path}:{pc:D4}: VARARG appears in a chunk not marked vararg.");
                    break;
            }

            if (instruction.OpCode is Opcode.Eq or Opcode.Lt or Opcode.Le or Opcode.Test or Opcode.TestSet or Opcode.TForLoop)
            {
                if (pc + 1 >= chunk.Instructions.Count || chunk.Instructions[pc + 1].OpCode != Opcode.Jmp)
                    _warnings.Add($"{path}:{pc:D4}: test opcode {instruction.OpCode} is not followed by JMP.");
            }

            if (instruction.OpCode == Opcode.LoadBool && instruction.C != 0 && pc + 1 >= chunk.Instructions.Count)
                _warnings.Add($"{path}:{pc:D4}: LOADBOOL with skip flag is the last instruction.");

            if (IsOpenProducer(instruction))
            {
                if (pc + 1 >= chunk.Instructions.Count || !ConsumesOpenTop(chunk.Instructions[pc + 1]))
                    _warnings.Add($"{path}:{pc:D4}: open-result opcode is not followed by CALL/RETURN/SETLIST consuming top.");
            }
        }

        for (var i = 0; i < chunk.Functions.Count; i++)
            ValidateChunk(chunk.Functions[i], path + "." + i.ToString("D2"));
    }

    private void CheckConstant(string path, int pc, int index, int count)
    {
        if (index < 0 || index >= count)
            _warnings.Add($"{path}:{pc:D4}: constant index {index} is outside constant table size {count}.");
    }

    private void CheckRegister(string path, int pc, string field, int index, int stackSize)
    {
        if (index < 0 || index >= stackSize)
            _warnings.Add($"{path}:{pc:D4}: register {field}={index} is outside stack size {stackSize}.");
    }

    private static bool IsOpenProducer(RecoveredInstruction instruction) =>
        instruction.OpCode is Opcode.Call && instruction.C == 0 ||
        instruction.OpCode is Opcode.VarArg && instruction.B == 0;

    private static bool ConsumesOpenTop(RecoveredInstruction instruction) =>
        instruction.OpCode switch
        {
            Opcode.Call => instruction.B == 0,
            Opcode.Return => instruction.B == 0,
            Opcode.SetList => instruction.B == 0,
            _ => false
        };
}
