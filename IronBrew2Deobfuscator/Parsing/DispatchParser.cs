using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace IronBrew2Deobfuscator;

internal sealed class DispatchParser
{
    private readonly string _source;
    private readonly List<LuaToken> _tokens;
    private string _enumVar = string.Empty;
    private readonly Dictionary<int, string> _bodies = new();

    private DispatchParser(string source)
    {
        _source = source;
        _tokens = LuaTokenizer.Tokenize(source);
    }

    public static DispatchInfo Parse(string source, int maxVirtualOpcodeFromPayload)
    {
        var parser = new DispatchParser(source);
        return parser.ParseInternal(maxVirtualOpcodeFromPayload);
    }

    private DispatchInfo ParseInternal(int maxVirtualOpcodeFromPayload)
    {
        var whileIndex = FindDispatchWhile();
        if (whileIndex < 0)
            throw new InvalidOperationException("Could not find the VM dispatch loop.");

        var doIndex = FindNextText(whileIndex + 1, "do");
        var whileEnd = FindMatchingEnd(doIndex);
        var firstIf = FindFirstTopLevelIf(doIndex + 1, whileEnd);
        if (firstIf < 0)
            throw new InvalidOperationException("Could not find the VM dispatch if-tree.");

        var vars = InferDispatchVariables(doIndex + 1, firstIf);
        _enumVar = vars.EnumVar;

        var maxConditionValue = MaxEnumConditionValue(firstIf, whileEnd, _enumVar);
        var maxEnum = Math.Max(maxVirtualOpcodeFromPayload, maxConditionValue + 1);
        var possible = Enumerable.Range(0, maxEnum + 1).ToHashSet();

        MapBlock(firstIf, whileEnd, possible);

        return new DispatchInfo
        {
            InstVar = vars.InstVar,
            InstrVar = vars.InstrVar,
            InstrPointVar = vars.InstrPointVar,
            EnumVar = vars.EnumVar,
            Bodies = _bodies
        };
    }

    private int FindDispatchWhile()
    {
        for (var i = _tokens.Count - 1; i >= 0; i--)
        {
            if (!_tokens[i].IsText("while"))
                continue;

            var doIndex = FindNextText(i + 1, "do");
            if (doIndex < 0)
                continue;

            var condition = _tokens.Skip(i + 1).Take(doIndex - i - 1).Where(t => t.Kind != LuaTokenKind.Eof).ToList();
            if (condition.Count == 1 && condition[0].IsText("true"))
                return i;
        }

        return -1;
    }

    private (string InstVar, string InstrVar, string InstrPointVar, string EnumVar) InferDispatchVariables(int start, int firstIf)
    {
        string? instVar = null;
        string? instrVar = null;
        string? instrPointVar = null;

        for (var i = start; i + 5 < firstIf; i++)
        {
            if (_tokens[i].Kind != LuaTokenKind.Identifier ||
                !_tokens[i + 1].IsText("=") ||
                _tokens[i + 2].Kind != LuaTokenKind.Identifier ||
                !_tokens[i + 3].IsText("[") ||
                _tokens[i + 4].Kind != LuaTokenKind.Identifier ||
                !_tokens[i + 5].IsText("]"))
                continue;

            instVar = _tokens[i].Text;
            instrVar = _tokens[i + 2].Text;
            instrPointVar = _tokens[i + 4].Text;
        }

        if (instVar == null || instrVar == null || instrPointVar == null)
            throw new InvalidOperationException("Could not infer Inst/Instr/InstrPoint variable names.");

        string? enumVar = null;
        for (var i = start; i + 5 < firstIf; i++)
        {
            if (_tokens[i].Kind == LuaTokenKind.Identifier &&
                _tokens[i + 1].IsText("=") &&
                _tokens[i + 2].IsText(instVar) &&
                _tokens[i + 3].IsText("[") &&
                _tokens[i + 4].IsText("1") &&
                _tokens[i + 5].IsText("]"))
            {
                enumVar = _tokens[i].Text;
            }
        }

        if (enumVar == null && TryParseCondition(firstIf, out var predicate, out _))
            enumVar = predicate.VarName;

        if (enumVar == null)
            throw new InvalidOperationException("Could not infer Enum variable name.");

        return (instVar, instrVar, instrPointVar, enumVar);
    }

    private void MapBlock(int start, int end, HashSet<int> possible)
    {
        start = TrimStart(start, end);
        end = TrimEnd(start, end);
        if (start >= end || possible.Count == 0)
            return;

        if (_tokens[start].IsText("if") &&
            TryParseCondition(start, out var predicate, out _) &&
            predicate.VarName == _enumVar)
        {
            ParseIf(start, end, possible);
            return;
        }

        var body = _tokens.SliceSource(_source, start, end);
        foreach (var value in possible)
            AssignBody(value, body);
    }

