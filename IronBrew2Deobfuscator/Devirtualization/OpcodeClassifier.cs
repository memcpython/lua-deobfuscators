using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using IronBrew2.Bytecode_Library.Bytecode;
using IronBrew2.Bytecode_Library.IR;
using IronBrew2.Obfuscator;
using IronBrew2.Obfuscator.Opcodes;

namespace IronBrew2Deobfuscator;

internal sealed class OpcodeClassifier
{
    private readonly Dictionary<string, List<HandlerCandidate>> _candidatesByBody;
    private readonly DispatchInfo _dispatch;
    private static readonly Regex SimpleAssignmentPattern = new(
        @"^(?<lhs>[^=~<>]+?)\s*(?<![<>=~])=(?![=])\s*(?<rhs>.+)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex IdentifierPattern = new(
        @"^[A-Za-z_]\w*$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex StackAccessPattern = new(
        @"(?<stack>[A-Za-z_]\w*)\[",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static int DebugResolvedFailureCount;

    private readonly record struct ResolvedSet(string Base, string Index, string Value);

    public OpcodeClassifier(DispatchInfo dispatch)
    {
        _dispatch = dispatch;
        _candidatesByBody = BuildCandidates()
            .GroupBy(c => c.CanonicalBody)
            .ToDictionary(g => g.Key, g => g.ToList());
    }

    public Dictionary<int, HandlerInfo> Classify()
    {
        var result = new Dictionary<int, HandlerInfo>();
        var debugClassify = Environment.GetEnvironmentVariable("IB2_DEBUG_CLASSIFY") == "1";
        var debugUnknowns = 0;
        foreach (var (vIndex, body) in _dispatch.Bodies.OrderBy(p => p.Key))
        {
            if (TryClassifySuper(body, out var sequence))
            {
                result[vIndex] = new HandlerInfo { VIndex = vIndex, Body = body, SuperSequence = sequence };
                continue;
            }

            if (TryClassifyBasic(body, out var basic))
            {
                result[vIndex] = new HandlerInfo { VIndex = vIndex, Body = body, Basic = basic };
                continue;
            }

            if (debugClassify && debugUnknowns++ < 24)
                DebugUnknown(vIndex, body);

            result[vIndex] = new HandlerInfo { VIndex = vIndex, Body = body };
        }

        return result;
    }

    private void DebugUnknown(int vIndex, string body)
    {
        Console.WriteLine($"    debug: unknown v{vIndex:D4}: {TrimForDebug(body, 320)}");
        var parts = SplitSuperOperator(StripDispatchScaffolding(body));
        Console.WriteLine($"    debug:   parts={parts.Count}");
        for (var i = 0; i < Math.Min(parts.Count, 12); i++)
        {
            if (TryClassifyBasic(parts[i], out var part))
                Console.WriteLine($"    debug:   part[{i}]={part.Name}");
            else
                Console.WriteLine($"    debug:   part[{i}]=? {TrimForDebug(parts[i], 260)}");
        }
    }

    private static string TrimForDebug(string value, int limit)
    {
        value = value.Replace("\r", " ", StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();
        return value.Length <= limit ? value : value[..limit] + "...";
    }

    private bool TryClassifySuper(string body, out IReadOnlyList<HandlerCandidate> sequence)
    {
        sequence = Array.Empty<HandlerCandidate>();
        body = StripDispatchScaffolding(body);
        var parts = SplitSuperOperator(body);
        if (parts.Count <= 1)
            return false;

        var candidates = new List<HandlerCandidate>();
        foreach (var part in parts)
        {
            if (!TryClassifyBasic(part, out var candidate))
                return false;

            candidates.Add(candidate);
        }

        sequence = candidates;
        return true;
    }

    private bool TryClassifyBasic(string body, out HandlerCandidate candidate)
    {
        body = StripDispatchScaffolding(body);

        if (body.Contains("__index", StringComparison.Ordinal) && body.Contains("__newindex", StringComparison.Ordinal))
        {
            candidate = new HandlerCandidate
            {
                Name = "OpClosure",
                CanonicalBody = LuaTokenizer.Canonicalize(body)
            };
            return true;
        }

        if (body.Contains("..", StringComparison.Ordinal) && body.Contains("for", StringComparison.Ordinal))
        {
            candidate = new HandlerCandidate
            {
                Name = "OpConcat",
                CanonicalBody = LuaTokenizer.Canonicalize(body)
            };
            return true;
        }

        var canonical = LuaTokenizer.Canonicalize(body);
        if (LooksLikeTForLoop(canonical))
        {
            candidate = new HandlerCandidate
            {
                Name = "OpTForLoop",
                CanonicalBody = canonical
            };
            return true;
        }

        if (_candidatesByBody.TryGetValue(canonical, out var candidates) && candidates.Count > 0)
        {
            candidate = candidates[0];
            return true;
        }

        if (TryClassifyDecompiledHandler(body, canonical, out candidate))
            return true;

        if (TryClassifyForkCall(body, canonical, out candidate))
            return true;

        candidate = null!;
        return false;
    }

    private bool TryClassifyDecompiledHandler(string body, string canonical, out HandlerCandidate candidate)
    {
        candidate = null!;
        if (!body.Contains(_dispatch.InstVar, StringComparison.Ordinal) &&
            !body.Contains(_dispatch.InstrPointVar, StringComparison.Ordinal))
            return false;

        var facts = new Dictionary<string, string>(StringComparer.Ordinal);
        var sets = new List<ResolvedSet>();
        var normalizedReturns = new List<string>();
        var normalizedCalls = new List<string>();
        var assignedCalls = new List<(string Lhs, string Call)>();
        var ipAssignments = new List<string>();

        foreach (var rawLine in body.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 ||
                line.StartsWith("local ", StringComparison.Ordinal) ||
                line.StartsWith("::", StringComparison.Ordinal) ||
                line.StartsWith("goto ", StringComparison.Ordinal))
            {
                continue;
            }

            if (line.StartsWith("do return", StringComparison.Ordinal))
            {
                var value = line["do return".Length..].Trim();
                if (value.EndsWith("end", StringComparison.Ordinal))
                    value = value[..^3].Trim();
                normalizedReturns.Add(value.Length == 0 ? "return" : ResolveExpression(value, facts));
                continue;
            }

            var assignment = SimpleAssignmentRegex().Match(line);
            if (assignment.Success)
            {
                var lhsText = assignment.Groups["lhs"].Value.Trim();
                var rhsText = assignment.Groups["rhs"].Value.Trim();
                var lhs = ResolveExpression(lhsText, facts, resolveIdentifier: false);
                var rhs = ResolveExpression(rhsText, facts);

                if (string.Equals(lhsText, _dispatch.InstrPointVar, StringComparison.Ordinal))
                    ipAssignments.Add(rhs);

                if (IsSimpleIdentifier(lhsText))
                {
                    facts[lhsText] = rhs;
                    if (LooksLikeCall(rhs))
                        assignedCalls.Add((lhsText, rhs));
                }
                else if (TryParseIndexed(lhs, out var targetBase, out var targetIndex))
                {
                    sets.Add(new ResolvedSet(targetBase, targetIndex, rhs));
                }

                continue;
            }

            normalizedCalls.Add(ResolveExpression(line, facts));
        }

        var name = ClassifyResolvedBody(sets, normalizedReturns, normalizedCalls, assignedCalls, ipAssignments);
        if (name.Length == 0)
        {
            if (Environment.GetEnvironmentVariable("IB2_DEBUG_RESOLVE") == "1" && DebugResolvedFailureCount++ < 48)
            {
                Console.WriteLine($"    debug-resolve: sets={sets.Count}, returns={normalizedReturns.Count}, calls={normalizedCalls.Count}, assignedCalls={assignedCalls.Count}, ip={string.Join(",", ipAssignments.Take(4))}");
                foreach (var set in sets.Take(5))
                    Console.WriteLine($"    debug-resolve:   set {set.Base}[{set.Index}] = {set.Value}");
                foreach (var call in normalizedCalls.Take(3))
                    Console.WriteLine($"    debug-resolve:   call {call}");
                Console.WriteLine($"    debug-resolve:   body {TrimForDebug(body, 300)}");
            }

            return false;
        }

        candidate = new HandlerCandidate
        {
            Name = name,
            CanonicalBody = canonical
        };
        return true;
    }

    private string ClassifyResolvedBody(
        IReadOnlyList<ResolvedSet> sets,
        IReadOnlyList<string> returns,
        IReadOnlyList<string> calls,
        IReadOnlyList<(string Lhs, string Call)> assignedCalls,
        IReadOnlyList<string> ipAssignments)
    {
        if (returns.Count > 0)
        {
            var ret = returns[^1];
            if (ret == "return")
                return "OpReturnB1";

            var stack = DetectStackFromExpression(ret);
            if (stack.Length > 0 && WithStack(ret, stack) == "S[I2]")
                return "OpReturnB2";

            if (stack.Length > 0 && LooksLikeResolvedUnpackCall(WithStack(ret, stack), "I3"))
                return "OpTailCall";
        }

        if (ipAssignments.Any(v => v == "I3"))
            return "OpJmp";

        foreach (var set in sets.AsEnumerable().Reverse())
        {
            var stack = DetectStackFromExpression(set.Base);
            if (stack.Length == 0 && IsSimpleIdentifier(set.Base))
                stack = set.Base;
            if (stack.Length == 0)
                stack = DetectStackFromExpression(set.Value);
            if (stack.Length == 0)
                continue;

            var targetBase = WithStack(set.Base, stack);
            var index = WithStack(set.Index, stack);
            var value = WithStack(set.Value, stack);
            var target = targetBase + "[" + index + "]";

            if (target == "S[I2]")
            {
                var simple = ClassifyStackAssignment(value);
                if (simple.Length > 0)
                    return simple;

                var call = ClassifyAssignedCall(value);
                if (call.Length > 0)
                    return call;
            }

            var table = ClassifyTableSet(target, value);
            if (table.Length > 0)
                return table;
        }

        foreach (var (_, call) in assignedCalls.AsEnumerable().Reverse())
        {
            var stack = DetectStackFromExpression(call);
            if (stack.Length == 0)
                continue;

            var name = ClassifyAssignedCall(WithStack(call, stack));
            if (name.Length > 0)
                return name;
        }

        foreach (var call in calls.AsEnumerable().Reverse())
        {
            var stack = DetectStackFromExpression(call);
            if (stack.Length == 0)
                continue;

            var name = ClassifyStatementCall(WithStack(call, stack));
            if (name.Length > 0)
                return name;
        }

        return string.Empty;
    }

    private static string ClassifyStackAssignment(string value)
    {
        if (value == "I3")
            return "OpLoadK";
        if (value == "S[I3]")
            return "OpMove";
        if (value == "{}")
            return "OpNewTableB0";
        if (value == "(notS[I3])" || value == "notS[I3]")
            return "OpNot";
        if (value == "#S[I3]")
            return "OpLen";
        if (value == "S[I3][S[I4]]")
            return "OpGetTable";
        if (value == "S[I3][I4]")
            return "OpGetTableConst";
        if (value.EndsWith("[I3]", StringComparison.Ordinal) && !value.StartsWith("S[", StringComparison.Ordinal))
            return "OpGetGlobal";

        var binary = ClassifyBinary(value);
        if (binary.Length > 0)
            return binary;

        return string.Empty;
    }

    private static string ClassifyBinary(string value)
    {
        foreach (var (op, name) in new[]
                 {
                     ("+", "OpAdd"),
                     ("-", "OpSub"),
                     ("*", "OpMul"),
                     ("/", "OpDiv"),
                     ("%", "OpMod"),
                     ("^", "OpPow")
                 })
        {
            var parts = SplitBinary(value, op);
            if (parts == null)
                continue;

            var (left, right) = parts.Value;
            return (left, right) switch
            {
                ("S[I3]", "S[I4]") => name,
                ("S[I3]", "I4") => name + "C",
                ("I3", "S[I4]") => name + "B",
                ("I3", "I4") => name + "BC",
                _ => string.Empty
            };
        }

        return string.Empty;
    }

    private static (string Left, string Right)? SplitBinary(string value, string op)
    {
        var depth = 0;
        for (var i = value.Length - 1; i >= 0; i--)
        {
            var ch = value[i];
            if (ch is ']' or ')')
            {
                depth++;
                continue;
            }
            if (ch is '[' or '(')
            {
                depth--;
                continue;
            }

            if (depth == 0 && i + op.Length <= value.Length && value.AsSpan(i, op.Length).SequenceEqual(op.AsSpan()))
                return (value[..i], value[(i + op.Length)..]);
        }

        return null;
    }

    private static string ClassifyTableSet(string target, string value)
    {
        if (!target.StartsWith("S[I2][", StringComparison.Ordinal) || !target.EndsWith("]", StringComparison.Ordinal))
            return string.Empty;

        var key = target["S[I2][".Length..^1];
        return (key, value) switch
        {
            ("S[I3]", "S[I4]") => "OpSetTable",
            ("I3", "S[I4]") => "OpSetTableB",
            ("S[I3]", "I4") => "OpSetTableC",
            ("I3", "I4") => "OpSetTableBC",
            _ => string.Empty
        };
    }

    private static string ClassifyAssignedCall(string value)
    {
        if (value == "S[I2]()")
            return "OpCallB1C2";
        if (value == "S[I2](S[I2+1])")
            return "OpCallC2B2";
        if (LooksLikeResolvedUnpackCall(value, "I3"))
            return "OpCallC2";
        if (LooksLikeResolvedUnpackCall(value, "TOP"))
            return "OpCallB0C2";

        return string.Empty;
    }

    private static string ClassifyStatementCall(string value)
    {
        if (value == "S[I2]()")
            return "OpCallB1C1";
        if (value == "S[I2](S[I2+1])")
            return "OpCallC1B2";
        if (LooksLikeResolvedUnpackCall(value, "I3"))
            return "OpCallC1";
        if (LooksLikeResolvedUnpackCall(value, "TOP"))
            return "OpCallB0C1";

        return string.Empty;
    }

    private static bool LooksLikeResolvedUnpackCall(string value, string limit) =>
        value.StartsWith("S[I2](", StringComparison.Ordinal) &&
        value.Contains("(S,I2+1," + limit + ")", StringComparison.Ordinal);

    private string ResolveExpression(string expression, Dictionary<string, string> facts, bool resolveIdentifier = true)
    {
        var value = CompactForPattern(expression);
        if (resolveIdentifier && facts.TryGetValue(value, out var known))
            return known;

        if (string.Equals(value, _dispatch.InstVar, StringComparison.Ordinal))
            return "I";
        if (string.Equals(value, _dispatch.InstrPointVar, StringComparison.Ordinal))
            return "IP";

        if (value is "{}")
            return value;

        if (value.StartsWith("not", StringComparison.Ordinal) && value.Length > 3)
            return "not" + ResolveExpression(value[3..], facts);

        if (value.StartsWith("#", StringComparison.Ordinal) && value.Length > 1)
            return "#" + ResolveExpression(value[1..], facts);

        var binary = TryResolveBinary(value, facts);
        if (binary != null)
            return binary;

        if (TryParseCall(value, out var callFunc, out var callArgs))
        {
            var func = ResolveExpression(callFunc, facts);
            var args = callArgs.Select(arg => ResolveExpression(arg, facts)).ToArray();
            return func + "(" + string.Join(",", args) + ")";
        }

        if (TryParseIndexed(value, out var baseExpr, out var indexExpr))
        {
            var resolvedBase = ResolveExpression(baseExpr, facts);
            var resolvedIndex = ResolveExpression(indexExpr, facts);
            if (resolvedBase == "I" && int.TryParse(resolvedIndex, out var instField))
                return "I" + instField.ToString();
            return resolvedBase + "[" + resolvedIndex + "]";
        }

        return value;
    }

    private string? TryResolveBinary(string value, Dictionary<string, string> facts)
    {
        foreach (var op in new[] { "..", "+", "-", "*", "/", "%", "^" })
        {
            var split = SplitBinary(value, op);
            if (split == null)
                continue;

            var left = ResolveExpression(split.Value.Left, facts);
            var right = ResolveExpression(split.Value.Right, facts);
            return left + op + right;
        }

        return null;
    }

    private static bool TryParseCall(string value, out string func, out IReadOnlyList<string> args)
    {
        func = string.Empty;
        args = Array.Empty<string>();
        if (!value.EndsWith(")", StringComparison.Ordinal))
            return false;

        var open = FindTopLevelCallOpen(value);
        if (open <= 0)
            return false;

        func = value[..open];
        args = SplitArguments(value[(open + 1)..^1]);
        return true;
    }

    private static int FindTopLevelCallOpen(string value)
    {
        var depth = 0;
        for (var i = value.Length - 1; i >= 0; i--)
        {
            var ch = value[i];
            if (ch == ')')
            {
                depth++;
                continue;
            }

            if (ch == '(')
            {
                depth--;
                if (depth == 0)
                    return i;
            }
        }

        return -1;
    }

    private static IReadOnlyList<string> SplitArguments(string value)
    {
        if (value.Length == 0)
            return Array.Empty<string>();

        var result = new List<string>();
        var depth = 0;
        var start = 0;
        for (var i = 0; i < value.Length; i++)
        {
            var ch = value[i];
            if (ch is '(' or '[' or '{')
                depth++;
            else if (ch is ')' or ']' or '}')
                depth--;
            else if (ch == ',' && depth == 0)
            {
                result.Add(value[start..i]);
                start = i + 1;
            }
        }

        result.Add(value[start..]);
        return result;
    }

    private static bool TryParseIndexed(string value, out string baseExpr, out string indexExpr)
    {
        baseExpr = string.Empty;
        indexExpr = string.Empty;
        if (!value.EndsWith("]", StringComparison.Ordinal))
            return false;

        var depth = 0;
        for (var i = value.Length - 1; i >= 0; i--)
        {
            var ch = value[i];
            if (ch == ']')
            {
                depth++;
                continue;
            }

            if (ch == '[')
            {
                depth--;
                if (depth == 0)
                {
                    baseExpr = value[..i];
                    indexExpr = value[(i + 1)..^1];
                    return baseExpr.Length > 0;
                }
            }
        }

        return false;
    }

    private static string WithStack(string value, string stack)
    {
        if (value == stack)
            return "S";

        var indexed = value.Replace(stack + "[", "S[", StringComparison.Ordinal);
        return Regex.Replace(
            indexed,
            @"(?<![A-Za-z0-9_])" + Regex.Escape(stack) + @"(?![A-Za-z0-9_])",
            "S",
            RegexOptions.CultureInvariant);
    }

    private static string DetectStackFromExpression(string expression)
    {
        var match = StackAccessRegex().Match(expression);
        return match.Success ? match.Groups["stack"].Value : string.Empty;
    }

    private static bool LooksLikeCall(string expression) =>
        expression.EndsWith(")", StringComparison.Ordinal) && expression.Contains('(');

    private static bool IsSimpleIdentifier(string value) =>
        IdentifierRegex().IsMatch(value);

    private static Regex SimpleAssignmentRegex() => SimpleAssignmentPattern;

    private static Regex IdentifierRegex() => IdentifierPattern;

    private static Regex StackAccessRegex() => StackAccessPattern;

    private bool TryClassifyForkCall(string body, string canonical, out HandlerCandidate candidate)
    {
        candidate = null!;
        var compact = CompactForPattern(body);

        if (compact.Contains(_dispatch.InstrPointVar + "=" + _dispatch.InstrPointVar + "+1", StringComparison.Ordinal) &&
            compact.Contains(_dispatch.InstVar + "=" + _dispatch.InstrVar + "[" + _dispatch.InstrPointVar + "]", StringComparison.Ordinal))
            return false;

        var name = TryDetectGenericForkCall(compact);
        if (name.Length == 0)
        {
            name =
            LooksLikeForkCallWithFixedResults(compact, "+1," + _dispatch.InstVar + "[3]))}") ? "OpCall" :
            LooksLikeForkCallWithFixedResults(compact, "+1,o))}") ? "OpCallB0" :
            compact.Contains("K(n[", StringComparison.Ordinal) && compact.Contains("](n[", StringComparison.Ordinal) && compact.Contains("+1]))", StringComparison.Ordinal) && compact.Contains("o=", StringComparison.Ordinal) ? "OpCallC0B2" :
            compact.Contains("K(n[", StringComparison.Ordinal) && compact.Contains("](N(n,", StringComparison.Ordinal) && compact.Contains("+1," + _dispatch.InstVar + "[3])))", StringComparison.Ordinal) && compact.Contains("o=", StringComparison.Ordinal) ? "OpCallC0" :
            compact.Contains("K(n[", StringComparison.Ordinal) && compact.Contains("](N(n,", StringComparison.Ordinal) && compact.Contains("+1,o)))", StringComparison.Ordinal) && compact.Contains("o=", StringComparison.Ordinal) ? "OpCallB0C0" :
            compact.Contains("=n[", StringComparison.Ordinal) && compact.Contains("](n[", StringComparison.Ordinal) && compact.Contains("+1])", StringComparison.Ordinal) ? "OpCallC2B2" :
            compact.Contains("=n[", StringComparison.Ordinal) && compact.Contains("](N(n,", StringComparison.Ordinal) && compact.Contains("+1," + _dispatch.InstVar + "[3]))", StringComparison.Ordinal) ? "OpCallC2" :
            compact.Contains("=n[", StringComparison.Ordinal) && compact.Contains("](N(n,", StringComparison.Ordinal) && compact.Contains("+1,o))", StringComparison.Ordinal) ? "OpCallB0C2" :
            compact.Contains("n[", StringComparison.Ordinal) && compact.Contains("](n[", StringComparison.Ordinal) && compact.Contains("+1])", StringComparison.Ordinal) ? "OpCallC1B2" :
            compact.Contains("n[", StringComparison.Ordinal) && compact.Contains("](N(n,", StringComparison.Ordinal) && compact.Contains("+1," + _dispatch.InstVar + "[3]))", StringComparison.Ordinal) ? "OpCallC1" :
            compact.Contains("n[", StringComparison.Ordinal) && compact.Contains("](N(n,", StringComparison.Ordinal) && compact.Contains("+1,o))", StringComparison.Ordinal) ? "OpCallB0C1" :
            string.Empty;
        }

        if (name.Length == 0)
            return false;

        candidate = new HandlerCandidate
        {
            Name = name,
            CanonicalBody = canonical
        };
        return true;
    }

    private string TryDetectGenericForkCall(string compact)
    {
        var instLimit = _dispatch.InstVar + "[3]";
        var topVar = DetectLikelyTopVar(compact);

        if (LooksLikeGenericFixedResultCall(compact, instLimit))
            return "OpCall";
        if (topVar.Length > 0 && LooksLikeGenericFixedResultCall(compact, topVar))
            return "OpCallB0";
        if (LooksLikeGenericFixedResultNoArgCall(compact))
            return "OpCallB1";
        if (LooksLikeGenericFixedResultSingleArgCall(compact))
            return "OpCallB2";

        if (LooksLikeGenericOpenResultCall(compact, instLimit))
            return "OpCallC0";
        if (topVar.Length > 0 && LooksLikeGenericOpenResultCall(compact, topVar))
            return "OpCallB0C0";
        if (LooksLikeGenericOpenResultNoArgCall(compact))
            return "OpCallB1C0";
        if (LooksLikeGenericOpenResultSingleArgCall(compact))
            return "OpCallC0B2";

        if (LooksLikeGenericSingleResultCall(compact, instLimit))
            return "OpCallC2";
        if (topVar.Length > 0 && LooksLikeGenericSingleResultCall(compact, topVar))
            return "OpCallB0C2";
        if (LooksLikeGenericSingleResultNoArgCall(compact))
            return "OpCallB1C2";
        if (LooksLikeGenericSingleResultSingleArgCall(compact))
            return "OpCallC2B2";

        if (LooksLikeGenericNoResultCall(compact, instLimit))
            return "OpCallC1";
        if (topVar.Length > 0 && LooksLikeGenericNoResultCall(compact, topVar))
            return "OpCallB0C1";
        if (LooksLikeGenericNoResultNoArgCall(compact))
            return "OpCallB1C1";
        if (LooksLikeGenericNoResultSingleArgCall(compact))
            return "OpCallC1B2";

        return string.Empty;
    }

    private static string DetectLikelyTopVar(string compact)
    {
        if (compact.Contains("+1,c)", StringComparison.Ordinal) || compact.Contains("+1,c))", StringComparison.Ordinal))
            return "c";
        if (compact.Contains("+1,o)", StringComparison.Ordinal) || compact.Contains("+1,o))", StringComparison.Ordinal))
            return "o";
        if (compact.Contains("+1,Top)", StringComparison.Ordinal) || compact.Contains("+1,Top))", StringComparison.Ordinal))
            return "Top";

        return string.Empty;
    }

    private static bool LooksLikeGenericFixedResultCall(string compact, string limit) =>
        Matches(compact, @"\{(?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]\([A-Za-z_]\w*\(\k<s>,[A-Za-z_]\w*\+1," + Regex.Escape(limit) + @"\)\)\},0for.*\k<s>\[[A-Za-z_]\w*\]=") ||
        compact.Contains("{n[", StringComparison.Ordinal) &&
        ContainsUnpackCallPrefix(compact) &&
        compact.Contains("+1," + limit + "))}", StringComparison.Ordinal) &&
        compact.Contains(",0for", StringComparison.Ordinal) &&
        compact.Contains("n[e]=", StringComparison.Ordinal);

    private static bool LooksLikeGenericFixedResultNoArgCall(string compact) =>
        Matches(compact, @"\{(?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]\(\)\},0for.*\k<s>\[[A-Za-z_]\w*\]=") ||
        compact.Contains("{n[", StringComparison.Ordinal) &&
        compact.Contains("]()}", StringComparison.Ordinal) &&
        compact.Contains(",0for", StringComparison.Ordinal) &&
        compact.Contains("n[e]=", StringComparison.Ordinal);

    private static bool LooksLikeGenericFixedResultSingleArgCall(string compact) =>
        Matches(compact, @"\{(?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]\(\k<s>\[[A-Za-z_]\w*\+1\]\)\},0for.*\k<s>\[[A-Za-z_]\w*\]=") ||
        compact.Contains("{n[", StringComparison.Ordinal) &&
        compact.Contains("](n[", StringComparison.Ordinal) &&
        compact.Contains("+1])}", StringComparison.Ordinal) &&
        compact.Contains(",0for", StringComparison.Ordinal) &&
        compact.Contains("n[e]=", StringComparison.Ordinal);

    private static bool LooksLikeGenericOpenResultCall(string compact, string limit) =>
        Matches(compact, @"=[A-Za-z_]\w*\((?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]\([A-Za-z_]\w*\(\k<s>,[A-Za-z_]\w*\+1," + Regex.Escape(limit) + @"\)\)\).*for.*\k<s>\[[A-Za-z_]\w*\]=") ||
        compact.Contains("=t(n[", StringComparison.Ordinal) &&
        ContainsUnpackCallPrefix(compact) &&
        compact.Contains("+1," + limit + ")))", StringComparison.Ordinal) &&
        compact.Contains("for", StringComparison.Ordinal) &&
        compact.Contains("n[e]=", StringComparison.Ordinal);

    private static bool LooksLikeGenericOpenResultNoArgCall(string compact) =>
        Matches(compact, @"=[A-Za-z_]\w*\((?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]\(\)\).*for.*\k<s>\[[A-Za-z_]\w*\]=") ||
        compact.Contains("=t(n[", StringComparison.Ordinal) &&
        compact.Contains("]())", StringComparison.Ordinal) &&
        compact.Contains("for", StringComparison.Ordinal) &&
        compact.Contains("n[e]=", StringComparison.Ordinal);

    private static bool LooksLikeGenericOpenResultSingleArgCall(string compact) =>
        Matches(compact, @"=[A-Za-z_]\w*\((?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]\(\k<s>\[[A-Za-z_]\w*\+1\]\)\).*for.*\k<s>\[[A-Za-z_]\w*\]=") ||
        compact.Contains("=t(n[", StringComparison.Ordinal) &&
        compact.Contains("](n[", StringComparison.Ordinal) &&
        compact.Contains("+1]))", StringComparison.Ordinal) &&
        compact.Contains("for", StringComparison.Ordinal) &&
        compact.Contains("n[e]=", StringComparison.Ordinal);

    private static bool LooksLikeGenericSingleResultCall(string compact, string limit) =>
        Matches(compact, @"(?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]=\k<s>\[[A-Za-z_]\w*\]\([A-Za-z_]\w*\(\k<s>,[A-Za-z_]\w*\+1," + Regex.Escape(limit) + @"\)\)") ||
        compact.Contains("=n[", StringComparison.Ordinal) &&
        ContainsUnpackCallPrefix(compact) &&
        compact.Contains("+1," + limit + "))", StringComparison.Ordinal);

    private static bool LooksLikeGenericSingleResultNoArgCall(string compact) =>
        Matches(compact, @"(?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]=\k<s>\[[A-Za-z_]\w*\]\(\)") ||
        compact.Contains("=n[", StringComparison.Ordinal) &&
        compact.Contains("]()", StringComparison.Ordinal);

    private static bool LooksLikeGenericSingleResultSingleArgCall(string compact) =>
        Matches(compact, @"(?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]=\k<s>\[[A-Za-z_]\w*\]\(\k<s>\[[A-Za-z_]\w*\+1\]\)") ||
        compact.Contains("=n[", StringComparison.Ordinal) &&
        compact.Contains("](n[", StringComparison.Ordinal) &&
        compact.Contains("+1])", StringComparison.Ordinal);

    private static bool LooksLikeGenericNoResultCall(string compact, string limit) =>
        Matches(compact, @"(?<![=A-Za-z0-9_])(?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]\([A-Za-z_]\w*\(\k<s>,[A-Za-z_]\w*\+1," + Regex.Escape(limit) + @"\)\)") ||
        !compact.Contains("=n[", StringComparison.Ordinal) &&
        compact.Contains("n[", StringComparison.Ordinal) &&
        ContainsUnpackCallPrefix(compact) &&
        compact.Contains("+1," + limit + "))", StringComparison.Ordinal);

    private static bool ContainsUnpackCallPrefix(string compact) =>
        compact.Contains("](a(n,", StringComparison.Ordinal) ||
        compact.Contains("](i(n,", StringComparison.Ordinal) ||
        compact.Contains("](c(n,", StringComparison.Ordinal) ||
        compact.Contains("](f(n,", StringComparison.Ordinal) ||
        compact.Contains("](N(n,", StringComparison.Ordinal);

    private static bool LooksLikeGenericNoResultNoArgCall(string compact) =>
        Matches(compact, @"(?<![=A-Za-z0-9_])(?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]\(\)") ||
        !compact.Contains("=n[", StringComparison.Ordinal) &&
        compact.Contains("n[", StringComparison.Ordinal) &&
        compact.Contains("]()", StringComparison.Ordinal);

    private static bool LooksLikeGenericNoResultSingleArgCall(string compact) =>
        Matches(compact, @"(?<![=A-Za-z0-9_])(?<s>[A-Za-z_]\w*)\[[A-Za-z_]\w*\]\(\k<s>\[[A-Za-z_]\w*\+1\]\)") ||
        !compact.Contains("=n[", StringComparison.Ordinal) &&
        compact.Contains("n[", StringComparison.Ordinal) &&
        compact.Contains("](n[", StringComparison.Ordinal) &&
        compact.Contains("+1])", StringComparison.Ordinal);

    private static bool Matches(string value, string pattern) =>
        Regex.IsMatch(value, pattern, RegexOptions.CultureInvariant);

    private static bool LooksLikeForkCallWithFixedResults(string compact, string argLimitPattern) =>
        compact.Contains("{n[", StringComparison.Ordinal) &&
        compact.Contains("](N(n,", StringComparison.Ordinal) &&
        compact.Contains(argLimitPattern, StringComparison.Ordinal) &&
        compact.Contains(",0for", StringComparison.Ordinal) &&
        compact.Contains("n[e]=", StringComparison.Ordinal);

    private static string CompactForPattern(string source)
    {
        var chars = new char[source.Length];
        var count = 0;
        foreach (var ch in source)
        {
            if (char.IsWhiteSpace(ch) || ch == ';')
                continue;

            chars[count++] = ch;
        }

        return new string(chars, 0, count);
    }

    private static bool LooksLikeTForLoop(string canonical) =>
        canonical.Contains("{|", StringComparison.Ordinal) &&
        canonical.Contains("|(|", StringComparison.Ordinal) &&
        canonical.Contains("|for|", StringComparison.Ordinal) &&
        canonical.Contains("|if|", StringComparison.Ordinal) &&
        canonical.Contains("|then|", StringComparison.Ordinal) &&
        canonical.Contains("|else|", StringComparison.Ordinal) &&
        canonical.Contains("|+|2", StringComparison.Ordinal);

    private List<string> SplitSuperOperator(string body)
    {
        var tokens = LuaTokenizer.Tokenize(body);
        var parts = new List<string>();
        var startToken = 0;

        for (var i = 0; i < tokens.Count - 9; i++)
        {
            if (!IsSuperSeparator(tokens, i, out var endToken))
                continue;

            var part = tokens.SliceSource(body, startToken, i);
            if (!string.IsNullOrWhiteSpace(part))
                parts.Add(StripDispatchScaffolding(part));

            startToken = endToken;
            i = endToken - 1;
        }

        if (parts.Count == 0)
            return parts;

        var tail = tokens.SliceSource(body, startToken, tokens.Count - 1);
        if (!string.IsNullOrWhiteSpace(tail))
            parts.Add(StripDispatchScaffolding(tail));

        return parts;
    }

    private static string StripDispatchScaffolding(string source)
    {
        source = StripLeadingLocalDeclarations(source);
        source = StripLeadingNilAssignments(source);
        var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').ToList();

        for (var i = lines.Count - 1; i >= 0; i--)
        {
            var trimmed = lines[i].Trim();
            if (trimmed.Length == 0)
            {
                lines.RemoveAt(i);
                continue;
            }

            if (trimmed.StartsWith("goto lbl_", StringComparison.Ordinal) ||
                trimmed.StartsWith("goto lbl", StringComparison.Ordinal))
            {
                lines.RemoveAt(i);
                continue;
            }

            break;
        }

        lines.RemoveAll(line =>
        {
            var trimmed = line.Trim();
            return trimmed.StartsWith("::lbl_", StringComparison.Ordinal) && trimmed.EndsWith("::", StringComparison.Ordinal);
        });

        return string.Join('\n', lines).Trim();
    }

    private static string StripLeadingNilAssignments(string source)
    {
        var tokens = LuaTokenizer.Tokenize(source);
        var cursor = 0;
        while (cursor + 2 < tokens.Count &&
               tokens[cursor].Kind == LuaTokenKind.Identifier &&
               tokens[cursor + 1].IsText("=") &&
               tokens[cursor + 2].IsText("nil"))
        {
            cursor += 3;
            if (cursor < tokens.Count && tokens[cursor].IsText(";"))
                cursor++;
        }

        return cursor == 0 ? source : tokens.SliceSource(source, cursor, tokens.Count - 1);
    }

    private bool IsSuperSeparator(IReadOnlyList<LuaToken> tokens, int i, out int endToken)
    {
        endToken = i;
        if (!tokens[i].IsText(_dispatch.InstrPointVar) ||
            !tokens[i + 1].IsText("=") ||
            !tokens[i + 2].IsText(_dispatch.InstrPointVar) ||
            !tokens[i + 3].IsText("+") ||
            !tokens[i + 4].IsText("1"))
            return false;

        var j = i + 5;
        if (tokens[j].IsText(";"))
            j++;

        if (!tokens[j].IsText(_dispatch.InstVar) ||
            !tokens[j + 1].IsText("=") ||
            !tokens[j + 2].IsText(_dispatch.InstrVar) ||
            !tokens[j + 3].IsText("[") ||
            !tokens[j + 4].IsText(_dispatch.InstrPointVar) ||
            !tokens[j + 5].IsText("]"))
            return false;

        j += 6;
        if (tokens[j].IsText(";"))
            j++;

        endToken = j;
        return true;
    }

    private static string StripLeadingLocalDeclarations(string source)
    {
        var tokens = LuaTokenizer.Tokenize(source);
        var cursor = 0;

        while (cursor < tokens.Count - 1 && tokens[cursor].IsText("local"))
        {
            var scan = cursor + 1;
            var hasAssignment = false;
            while (scan < tokens.Count - 1 && !tokens[scan].IsText(";"))
            {
                if (tokens[scan].IsText("="))
                {
                    hasAssignment = true;
                    break;
                }

                scan++;
            }

            if (hasAssignment || scan >= tokens.Count - 1 || !tokens[scan].IsText(";"))
                break;

            cursor = scan + 1;
        }

        return tokens.SliceSource(source, cursor, tokens.Count - 1);
    }

    private static IReadOnlyList<HandlerCandidate> BuildCandidates()
    {
        var dummyChunk = new Chunk
        {
            Constants = new List<Constant>(),
            Functions = new List<Chunk>(),
            Instructions = new List<Instruction>(),
            Upvalues = new List<string>()
        };
        var context = new ObfuscationContext(dummyChunk);
        context.InstructionMapping[Opcode.Move] = new OpMove { VIndex = 12345 };

        return typeof(VOpcode).Assembly.GetTypes()
            .Where(t => t.IsSubclassOf(typeof(VOpcode)) && !t.IsAbstract)
            .Where(t => t != typeof(OpMutated) && t != typeof(OpSuperOperator) && t != typeof(OpClosure))
            .Select(t => (Type: t, Opcode: (VOpcode)Activator.CreateInstance(t)!))
            .Select(item =>
            {
                var body = item.Opcode.GetObfuscated(context)
                    .Replace("OP_ENUM", "1", StringComparison.Ordinal)
                    .Replace("OP_A", "2", StringComparison.Ordinal)
                    .Replace("OP_B", "3", StringComparison.Ordinal)
                    .Replace("OP_C", "4", StringComparison.Ordinal);

                return new HandlerCandidate
                {
                    Name = item.Type.Name,
                    CanonicalBody = LuaTokenizer.Canonicalize(body)
                };
            })
            .ToList();
    }
}