    private void AssignBody(int value, string body)
    {
        if (Environment.GetEnvironmentVariable("IB2_DEBUG_MAP_VALUE") is { Length: > 0 } debugValueText &&
            int.TryParse(debugValueText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var debugValue) &&
            debugValue == value)
        {
            Console.WriteLine($"    debug-map[{value}]: {TrimForDebug(body, 260)}");
        }

        if (IsGotoOnly(body) &&
            _bodies.TryGetValue(value, out var existing) &&
            !IsGotoOnly(existing))
        {
            return;
        }

        _bodies[value] = body;
    }

    private static bool IsGotoOnly(string body)
    {
        var compact = body.Replace("\r", string.Empty, StringComparison.Ordinal)
            .Replace("\n", string.Empty, StringComparison.Ordinal)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace("\t", string.Empty, StringComparison.Ordinal)
            .Trim(';');
        return compact.StartsWith("gotolbl_", StringComparison.Ordinal) ||
               compact.StartsWith("gotolbl", StringComparison.Ordinal);
    }

    private static string TrimForDebug(string value, int limit)
    {
        value = value.Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
        return value.Length <= limit ? value : value[..limit] + "...";
    }

    private void ParseIf(int ifIndex, int limit, HashSet<int> possible)
    {
        var cursor = ifIndex;
        var remaining = possible.ToHashSet();

        while (cursor < limit)
        {
            Predicate? predicate = null;
            int bodyStart;

            if (_tokens[cursor].IsText("if") || _tokens[cursor].IsText("elseif"))
            {
                if (!TryParseCondition(cursor, out var parsed, out var thenIndex))
                {
                    MapBlock(cursor, limit, remaining);
                    return;
                }

                predicate = parsed;
                bodyStart = thenIndex + 1;
            }
            else if (_tokens[cursor].IsText("else"))
            {
                bodyStart = cursor + 1;
            }
            else
            {
                return;
            }

            var boundary = FindClauseBoundary(bodyStart, limit);
            var bodyEnd = boundary.Index;

            HashSet<int> branchValues;
            if (predicate == null)
            {
                branchValues = remaining.ToHashSet();
                remaining.Clear();
            }
            else if (predicate.Value.VarName == _enumVar)
            {
                branchValues = remaining.Where(predicate.Value.Evaluate).ToHashSet();
                remaining.ExceptWith(branchValues);
            }
            else
            {
                MapBlock(cursor, limit, remaining);
                return;
            }

            DebugBranch(predicate, branchValues, bodyStart, bodyEnd);
            MapBlock(bodyStart, bodyEnd, branchValues);

            if (boundary.Kind == ClauseBoundaryKind.End)
            {
                var continuationStart = boundary.Index + 1;
                if (remaining.Count > 0 && continuationStart < limit)
                    MapBlock(continuationStart, limit, remaining);
                return;
            }

            if (boundary.Kind == ClauseBoundaryKind.None)
                return;

            cursor = boundary.Index;
        }
    }

    private void DebugBranch(Predicate? predicate, HashSet<int> branchValues, int bodyStart, int bodyEnd)
    {
        if (Environment.GetEnvironmentVariable("IB2_DEBUG_MAP_VALUE") is not { Length: > 0 } debugValueText ||
            !int.TryParse(debugValueText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var debugValue) ||
            !branchValues.Contains(debugValue))
        {
            return;
        }

        var predText = predicate == null
            ? "else"
            : predicate.Value.VarName + " " + predicate.Value.Operator + " " + predicate.Value.Value.ToString(CultureInfo.InvariantCulture);
        Console.WriteLine($"    debug-branch[{debugValue}]: {predText}; body={TrimForDebug(_tokens.SliceSource(_source, bodyStart, Math.Min(bodyEnd, bodyStart + 24)), 180)}");
    }

    private ClauseBoundary FindClauseBoundary(int start, int limit)
    {
        var depth = 0;
        for (var i = start; i < limit; i++)
        {
            var token = _tokens[i];
            if (depth == 0)
            {
                if (token.IsText("elseif"))
                    return new ClauseBoundary(i, ClauseBoundaryKind.ElseIf);
                if (token.IsText("else"))
                    return new ClauseBoundary(i, ClauseBoundaryKind.Else);
                if (token.IsText("end"))
                    return new ClauseBoundary(i, ClauseBoundaryKind.End);
            }

            if (StartsBlock(i))
            {
                depth++;
                continue;
            }

            if (token.IsText("end") || token.IsText("until"))
                depth = Math.Max(0, depth - 1);
        }

        return new ClauseBoundary(limit, ClauseBoundaryKind.None);
    }

    private bool StartsBlock(int index)
    {
        var token = _tokens[index];
        if (token.IsText("if") || token.IsText("for") || token.IsText("while") || token.IsText("function") || token.IsText("repeat"))
            return true;

        if (!token.IsText("do"))
            return false;

        var previous = _tokens.PreviousSignificant(index);
        if (previous < 0)
            return true;

        return _tokens[previous].IsText(";") || _tokens[previous].IsText("then") || _tokens[previous].IsText("else") ||
               _tokens[previous].IsText("elseif") || _tokens[previous].IsText("do");
    }

    private bool TryParseCondition(int ifOrElseIfIndex, out Predicate predicate, out int thenIndex)
    {
        predicate = default;
        thenIndex = -1;

        for (var i = ifOrElseIfIndex + 1; i < _tokens.Count; i++)
        {
            if (_tokens[i].IsText("then"))
            {
                thenIndex = i;
                break;
            }
        }

        if (thenIndex < 0)
            return false;

        for (var i = ifOrElseIfIndex + 1; i + 2 < thenIndex; i++)
        {
            var op = _tokens[i + 1].Text;
            if (op is not ("<" or "<=" or ">" or ">=" or "==" or "~="))
                continue;

            if (_tokens[i].Kind == LuaTokenKind.Identifier &&
                TryParseIntegerToken(_tokens[i + 2], out var rightNumber))
            {
                predicate = new Predicate(_tokens[i].Text, op, rightNumber);
                return true;
            }

            if (TryParseIntegerToken(_tokens[i], out var leftNumber) &&
                _tokens[i + 2].Kind == LuaTokenKind.Identifier)
            {
                predicate = new Predicate(_tokens[i + 2].Text, FlipOperator(op), leftNumber);
                return true;
            }
        }

        return false;
    }

    private static bool TryParseIntegerToken(LuaToken token, out int number)
    {
        number = 0;
        return token.Kind == LuaTokenKind.Number &&
               int.TryParse(token.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out number);
    }

    private static string FlipOperator(string op) =>
        op switch
        {
            "<" => ">",
            "<=" => ">=",
            ">" => "<",
            ">=" => "<=",
            _ => op
        };

    private int MaxEnumConditionValue(int start, int end, string enumVar)
    {
        var max = -1;
        for (var i = start; i < end; i++)
        {
            if (!_tokens[i].IsText("if") && !_tokens[i].IsText("elseif"))
                continue;

            if (TryParseCondition(i, out var predicate, out _) && predicate.VarName == enumVar)
                max = Math.Max(max, predicate.Value);
        }

        return max;
    }

    private int FindFirstTopLevelIf(int start, int end)
    {
        var depth = 0;
        for (var i = start; i < end; i++)
        {
            if (depth == 0 && _tokens[i].IsText("if"))
                return i;

            if (StartsBlock(i))
            {
                depth++;
                continue;
            }

            if (_tokens[i].IsText("end") || _tokens[i].IsText("until"))
                depth = Math.Max(0, depth - 1);
        }

        return -1;
    }

    private int FindMatchingEnd(int doIndex)
    {
        var depth = 1;
        for (var i = doIndex + 1; i < _tokens.Count; i++)
        {
            if (StartsBlock(i))
            {
                depth++;
                continue;
            }

            if (!_tokens[i].IsText("end") && !_tokens[i].IsText("until"))
                continue;

            depth--;
            if (depth == 0)
                return i;
        }

        throw new InvalidOperationException("Unbalanced Lua block while locating dispatch loop.");
    }

    private int FindNextText(int start, string text)
    {
        for (var i = start; i < _tokens.Count; i++)
            if (_tokens[i].IsText(text))
                return i;
        return -1;
    }

    private int TrimStart(int start, int end)
    {
        while (start < end && _tokens[start].Text == ";")
            start++;
        return start;
    }

    private int TrimEnd(int start, int end)
    {
        while (end > start && _tokens[end - 1].Text == ";")
            end--;
        return end;
    }

    private readonly record struct Predicate(string VarName, string Operator, int Value)
    {
        public bool Evaluate(int value) =>
            Operator switch
            {
                "<=" => value <= Value,
                "<" => value < Value,
                ">" => value > Value,
                ">=" => value >= Value,
                "==" => value == Value,
                "~=" => value != Value,
                _ => false
            };
    }

    private readonly record struct ClauseBoundary(int Index, ClauseBoundaryKind Kind);

    private enum ClauseBoundaryKind
    {
        None,
        ElseIf,
        Else,
        End
    }
}
