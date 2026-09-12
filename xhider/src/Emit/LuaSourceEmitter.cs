using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using XHiderDeobfuscator.Model;

namespace XHiderDeobfuscator.Emit;

public static partial class LuaSourceEmitter
{
    private const string Watermark = "-- This file was deobfuscated by VX [ https://discord.gg/qa2fwcB7K ]";

    public static EmitResult Emit(
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers)
    {
        var functions = BuildFunctions(image);
        var scaffold = AnalyzeProtectionScaffold(functions, image, handlers);
        var analyses = AnalyzeFunctions(functions, image, handlers, scaffold);
        var visibleFunctions = functions
            .Where(function => !scaffold.HiddenFunctions.Contains(function.Index))
            .OrderBy(function => function.Index)
            .ToArray();
        for (var pass = 0; pass <= functions.Count + 1; pass++)
        {
            var captureCount = analyses.Values.Sum(analysis => analysis.Captures.Count);
            var unknown = 0;
            var sources = new Dictionary<int, string>();

            foreach (var function in visibleFunctions)
            {
                var result = EmitFunction(function, image, handlers, analyses, scaffold);
                unknown += result.Unknown;
                sources[function.Index] = SimplifyArgumentAliases(
                    SimplifyResultTemporaries(result.Source));
            }

            if (analyses.Values.Sum(analysis => analysis.Captures.Count) == captureCount)
            {
                sources = InlineClosureHelpers(sources, analyses);
                var rootSource = sources[1];
                sources.Remove(1);

                var output = new StringBuilder();
                output.AppendLine(Watermark);
                output.AppendLine();
                var combined = string.Join("\n", sources.Values.Append(rootSource));
                if (combined.Contains("unpack_values", StringComparison.Ordinal))
                {
                    output.AppendLine("local unpack_values = table.unpack or unpack");
                    output.AppendLine();
                }

                foreach (var function in visibleFunctions.Where(function => sources.ContainsKey(function.Index)))
                {
                    output.Append("local ").AppendLine(analyses[function.Index].Name);
                }
                if (sources.Count > 0)
                {
                    output.AppendLine();
                    foreach (var function in visibleFunctions.Where(function => sources.ContainsKey(function.Index)))
                    {
                        output.Append(sources[function.Index]);
                    }
                }

                output.Append(ExtractRootBody(rootSource));
                return new EmitResult(
                    NormalizeBlankLines(StructureConditionalChains(output.ToString())),
                    unknown);
            }
        }

        throw new InvalidOperationException("Xhider closure capture analysis did not converge.");
    }

    private static FunctionResult EmitFunction(
        FunctionSlice function,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers,
        IReadOnlyDictionary<int, FunctionAnalysis> analyses,
        ProtectionScaffold scaffold)
    {
        var analysis = analyses[function.Index];
        var state = new SymbolicState(analysis);
        var statements = new SortedDictionary<int, List<string>>();
        var scaffoldInstructions = scaffold.SkippedInstructions.TryGetValue(
            function.Index,
            out var protectedInstructions)
            ? protectedInstructions
            : [];
        var suppressedControlFlow = new HashSet<int>(scaffoldInstructions);
        var skippedInstructions = scaffoldInstructions.Count > 0
            ? new HashSet<int>(scaffoldInstructions)
            : [];
        var prefixes = new Dictionary<int, List<string>>();
        var stateRestores = new Dictionary<int, StateSnapshot>();
        var loopEnds = new Dictionary<int, EnvironmentScope>();
        var suffixes = new List<string>();
        var plainReturnPcs = new HashSet<int>();
        var unknown = 0;

        for (var pc = function.StartPc; pc <= function.EndPc; pc++)
        {
            if (stateRestores.Remove(pc, out var snapshot))
            {
                state.Restore(snapshot);
            }
            if (loopEnds.Remove(pc, out var loopParent))
            {
                state.Environment = loopParent;
            }
            if (skippedInstructions.Contains(pc))
            {
                continue;
            }

            var instruction = image.Instructions[pc - 1];
            var semantic = handlers.TryGetValue(instruction.Opcode, out var value)
                ? value
                : new HandlerSemantic(SemanticKind.Nop);

            if (semantic.Kind == SemanticKind.BranchTruePop &&
                TryHandleStructuredBranch(
                    state,
                    instruction,
                    image,
                    handlers,
                    analyses,
                    function,
                    statements,
                    prefixes,
                    stateRestores,
                    loopEnds,
                    suffixes,
                    plainReturnPcs,
                    suppressedControlFlow,
                    skippedInstructions,
                    ref pc))
            {
                continue;
            }

            if (semantic.Kind == SemanticKind.NumericFor &&
                TryHandleNumericFor(
                    state,
                    instruction,
                    image,
                    handlers,
                    function,
                    statements,
                    prefixes,
                    loopEnds,
                    suppressedControlFlow,
                    skippedInstructions))
            {
                continue;
            }

            if (semantic.Kind == SemanticKind.GenericFor &&
                TryHandleGenericFor(
                    state,
                    instruction,
                    image,
                    handlers,
                    function,
                    statements,
                    prefixes,
                    loopEnds,
                    suppressedControlFlow,
                    skippedInstructions))
            {
                continue;
            }

            if (semantic.Kind == SemanticKind.Jump &&
                TryHandleStructuredJump(
                    instruction,
                    image,
                    handlers,
                    function,
                    statements,
                    suppressedControlFlow))
            {
                continue;
            }

            var lines = ProcessInstruction(
                state,
                semantic,
                instruction,
                image,
                function,
                analyses,
                ref unknown);
            if (plainReturnPcs.Contains(pc))
            {
                lines = lines.Select(UnwrapReturn).ToArray();
            }
            AddStatements(statements, pc, lines);
        }

        var labels = CollectLabels(function, image, handlers, suppressedControlFlow);
        var output = new StringBuilder();
        var parameters = analysis.Captures.Select(analysis.CaptureName)
            .Concat(Enumerable.Range(1, analysis.ArgumentCount).Select(index => $"arg{index}"))
            .ToList();
        if (analysis.UsesVarargs)
        {
            parameters.Add("...");
        }
        output.Append(analysis.Name)
            .Append(" = function(")
            .Append(string.Join(", ", parameters))
            .AppendLine(")");
        if (state.LocalVariables.Count > 0)
        {
            output.Append("    local ").AppendLine(string.Join(", ", state.LocalVariables.Order()));
        }
        for (var index = 1; index <= state.ResultCount; index++)
        {
            output.Append("    local result").AppendLine(index.ToString(CultureInfo.InvariantCulture));
        }
        for (var index = 1; index <= state.PhiCount; index++)
        {
            output.Append("    local value").AppendLine(index.ToString(CultureInfo.InvariantCulture));
        }
        var indentLevel = 1;

        for (var pc = function.StartPc; pc <= function.EndPc; pc++)
        {
            if (labels.Contains(pc))
            {
                AppendStructuredLine(output, $"::L{pc}::", ref indentLevel);
            }
            if (prefixes.TryGetValue(pc, out var prefixLines))
            {
                foreach (var line in prefixLines)
                {
                    AppendStructuredLine(output, line, ref indentLevel);
                }
            }
            if (!statements.TryGetValue(pc, out var lines))
            {
                continue;
            }
            foreach (var line in lines)
            {
                AppendStructuredLine(output, line, ref indentLevel);
            }
        }
        foreach (var suffix in suffixes)
        {
            AppendStructuredLine(output, suffix, ref indentLevel);
        }

        if (!state.Terminated)
        {
            FlushDiscarded(state.Frame.Values, output, "    ");
            AppendStructuredLine(output, "return", ref indentLevel);
        }
        output.AppendLine("end");
        output.AppendLine();
        return new FunctionResult(output.ToString(), unknown);
    }

    private static void AppendStructuredLine(
        StringBuilder output,
        string line,
        ref int indentLevel)
    {
        var trimmed = line.Trim();
        var closesBlock =
            trimmed == "end" ||
            trimmed == "else" ||
            trimmed.StartsWith("elseif ", StringComparison.Ordinal);
        if (closesBlock)
        {
            indentLevel = Math.Max(1, indentLevel - 1);
        }

        output.Append(' ', indentLevel * 4).AppendLine(trimmed);

        var opensBlock =
            trimmed == "else" ||
            trimmed.StartsWith("elseif ", StringComparison.Ordinal) ||
            (trimmed.EndsWith(" then", StringComparison.Ordinal) &&
             !trimmed.Contains(" then goto ", StringComparison.Ordinal)) ||
            trimmed.EndsWith(" do", StringComparison.Ordinal);
        if (opensBlock)
        {
            indentLevel++;
        }
    }

    private static string SimplifyResultTemporaries(string source)
    {
        var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').ToList();
        var changed = true;
        while (changed)
        {
            changed = false;
            for (var index = 0; index < lines.Count; index++)
            {
                var match = Regex.Match(
                    lines[index],
                    @"^(?<indent>\s*)result(?<id>\d+) = \{(?<call>.*)\}$");
                if (!match.Success)
                {
                    continue;
                }

                var id = match.Groups["id"].Value;
                var name = $"result{id}";
                var call = match.Groups["call"].Value;
                var usageRegex = new Regex($@"\b{Regex.Escape(name)}\b");
                var usages = lines
                    .Where((_, lineIndex) => lineIndex != index)
                    .Where(line => line.Trim() != $"local {name}")
                    .Sum(line => usageRegex.Matches(line).Count);

                if (usages == 0)
                {
                    lines[index] = $"{match.Groups["indent"].Value}{call}";
                    RemoveLocalDeclaration(lines, name);
                    changed = true;
                    continue;
                }
                if (usages != 1)
                {
                    continue;
                }

                var replaced = false;
                for (var useIndex = 0; useIndex < lines.Count; useIndex++)
                {
                    if (useIndex == index || !usageRegex.IsMatch(lines[useIndex]))
                    {
                        continue;
                    }

                    var unpackPattern = $@"unpack_values\({Regex.Escape(name)}\)";
                    if (Regex.IsMatch(lines[useIndex], unpackPattern))
                    {
                        lines[useIndex] = Regex.Replace(lines[useIndex], unpackPattern, call);
                        replaced = true;
                        break;
                    }

                    var indexPattern =
                        $@"\({Regex.Escape(name)}\)\[(?<index>[1-9][0-9]*)\]";
                    var indexMatch = Regex.Match(lines[useIndex], indexPattern);
                    if (indexMatch.Success)
                    {
                        var resultIndex = int.Parse(
                            indexMatch.Groups["index"].Value,
                            CultureInfo.InvariantCulture);
                        var replacement = resultIndex == 1
                            ? $"({call})"
                            : $"select({resultIndex}, {call})";
                        lines[useIndex] = Regex.Replace(
                            lines[useIndex],
                            indexPattern,
                            _ => replacement);
                        replaced = true;
                        break;
                    }
                }

                if (!replaced)
                {
                    continue;
                }

                lines[index] = string.Empty;
                RemoveLocalDeclaration(lines, name);
                changed = true;
            }
        }

        return string.Join(
            "\n",
            lines.Where((line, index) =>
                line.Length > 0 ||
                index == 0 ||
                (index > 0 && lines[index - 1].Length > 0))) + "\n";
    }

    private static string SimplifyArgumentAliases(string source)
    {
        var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').ToList();
        for (var index = 0; index < lines.Count; index++)
        {
            var match = Regex.Match(
                lines[index],
                @"^\s*(?<variable>v\d+(?:_\d+)?) = (?<argument>arg\d+)$");
            if (!match.Success)
            {
                continue;
            }

            var variable = match.Groups["variable"].Value;
            var assignments = lines.Count(line =>
                Regex.IsMatch(line, $@"^\s*{Regex.Escape(variable)}\s*="));
            if (assignments != 1)
            {
                continue;
            }

            var argument = match.Groups["argument"].Value;
            RemoveLocalVariable(lines, variable);
            lines[index] = string.Empty;
            for (var lineIndex = 0; lineIndex < lines.Count; lineIndex++)
            {
                if (lineIndex == index)
                {
                    continue;
                }
                lines[lineIndex] = Regex.Replace(
                    lines[lineIndex],
                    $@"\b{Regex.Escape(variable)}\b",
                    _ => argument);
            }
        }
        return string.Join("\n", lines) + "\n";
    }

    private static void RemoveLocalDeclaration(List<string> lines, string name)
    {
        for (var index = 0; index < lines.Count; index++)
        {
            if (lines[index].Trim() == $"local {name}")
            {
                lines[index] = string.Empty;
                return;
            }
        }
    }

    private static void RemoveLocalVariable(List<string> lines, string name)
    {
        for (var index = 0; index < lines.Count; index++)
        {
            var match = Regex.Match(
                lines[index],
                @"^(?<indent>\s*)local (?<names>v[\d_]+(?:,\s*v[\d_]+)*)$");
            if (!match.Success)
            {
                continue;
            }
            var names = match.Groups["names"].Value
                .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Where(candidate => candidate != name)
                .ToArray();
            if (names.Length == match.Groups["names"].Value
                    .Split(',', StringSplitOptions.RemoveEmptyEntries).Length)
            {
                continue;
            }
            lines[index] = names.Length == 0
                ? string.Empty
                : $"{match.Groups["indent"].Value}local {string.Join(", ", names)}";
            return;
        }
    }

    private static Dictionary<int, string> InlineClosureHelpers(
        Dictionary<int, string> sources,
        IReadOnlyDictionary<int, FunctionAnalysis> analyses)
    {
        var output = new Dictionary<int, string>(sources);
        foreach (var helperIndex in output.Keys.Where(index => index != 1).OrderByDescending(index => index).ToArray())
        {
            var helper = analyses[helperIndex];
            var body = ExtractFunctionBody(output[helperIndex]);
            var wrapper = new Regex(
                $@"function\(\.\.\.\)\s+return\s+{Regex.Escape(helper.Name)}\((?<arguments>[^()]*)\)\s+end");
            var replacedAny = false;

            foreach (var ownerIndex in output.Keys.Where(index => index != helperIndex).ToArray())
            {
                output[ownerIndex] = wrapper.Replace(output[ownerIndex], match =>
                {
                    var arguments = match.Groups["arguments"].Value
                        .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
                    if (arguments.Length != helper.Captures.Count + 1 ||
                        arguments[^1] != "...")
                    {
                        return match.Value;
                    }

                    var inlinedBody = body;
                    for (var captureIndex = 0; captureIndex < helper.Captures.Count; captureIndex++)
                    {
                        inlinedBody = Regex.Replace(
                            inlinedBody,
                            $@"\bupvalue{captureIndex + 1}\b",
                            _ => arguments[captureIndex]);
                    }

                    var lineStart = output[ownerIndex].LastIndexOf('\n', match.Index);
                    var baseIndent = lineStart < 0
                        ? string.Empty
                        : new string(
                            output[ownerIndex][(lineStart + 1)..match.Index]
                                .TakeWhile(char.IsWhiteSpace)
                                .ToArray());
                    var indentedBody = string.Join(
                        "\n",
                        inlinedBody.Split('\n')
                            .Select(line => line.Length == 0 ? line : $"{baseIndent}    {line}"));
                    replacedAny = true;
                    var parameters = Enumerable.Range(1, helper.ArgumentCount)
                        .Select(index => $"arg{index}")
                        .ToList();
                    if (helper.UsesVarargs)
                    {
                        parameters.Add("...");
                    }
                    return $"function({string.Join(", ", parameters)})\n{indentedBody}\n{baseIndent}end";
                });
            }

            if (replacedAny &&
                output.Where(pair => pair.Key != helperIndex)
                    .All(pair => !Regex.IsMatch(pair.Value, $@"\b{Regex.Escape(helper.Name)}\b")))
            {
                output.Remove(helperIndex);
            }
        }
        return output;
    }

    private static string ExtractFunctionBody(string source)
    {
        var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').ToList();
        while (lines.Count > 0 && lines[^1].Length == 0)
        {
            lines.RemoveAt(lines.Count - 1);
        }
        if (lines.Count < 2 || lines[^1].Trim() != "end")
        {
            throw new InvalidOperationException("Generated Lua function was malformed.");
        }

        return string.Join(
            "\n",
            lines.Skip(1).Take(lines.Count - 2).Select(line =>
                line.StartsWith("    ", StringComparison.Ordinal) ? line[4..] : line));
    }

    private static string ExtractRootBody(string rootSource)
    {
        var body = ExtractFunctionBody(rootSource);
        var lines = body.Split('\n').ToList();
        while (lines.Count > 0 && lines[^1].Length == 0)
        {
            lines.RemoveAt(lines.Count - 1);
        }
        if (lines.Count > 0 && lines[^1].Trim() == "return")
        {
            lines.RemoveAt(lines.Count - 1);
        }
        return string.Join("\n", lines) + "\n";
    }

    private static string StructureConditionalChains(string source)
    {
        var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').ToList();
        var branchRegex = new Regex(
            @"^(?<indent>\s*)if not \((?<condition>.*)\) then goto L(?<target>\d+) end$");
        var changed = true;
        while (changed)
        {
            changed = false;
            for (var start = 0; start < lines.Count; start++)
            {
                var first = branchRegex.Match(lines[start]);
                if (!first.Success)
                {
                    continue;
                }

                var indent = first.Groups["indent"].Value;
                var arms = new List<(string Condition, List<string> Body)>();
                var removedLabels = new HashSet<string>();
                string? joinTarget = null;
                var current = start;
                var end = -1;

                while (current < lines.Count)
                {
                    var branch = branchRegex.Match(lines[current]);
                    if (!branch.Success || branch.Groups["indent"].Value != indent)
                    {
                        break;
                    }

                    var target = branch.Groups["target"].Value;
                    var labelIndex = FindLabel(lines, current + 1, indent, target);
                    if (labelIndex < 0)
                    {
                        break;
                    }

                    var body = lines.GetRange(current + 1, labelIndex - current - 1);
                    var lastBodyLine = body.FindLastIndex(line => line.Trim().Length > 0);
                    var trailingJump = lastBodyLine >= 0
                        ? Regex.Match(body[lastBodyLine], $@"^{Regex.Escape(indent)}goto L(?<target>\d+)$")
                        : Match.Empty;

                    if (joinTarget is null)
                    {
                        if (!trailingJump.Success)
                        {
                            break;
                        }
                        joinTarget = trailingJump.Groups["target"].Value;
                    }

                    if (target == joinTarget)
                    {
                        arms.Add((branch.Groups["condition"].Value, body));
                        end = labelIndex;
                        break;
                    }

                    if (!trailingJump.Success ||
                        trailingJump.Groups["target"].Value != joinTarget)
                    {
                        break;
                    }

                    body.RemoveAt(lastBodyLine);
                    arms.Add((branch.Groups["condition"].Value, body));
                    removedLabels.Add(target);
                    current = labelIndex + 1;
                }

                if (arms.Count < 2 || end < 0 || joinTarget is null)
                {
                    continue;
                }

                var protectedLabel = removedLabels.Any(label =>
                    lines.Where((_, index) => index < start || index > end)
                        .Any(line => Regex.IsMatch(line, $@"\bgoto L{Regex.Escape(label)}\b")));
                if (protectedLabel)
                {
                    continue;
                }

                var replacement = new List<string>();
                for (var armIndex = 0; armIndex < arms.Count; armIndex++)
                {
                    replacement.Add(
                        $"{indent}{(armIndex == 0 ? "if" : "elseif")} {arms[armIndex].Condition} then");
                    replacement.AddRange(arms[armIndex].Body.Select(line =>
                        line.Length == 0 ? line : $"    {line}"));
                }
                replacement.Add($"{indent}end");

                lines.RemoveRange(start, end - start + 1);
                lines.InsertRange(start, replacement);
                changed = true;
                break;
            }
        }
        return string.Join("\n", lines);
    }

    private static int FindLabel(
        IReadOnlyList<string> lines,
        int start,
        string indent,
        string target)
    {
        var label = $"{indent}::L{target}::";
        for (var index = start; index < lines.Count; index++)
        {
            if (lines[index] == label)
            {
                return index;
            }
        }
        return -1;
    }

    private static string NormalizeBlankLines(string source)
    {
        source = Regex.Replace(source, @"unpack_values\(\{\.\.\.\}\)", "...");
        source = Regex.Replace(
            source,
            @"unpack_values\(\{(?<values>[^{}\r\n]+)\}\)",
            match => match.Groups["values"].Value);
        if (Regex.Matches(source, @"\bunpack_values\b").Count == 1)
        {
            source = Regex.Replace(
                source,
                @"(?m)^local unpack_values = table\.unpack or unpack\r?\n",
                string.Empty);
        }
        var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        var output = new List<string>(lines.Length);
        var blank = false;
        foreach (var line in lines)
        {
            if (line.Length == 0)
            {
                if (!blank)
                {
                    output.Add(line);
                }
                blank = true;
                continue;
            }
            output.Add(line);
            blank = false;
        }
        while (output.Count > 0 && output[^1].Length == 0)
        {
            output.RemoveAt(output.Count - 1);
        }
        return string.Join("\n", output) + "\n";
    }

    private static bool TryHandleStructuredBranch(
        SymbolicState state,
        XHiderInstruction instruction,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers,
        IReadOnlyDictionary<int, FunctionAnalysis> analyses,
        FunctionSlice function,
        SortedDictionary<int, List<string>> statements,
        Dictionary<int, List<string>> prefixes,
        Dictionary<int, StateSnapshot> stateRestores,
        Dictionary<int, EnvironmentScope> loopEnds,
        List<string> suffixes,
        HashSet<int> plainReturnPcs,
        HashSet<int> suppressedControlFlow,
        HashSet<int> skippedInstructions,
        ref int pc)
    {
        var target = instruction.Operand24;
        if (target <= instruction.Pc || target > function.EndPc)
        {
            return false;
        }

        if (instruction.Pc + 1 <= function.EndPc)
        {
            var next = image.Instructions[instruction.Pc];
            var nextSemantic = GetSemantic(next, handlers);
            if (nextSemantic.Kind == SemanticKind.Jump && next.Operand24 == target)
            {
                state.Frame.Pop();
                suppressedControlFlow.Add(instruction.Pc);
                suppressedControlFlow.Add(next.Pc);
                skippedInstructions.Add(next.Pc);
                return true;
            }
        }

        var backJump = FindBackwardJump(
            target - 1,
            instruction.Pc + 1,
            instruction.Pc,
            image,
            handlers);
        if (backJump is not null)
        {
            var condition = state.Frame.Pop();
            var loopStart = backJump.Operand24;
            AddStatements(statements, loopStart, [$"while {Unary("not ", condition).Render()} do"]);
            AddPrefix(prefixes, target, "end");
            loopEnds[target] = state.Environment;
            suppressedControlFlow.Add(instruction.Pc);
            suppressedControlFlow.Add(backJump.Pc);
            skippedInstructions.Add(backJump.Pc);

            for (var bodyPc = instruction.Pc + 1; bodyPc < target; bodyPc++)
            {
                var bodyInstruction = image.Instructions[bodyPc - 1];
                if (GetSemantic(bodyInstruction, handlers).Kind == SemanticKind.Jump &&
                    bodyInstruction.Operand24 == target)
                {
                    AddStatements(statements, bodyPc, ["break"]);
                    suppressedControlFlow.Add(bodyPc);
                    skippedInstructions.Add(bodyPc);
                }
            }
            return true;
        }

        var targetInstruction = image.Instructions[target - 1];
        var targetSemantic = GetSemantic(targetInstruction, handlers);
        if (targetSemantic.Kind is SemanticKind.ReturnEmpty or SemanticKind.ReturnTop)
        {
            var condition = state.Frame.Pop();
            AddStatements(statements, instruction.Pc, [$"if {Unary("not ", condition).Render()} then"]);
            AddPrefix(prefixes, target, "end");
            suppressedControlFlow.Add(instruction.Pc);
            return true;
        }

        var previousInstruction = image.Instructions[target - 2];
        var previousSemantic = GetSemantic(previousInstruction, handlers);
        var endSemantic = GetSemantic(image.Instructions[function.EndPc - 1], handlers);
        if (previousSemantic.Kind is SemanticKind.ReturnEmpty or SemanticKind.ReturnTop &&
            endSemantic.Kind is SemanticKind.ReturnEmpty or SemanticKind.ReturnTop)
        {
            var condition = state.Frame.Pop();
            AddStatements(statements, instruction.Pc, [$"if {Unary("not ", condition).Render()} then"]);
            AddPrefix(prefixes, target, "end");
            stateRestores[target] = state.Snapshot();
            plainReturnPcs.Add(target - 1);
            suppressedControlFlow.Add(instruction.Pc);
            return true;
        }

        return TryFoldBranch(
            state,
            instruction,
            image,
            handlers,
            analyses,
            function,
            statements,
            suppressedControlFlow,
            skippedInstructions,
            ref pc);
    }

    private static string UnwrapReturn(string line)
    {
        if (line == "do return end")
        {
            return "return";
        }
        if (line.StartsWith("do return ", StringComparison.Ordinal) &&
            line.EndsWith(" end", StringComparison.Ordinal))
        {
            return line[3..^4];
        }
        return line;
    }

    private static bool TryFoldBranch(
        SymbolicState state,
        XHiderInstruction instruction,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers,
        IReadOnlyDictionary<int, FunctionAnalysis> analyses,
        FunctionSlice function,
        SortedDictionary<int, List<string>> statements,
        HashSet<int> suppressedControlFlow,
        HashSet<int> skippedInstructions,
        ref int pc)
    {
        var branchState = state.CloneForPreview();
        var condition = branchState.Frame.Pop();
        var fallthrough = branchState.CloneForPreview();
        var previewUnknown = 0;

        for (var previewPc = instruction.Pc + 1; previewPc < instruction.Operand24; previewPc++)
        {
            var previewInstruction = image.Instructions[previewPc - 1];
            var previewSemantic = GetSemantic(previewInstruction, handlers);
            if (previewSemantic.Kind is
                SemanticKind.Jump or
                SemanticKind.BranchTruePop or
                SemanticKind.NumericFor or
                SemanticKind.ReturnEmpty or
                SemanticKind.ReturnTop)
            {
                return false;
            }

            var previewLines = ProcessInstruction(
                fallthrough,
                previewSemantic,
                previewInstruction,
                image,
                function,
                analyses,
                ref previewUnknown);
            if (previewLines.Count > 0 || previewUnknown > 0)
            {
                return false;
            }
        }

        if (branchState.Environment.Id != fallthrough.Environment.Id ||
            branchState.Frame.Count != fallthrough.Frame.Count)
        {
            return false;
        }

        var merged = new List<SymbolicValue>();
        var lines = new List<string> { $"if {condition.Render()} then" };
        var assignments = new List<(string Name, SymbolicValue Branch, SymbolicValue Fallthrough)>();
        for (var index = 0; index < branchState.Frame.Count; index++)
        {
            var branchValue = branchState.Frame.Values[index];
            var fallthroughValue = fallthrough.Frame.Values[index];
            if (branchValue.Render() == fallthroughValue.Render())
            {
                merged.Add(branchValue);
                continue;
            }

            var name = state.CreatePhi();
            merged.Add(new ExpressionValue(name));
            assignments.Add((name, branchValue, fallthroughValue));
        }

        if (assignments.Count == 0)
        {
            return false;
        }

        foreach (var assignment in assignments)
        {
            lines.Add($"{assignment.Name} = {assignment.Branch.Render()}");
        }
        lines.Add("else");
        foreach (var assignment in assignments)
        {
            lines.Add($"{assignment.Name} = {assignment.Fallthrough.Render()}");
        }
        lines.Add("end");

        state.Frame = branchState.Frame.WithValues(merged);
        state.Environment = branchState.Environment;
        state.AbsorbLocals(branchState);
        state.AbsorbLocals(fallthrough);
        AddStatements(statements, instruction.Pc, lines);
        suppressedControlFlow.Add(instruction.Pc);
        for (var skippedPc = instruction.Pc + 1; skippedPc < instruction.Operand24; skippedPc++)
        {
            skippedInstructions.Add(skippedPc);
        }
        pc = instruction.Operand24 - 1;
        return true;
    }

    private static bool TryHandleNumericFor(
        SymbolicState state,
        XHiderInstruction instruction,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers,
        FunctionSlice function,
        SortedDictionary<int, List<string>> statements,
        Dictionary<int, List<string>> prefixes,
        Dictionary<int, EnvironmentScope> loopEnds,
        HashSet<int> suppressedControlFlow,
        HashSet<int> skippedInstructions)
    {
        if (instruction.Pc + 1 > function.EndPc)
        {
            return false;
        }

        var exitJump = image.Instructions[instruction.Pc];
        if (GetSemantic(exitJump, handlers).Kind != SemanticKind.Jump ||
            exitJump.Operand24 <= instruction.Pc + 2 ||
            exitJump.Operand24 > function.EndPc)
        {
            return false;
        }

        var backJump = FindJumpTo(
            exitJump.Operand24 - 1,
            instruction.Pc + 2,
            instruction.Pc,
            image,
            handlers);
        if (backJump is null)
        {
            return false;
        }

        var step = state.Frame.Peek(0);
        var limit = state.Frame.Peek(1);
        var index = state.Frame.Peek(2);
        var start = Binary(index, "+", step);
        var loopVariable = state.CreateLoop();
        var parent = state.Environment;
        var environment = state.CreateEnvironment(parent);
        environment.Bind(instruction.Operand16, loopVariable);

        AddStatements(
            statements,
            instruction.Pc,
            [$"for {loopVariable} = {start.Render()}, {limit.Render()}, {step.Render()} do"]);
        AddPrefix(prefixes, exitJump.Operand24, "end");
        loopEnds[exitJump.Operand24] = parent;
        state.Environment = environment;
        state.Frame.SetFromTop(2, new ExpressionValue(loopVariable));

        suppressedControlFlow.Add(instruction.Pc);
        suppressedControlFlow.Add(exitJump.Pc);
        suppressedControlFlow.Add(backJump.Pc);
        skippedInstructions.Add(exitJump.Pc);
        skippedInstructions.Add(backJump.Pc);
        return true;
    }

    private static bool TryHandleGenericFor(
        SymbolicState state,
        XHiderInstruction instruction,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers,
        FunctionSlice function,
        SortedDictionary<int, List<string>> statements,
        Dictionary<int, List<string>> prefixes,
        Dictionary<int, EnvironmentScope> loopEnds,
        HashSet<int> suppressedControlFlow,
        HashSet<int> skippedInstructions)
    {
        if (instruction.Pc + 4 > function.EndPc)
        {
            return false;
        }

        var exitJump = image.Instructions[instruction.Pc];
        if (GetSemantic(exitJump, handlers).Kind != SemanticKind.Jump ||
            exitJump.Operand24 <= instruction.Pc + 2 ||
            exitJump.Operand24 > function.EndPc)
        {
            return false;
        }

        var backJump = FindJumpTo(
            exitJump.Operand24 - 1,
            instruction.Pc + 2,
            instruction.Pc,
            image,
            handlers);
        if (backJump is null)
        {
            return false;
        }

        var parent = state.Environment;
        var environment = state.CreateEnvironment(parent);
        var variables = new List<string>();
        var cursor = instruction.Pc + 2;
        while (cursor + 2 <= function.EndPc)
        {
            var pushKey = image.Instructions[cursor - 1];
            var getValue = image.Instructions[cursor];
            var setVariable = image.Instructions[cursor + 1];
            if (GetSemantic(pushKey, handlers).Kind != SemanticKind.PushConstant ||
                GetSemantic(getValue, handlers).Kind != SemanticKind.GetTableKeepKey ||
                GetSemantic(setVariable, handlers).Kind != SemanticKind.SetEnvironment ||
                setVariable.OperandByte != 0)
            {
                break;
            }

            var name = state.CreateLoop();
            environment.Bind(setVariable.Operand16, name);
            variables.Add(name);
            skippedInstructions.Add(pushKey.Pc);
            skippedInstructions.Add(getValue.Pc);
            skippedInstructions.Add(setVariable.Pc);
            cursor += 3;
        }

        if (variables.Count == 0)
        {
            return false;
        }

        if (cursor <= function.EndPc)
        {
            var pop = image.Instructions[cursor - 1];
            if (GetSemantic(pop, handlers).Kind == SemanticKind.Pop)
            {
                skippedInstructions.Add(pop.Pc);
            }
        }

        var iterator = state.Frame.Peek();
        AddStatements(
            statements,
            instruction.Pc,
            [$"for {string.Join(", ", variables)} in {new SpreadValue(iterator).Render()} do"]);
        AddPrefix(prefixes, exitJump.Operand24, "end");
        loopEnds[exitJump.Operand24] = parent;
        state.Environment = environment;

        suppressedControlFlow.Add(instruction.Pc);
        suppressedControlFlow.Add(exitJump.Pc);
        suppressedControlFlow.Add(backJump.Pc);
        skippedInstructions.Add(exitJump.Pc);
        skippedInstructions.Add(backJump.Pc);
        return true;
    }

    private static bool TryHandleStructuredJump(
        XHiderInstruction instruction,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers,
        FunctionSlice function,
        SortedDictionary<int, List<string>> statements,
        HashSet<int> suppressedControlFlow)
    {
        if (instruction.Operand24 == instruction.Pc + 1)
        {
            suppressedControlFlow.Add(instruction.Pc);
            return true;
        }
        return false;
    }

    private static XHiderInstruction? FindJumpTo(
        int startPc,
        int minimumPc,
        int target,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers)
    {
        for (var pc = startPc; pc >= minimumPc; pc--)
        {
            var instruction = image.Instructions[pc - 1];
            if (GetSemantic(instruction, handlers).Kind == SemanticKind.Jump &&
                instruction.Operand24 == target)
            {
                return instruction;
            }
        }
        return null;
    }

    private static XHiderInstruction? FindBackwardJump(
        int startPc,
        int minimumPc,
        int maximumTarget,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers)
    {
        for (var pc = startPc; pc >= minimumPc; pc--)
        {
            var instruction = image.Instructions[pc - 1];
            if (GetSemantic(instruction, handlers).Kind == SemanticKind.Jump &&
                instruction.Operand24 <= maximumTarget)
            {
                return instruction;
            }
        }
        return null;
    }

    private static HandlerSemantic GetSemantic(
        XHiderInstruction instruction,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers) =>
        handlers.TryGetValue(instruction.Opcode, out var semantic)
            ? semantic
            : new HandlerSemantic(SemanticKind.Nop);

    private static void AddStatements(
        SortedDictionary<int, List<string>> statements,
        int pc,
        IEnumerable<string> lines)
    {
        var added = lines.ToList();
        if (added.Count == 0)
        {
            return;
        }
        if (!statements.TryGetValue(pc, out var existing))
        {
            statements[pc] = added;
            return;
        }
        existing.AddRange(added);
    }

    private static void AddPrefix(
        Dictionary<int, List<string>> prefixes,
        int pc,
        string line)
    {
        if (!prefixes.TryGetValue(pc, out var lines))
        {
            lines = [];
            prefixes[pc] = lines;
        }
        lines.Add(line);
    }

    private static IReadOnlyList<string> ProcessInstruction(
        SymbolicState state,
        HandlerSemantic semantic,
        XHiderInstruction instruction,
        XHiderImage image,
        FunctionSlice function,
        IReadOnlyDictionary<int, FunctionAnalysis> analyses,
        ref int unknown)
    {
        var lines = new List<string>();
        switch (semantic.Kind)
        {
            case SemanticKind.Nop:
                break;
            case SemanticKind.PushConstant:
                state.Frame.Push(ConstantValue(image, instruction.Operand24));
                break;
            case SemanticKind.PushClosure:
                if (!analyses.TryGetValue(instruction.Operand24, out var child))
                {
                    unknown++;
                    state.Frame.Push(new ExpressionValue("nil"));
                    break;
                }
                var captures = child.Captures.ToArray()
                    .Select(capture => state.ResolveVariable(capture.Depth - 1, capture.Slot))
                    .ToArray();
                var closureArguments = captures.Length == 0
                    ? "..."
                    : $"{string.Join(", ", captures)}, ...";
                state.Frame.Push(new ExpressionValue(
                    $"function(...) return {child.Name}({closureArguments}) end"));
                break;
            case SemanticKind.PushEnvironment:
                state.Frame.Push(new ExpressionValue(
                    state.ResolveVariable(instruction.OperandByte, instruction.Operand16)));
                break;
            case SemanticKind.SetEnvironment:
            {
                var value = state.Frame.Pop();
                lines.Add($"{state.ResolveVariable(instruction.OperandByte, instruction.Operand16)} = {value.Render()}");
                break;
            }
            case SemanticKind.SetEnvironmentIndexed:
            {
                var key = state.Frame.Pop();
                var container = state.Frame.Peek();
                var value = Index(container, key);
                lines.Add($"{state.ResolveVariable(instruction.OperandByte, instruction.Operand16)} = {value.Render()}");
                break;
            }
            case SemanticKind.EnterEnvironment:
                state.Environment = state.CreateEnvironment(state.Environment);
                break;
            case SemanticKind.LeaveEnvironment:
                state.Environment = state.Environment.Parent ?? state.Environment;
                break;
            case SemanticKind.GetGlobal:
                state.Frame.Push(Global(state.Frame.Pop()));
                break;
            case SemanticKind.GetArgument:
                state.Frame.Push(new ExpressionValue(
                    $"select({state.Frame.Pop().Render()}, {state.RenderAllArguments()})"));
                break;
            case SemanticKind.PushArgument:
                state.Frame.Push(new ExpressionValue(state.ArgumentName(instruction.Operand16)));
                break;
            case SemanticKind.PushVarargs:
                state.Frame.Push(state.CreateVarargList(instruction.Operand16));
                break;
            case SemanticKind.NewTable:
                state.Frame.Push(new TableValue());
                break;
            case SemanticKind.PushBoolean:
                state.Frame.Push(new BooleanValue(
                    semantic.CanonicalBody?.Contains("=true", StringComparison.Ordinal) == true));
                break;
            case SemanticKind.PushNil:
                state.Frame.Push(new ExpressionValue("nil"));
                break;
            case SemanticKind.LogicalNot:
                state.Frame.Push(Unary("not ", state.Frame.Pop()));
                break;
            case SemanticKind.Length:
                state.Frame.Push(Unary("#", state.Frame.Pop()));
                break;
            case SemanticKind.Pop:
                FlushDiscarded(state.Frame.Pop(), lines);
                break;
            case SemanticKind.Swap:
                state.Frame.Swap(instruction.Operand16);
                break;
            case SemanticKind.Duplicate:
                state.Frame.Push(state.Frame.Peek());
                break;
            case SemanticKind.First:
                state.Frame.Push(First(state.Frame.Pop()));
                break;
            case SemanticKind.GetTableKeepKey:
            {
                var key = state.Frame.Pop();
                state.Frame.Push(Index(state.Frame.Peek(), key));
                break;
            }
            case SemanticKind.GetTable:
            {
                var key = state.Frame.Pop();
                var container = state.Frame.Pop();
                state.Frame.Push(Index(container, key));
                break;
            }
            case SemanticKind.SetTable:
            {
                var value = state.Frame.Pop();
                var key = state.Frame.Pop();
                var container = state.Frame.Peek();
                SetTableValue(container, key, value, lines);
                break;
            }
            case SemanticKind.SetTableImmediate:
            {
                var value = state.Frame.Pop();
                SetTableValue(
                    state.Frame.Peek(),
                    new NumberValue(instruction.Operand16),
                    value,
                    lines);
                break;
            }
            case SemanticKind.AppendTableResults:
            {
                var values = state.Frame.Pop();
                var table = state.Frame.Peek();
                if (values is ListValue { DirectExpression: null } appendedList &&
                    appendedList.Values.All(value => value is not SpreadValue))
                {
                    for (var index = 0; index < appendedList.Values.Count; index++)
                    {
                        SetTableValue(
                            table,
                            new NumberValue(instruction.Operand16 + index),
                            appendedList.Values[index],
                            lines);
                    }
                    break;
                }

                var indexName = state.CreateLoop();
                var valueName = state.CreateLoop();
                lines.Add(
                    $"for {indexName}, {valueName} in ipairs({values.Render()}) do " +
                    $"{Index(table, new ExpressionValue($"{instruction.Operand16 - 1} + {indexName}")).Render()} = {valueName} end");
                break;
            }
            case SemanticKind.SetTableFromResult:
            {
                var result = state.Frame.Peek();
                var key = state.Frame.Peek(instruction.OperandByte - 1);
                var table = state.Frame.Peek(instruction.OperandByte);
                SetTableValue(
                    table,
                    key,
                    Index(result, new NumberValue(instruction.Operand16)),
                    lines);
                break;
            }
            case SemanticKind.SetGlobal:
            {
                var value = state.Frame.Pop();
                var key = state.Frame.Pop();
                lines.Add($"{Global(key).Render()} = {value.Render()}");
                break;
            }
            case SemanticKind.SetGlobalIndexed:
            {
                var key = state.Frame.Pop();
                var container = state.Frame.Peek();
                lines.Add(
                    $"{Global(key).Render()} = " +
                    $"{Index(container, new NumberValue(instruction.Operand16)).Render()}");
                break;
            }
            case SemanticKind.Call:
            {
                var arguments = state.Frame.Pop();
                var callable = state.Frame.Pop();
                var result = state.CreateResult();
                lines.Add($"{result} = {{{callable.Render()}({RenderArguments(arguments)})}}");
                state.Frame.Push(new ListValue([], result));
                break;
            }
            case SemanticKind.ExpandResults:
                if (state.Frame.Peek() is ListValue list)
                {
                    state.Frame.ReplaceTop(new SpreadValue(list));
                }
                break;
            case SemanticKind.FramePush:
                state.Frame = new SymbolicFrame(state.Frame);
                break;
            case SemanticKind.FrameCaptureTop:
                state.Frame = new SymbolicFrame(state.Frame, [state.Frame.Peek()]);
                break;
            case SemanticKind.FrameClone:
            {
                var packaged = new ListValue(state.Frame.Values.ToArray());
                state.Frame = new SymbolicFrame(state.Frame.Parent, [packaged]);
                break;
            }
            case SemanticKind.FrameReset:
                FlushDiscarded(state.Frame.Values, lines);
                state.Frame = new SymbolicFrame(state.Frame.Parent);
                break;
            case SemanticKind.FrameRestore:
                if (state.Frame.Parent is not null)
                {
                    state.Frame = state.Frame.Parent;
                }
                break;
            case SemanticKind.FrameRestoreKeepTop:
            {
                var keep = state.Frame.Count > 0 ? state.Frame.Pop() : new ExpressionValue("nil");
                state.Frame = state.Frame.Parent ?? state.Frame;
                state.Frame.Push(keep);
                break;
            }
            case SemanticKind.Jump:
                if (instruction.Operand24 != instruction.Pc + 1)
                {
                    lines.Add($"goto L{instruction.Operand24}");
                }
                break;
            case SemanticKind.BranchTruePop:
            {
                var condition = state.Frame.Pop();
                if (instruction.Operand24 != instruction.Pc + 1)
                {
                    lines.Add($"if {condition.Render()} then goto L{instruction.Operand24} end");
                }
                break;
            }
            case SemanticKind.NumericFor:
            {
                var step = state.Frame.Peek(0);
                var limit = state.Frame.Peek(1);
                var index = state.Frame.Peek(2);
                var next = Binary(index, "+", step);
                state.Frame.SetFromTop(2, next);
                var environment = state.CreateEnvironment(state.Environment);
                var loopValue = state.ResolveVariable(environment, 0, instruction.Operand16);
                var condition =
                    $"(({step.Render()}) < 0 and ({next.Render()}) >= ({limit.Render()})) or " +
                    $"(({step.Render()}) > 0 and ({next.Render()}) <= ({limit.Render()}))";
                lines.Add(
                    $"if {condition} then {loopValue} = {next.Render()}; goto L{instruction.Pc + 2} end");
                break;
            }
            case SemanticKind.BinaryReduce:
            {
                var right = state.Frame.Pop();
                var left = state.Frame.Pop();
                state.Frame.Push(Binary(left, semantic.Operator, right));
                break;
            }
            case SemanticKind.BinaryReplace:
            {
                var right = state.Frame.Pop();
                var left = state.Frame.Pop();
                state.Frame.Push(Binary(left, semantic.Operator, right));
                break;
            }
            case SemanticKind.BinaryTopTwo:
            {
                var right = state.Frame.Peek(0);
                var left = state.Frame.Peek(2);
                state.Frame.SetFromTop(2, Binary(left, semantic.Operator, right));
                break;
            }
            case SemanticKind.ReturnTop:
            {
                var value = state.Frame.Count > 0 ? state.Frame.Pop() : new ExpressionValue("nil");
                var returnStatement = value is ListValue returnList
                    ? $"return {returnList.RenderReturns()}"
                    : value is SpreadValue spread
                        ? $"return {spread.Render()}"
                        : $"return {value.Render()}";
                lines.Add(instruction.Pc < function.EndPc
                    ? $"do {returnStatement} end"
                    : returnStatement);
                state.Terminated = true;
                break;
            }
            case SemanticKind.ReturnEmpty:
                FlushDiscarded(state.Frame.Values, lines);
                lines.Add(instruction.Pc < function.EndPc ? "do return end" : "return");
                state.Terminated = true;
                break;
            default:
                unknown++;
                break;
        }

        return lines;
    }

    private static IReadOnlyList<FunctionSlice> BuildFunctions(XHiderImage image)
    {
        var sorted = image.FunctionEntries
            .Select((pc, index) => new FunctionSlice(index + 1, pc, 0))
            .OrderBy(function => function.StartPc)
            .ToArray();
        for (var index = 0; index < sorted.Length; index++)
        {
            sorted[index] = sorted[index] with
            {
                EndPc = index + 1 < sorted.Length
                    ? sorted[index + 1].StartPc - 1
                    : image.Instructions.Count
            };
        }
        return sorted;
    }

    private static IReadOnlyDictionary<int, FunctionAnalysis> AnalyzeFunctions(
        IReadOnlyList<FunctionSlice> functions,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers,
        ProtectionScaffold scaffold)
    {
        var captures = functions.ToDictionary(
            function => function.Index,
            _ => new HashSet<CaptureReference>());
        var argumentCounts = functions.ToDictionary(function => function.Index, _ => 0);
        var usesVarargs = functions.ToDictionary(function => function.Index, _ => false);
        var closureSites = functions.ToDictionary(
            function => function.Index,
            _ => new List<ClosureSite>());

        foreach (var function in functions)
        {
            var localDepth = 0;
            for (var pc = function.StartPc; pc <= function.EndPc; pc++)
            {
                if (scaffold.SkippedInstructions.TryGetValue(function.Index, out var skipped) &&
                    skipped.Contains(pc))
                {
                    continue;
                }
                var instruction = image.Instructions[pc - 1];
                var semantic = GetSemantic(instruction, handlers);
                if (semantic.Kind is
                    SemanticKind.PushEnvironment or
                    SemanticKind.SetEnvironment or
                    SemanticKind.SetEnvironmentIndexed)
                {
                    AddCapture(
                        captures[function.Index],
                        localDepth,
                        instruction.OperandByte,
                        instruction.Operand16);
                }
                else if (semantic.Kind == SemanticKind.PushClosure)
                {
                    closureSites[function.Index].Add(
                        new ClosureSite(instruction.Operand24, localDepth));
                }
                else if (semantic.Kind == SemanticKind.PushArgument)
                {
                    argumentCounts[function.Index] = Math.Max(
                        argumentCounts[function.Index],
                        instruction.Operand16);
                }
                else if (semantic.Kind is SemanticKind.PushVarargs or SemanticKind.GetArgument)
                {
                    usesVarargs[function.Index] = true;
                }

                if (semantic.Kind is SemanticKind.EnterEnvironment or SemanticKind.NumericFor)
                {
                    localDepth++;
                }
                else if (semantic.Kind == SemanticKind.LeaveEnvironment)
                {
                    localDepth = Math.Max(0, localDepth - 1);
                }
            }
        }

        var changed = true;
        while (changed)
        {
            changed = false;
            foreach (var function in functions)
            {
                foreach (var site in closureSites[function.Index])
                {
                    if (!captures.TryGetValue(site.ChildIndex, out var childCaptures))
                    {
                        continue;
                    }
                    foreach (var childCapture in childCaptures.ToArray())
                    {
                        var depthFromCurrent = childCapture.Depth - 1;
                        if (depthFromCurrent <= site.LocalDepth)
                        {
                            continue;
                        }
                        changed |= captures[function.Index].Add(
                            new CaptureReference(
                                depthFromCurrent - site.LocalDepth,
                                childCapture.Slot));
                    }
                }
            }
        }

        var visibleIndex = 1;
        return functions.ToDictionary(
            function => function.Index,
            function => new FunctionAnalysis(
                function,
                scaffold.HiddenFunctions.Contains(function.Index)
                    ? $"hidden{function.Index}"
                    : $"f{visibleIndex++}",
                argumentCounts[function.Index],
                usesVarargs[function.Index],
                captures[function.Index]
                    .OrderBy(capture => capture.Depth)
                    .ThenBy(capture => capture.Slot)
                    .ToList()));
    }

    private static ProtectionScaffold AnalyzeProtectionScaffold(
        IReadOnlyList<FunctionSlice> functions,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers)
    {
        var root = functions.FirstOrDefault(function => function.Index == 1);
        if (root is null)
        {
            return ProtectionScaffold.Empty;
        }

        var significant = Enumerable.Range(root.StartPc, root.EndPc - root.StartPc + 1)
            .Select(pc => image.Instructions[pc - 1])
            .Where(instruction => GetSemantic(instruction, handlers).Kind != SemanticKind.Nop)
            .Take(19)
            .ToArray();
        var expected = new[]
        {
            SemanticKind.FramePush,
            SemanticKind.PushConstant,
            SemanticKind.GetGlobal,
            SemanticKind.FramePush,
            SemanticKind.PushClosure,
            SemanticKind.FrameClone,
            SemanticKind.FrameRestoreKeepTop,
            SemanticKind.Call,
            SemanticKind.ExpandResults,
            SemanticKind.FrameClone,
            SemanticKind.FrameRestoreKeepTop,
            SemanticKind.PushConstant,
            SemanticKind.SetEnvironmentIndexed,
            SemanticKind.Pop,
            SemanticKind.PushEnvironment,
            SemanticKind.LogicalNot,
            SemanticKind.LogicalNot,
            SemanticKind.BranchTruePop,
            SemanticKind.Jump
        };
        if (significant.Length != expected.Length ||
            !significant.Select(instruction => GetSemantic(instruction, handlers).Kind)
                .SequenceEqual(expected))
        {
            return ProtectionScaffold.Empty;
        }

        var pcallConstant = significant[1].Operand24;
        if (pcallConstant <= 0 ||
            pcallConstant > image.Constants.Count ||
            image.Constants[pcallConstant - 1].Kind != ConstantKind.String ||
            Encoding.Latin1.GetString(image.Constants[pcallConstant - 1].Bytes ?? []) != "pcall")
        {
            return ProtectionScaffold.Empty;
        }

        var branch = significant[^2];
        var jump = significant[^1];
        if (branch.Operand24 != jump.Operand24)
        {
            return ProtectionScaffold.Empty;
        }

        var childIndex = significant[4].Operand24;
        var references = image.Instructions.Count(instruction =>
            GetSemantic(instruction, handlers).Kind == SemanticKind.PushClosure &&
            instruction.Operand24 == childIndex);
        if (references != 1)
        {
            return ProtectionScaffold.Empty;
        }

        return new ProtectionScaffold(
            new HashSet<int> { childIndex },
            new Dictionary<int, HashSet<int>>
            {
                [root.Index] = Enumerable.Range(
                    root.StartPc,
                    jump.Pc - root.StartPc + 1).ToHashSet()
            });
    }

    private static void AddCapture(
        HashSet<CaptureReference> captures,
        int localDepth,
        int requestedDepth,
        int slot)
    {
        if (requestedDepth > localDepth)
        {
            captures.Add(new CaptureReference(requestedDepth - localDepth, slot));
        }
    }

    private static HashSet<int> CollectLabels(
        FunctionSlice function,
        XHiderImage image,
        IReadOnlyDictionary<byte, HandlerSemantic> handlers,
        IReadOnlySet<int> suppressedControlFlow)
    {
        var labels = new HashSet<int>();
        for (var pc = function.StartPc; pc <= function.EndPc; pc++)
        {
            if (suppressedControlFlow.Contains(pc))
            {
                continue;
            }
            var instruction = image.Instructions[pc - 1];
            if (!handlers.TryGetValue(instruction.Opcode, out var semantic))
            {
                continue;
            }
            if (semantic.Kind is SemanticKind.Jump or SemanticKind.BranchTruePop &&
                instruction.Operand24 >= function.StartPc &&
                instruction.Operand24 <= function.EndPc)
            {
                labels.Add(instruction.Operand24);
            }
            if (semantic.Kind == SemanticKind.NumericFor && instruction.Pc + 2 <= function.EndPc)
            {
                labels.Add(instruction.Pc + 2);
            }
        }
        return labels;
    }

    private static SymbolicValue ConstantValue(XHiderImage image, int index)
    {
        if (index <= 0 || index > image.Constants.Count)
        {
            return new ExpressionValue("nil");
        }
        var constant = image.Constants[index - 1];
        return constant.Kind == ConstantKind.String
            ? new StringValue(constant.Bytes ?? [])
            : new NumberValue(constant.Number);
    }

    private static SymbolicValue Global(SymbolicValue key)
    {
        if (key is StringValue text && IdentifierRegex().IsMatch(text.Text))
        {
            return new ExpressionValue(text.Text);
        }
        return new ExpressionValue($"_G[{key.Render()}]");
    }

    private static SymbolicValue Index(SymbolicValue container, SymbolicValue key)
    {
        if (container is ListValue list)
        {
            return list.Index(key);
        }
        if (container is SpreadValue spread && key is NumberValue number)
        {
            return spread.Value is ListValue spreadList
                ? spreadList.Index(number)
                : new ExpressionValue($"select({number.Render()}, {spread.Render()})");
        }
        if (key is StringValue text && IdentifierRegex().IsMatch(text.Text))
        {
            return new ExpressionValue($"({container.Render()}).{text.Text}");
        }
        return new ExpressionValue($"({container.Render()})[{key.Render()}]");
    }

    private static void SetTableValue(
        SymbolicValue container,
        SymbolicValue key,
        SymbolicValue value,
        ICollection<string> lines)
    {
        if (container is TableValue table)
        {
            table.Set(key, value);
            return;
        }
        var renderedContainer = container.Render();
        var target = IdentifierRegex().IsMatch(renderedContainer)
            ? renderedContainer
            : $"({renderedContainer})";
        lines.Add($"{target}[{key.Render()}] = {value.Render()}");
    }

    private static SymbolicValue First(SymbolicValue value) =>
        value switch
        {
            SpreadValue spread when spread.Value is ListValue list => list.Index(new NumberValue(1)),
            ListValue list => list.Index(new NumberValue(1)),
            _ => new ExpressionValue($"({value.Render()})[1]", value.HasSideEffect)
        };

    private static SymbolicValue Unary(string op, SymbolicValue value)
    {
        if (op == "not " && value is UnaryValue { Operator: "not " } unary)
        {
            return unary.Value;
        }
        if (op == "not " && value is BooleanValue boolean)
        {
            return new BooleanValue(!boolean.Value);
        }
        return new UnaryValue(op, value);
    }

    private static SymbolicValue Binary(SymbolicValue left, string? op, SymbolicValue right)
    {
        var binaryOperator = op ?? "+";
        if (left is NumberValue leftNumber && right is NumberValue rightNumber)
        {
            var lhs = leftNumber.Number;
            var rhs = rightNumber.Number;
            return binaryOperator switch
            {
                "+" => new NumberValue(lhs + rhs),
                "-" => new NumberValue(lhs - rhs),
                "*" => new NumberValue(lhs * rhs),
                "/" => new NumberValue(lhs / rhs),
                "^" => new NumberValue(Math.Pow(lhs, rhs)),
                "<" => new BooleanValue(lhs < rhs),
                "<=" => new BooleanValue(lhs <= rhs),
                ">" => new BooleanValue(lhs > rhs),
                ">=" => new BooleanValue(lhs >= rhs),
                "==" => new BooleanValue(lhs == rhs),
                "~=" => new BooleanValue(lhs != rhs),
                _ => new ExpressionValue($"({left.Render()}) {binaryOperator} ({right.Render()})")
            };
        }
        if (left is BooleanValue leftBoolean && right is BooleanValue rightBoolean &&
            binaryOperator is "==" or "~=")
        {
            var equal = leftBoolean.Value == rightBoolean.Value;
            return new BooleanValue(binaryOperator == "==" ? equal : !equal);
        }
        return new ExpressionValue(
            $"({left.Render()}) {binaryOperator} ({right.Render()})",
            left.HasSideEffect || right.HasSideEffect);
    }

    private static string RenderArguments(SymbolicValue value) =>
        value switch
        {
            ListValue list => list.RenderArguments(),
            SpreadValue spread => spread.Render(),
            _ => value.Render()
        };

    private static void FlushDiscarded(IEnumerable<SymbolicValue> values, List<string> lines)
    {
        foreach (var value in values)
        {
            FlushDiscarded(value, lines);
        }
    }

    private static void FlushDiscarded(SymbolicValue value, List<string> lines)
    {
        switch (value)
        {
            case ListValue list:
                FlushDiscarded(list.Values, lines);
                break;
        }
    }

    private static void FlushDiscarded(IEnumerable<SymbolicValue> values, StringBuilder output, string indent)
    {
        var lines = new List<string>();
        FlushDiscarded(values, lines);
        foreach (var line in lines)
        {
            output.Append(indent).AppendLine(line);
        }
    }

    private abstract class SymbolicValue
    {
        public virtual bool HasSideEffect => false;
        public virtual SymbolicValue Clone() => this;
        public abstract string Render();
    }

    private sealed class ExpressionValue(string expression, bool sideEffect = false) : SymbolicValue
    {
        public override bool HasSideEffect => sideEffect;
        public override string Render() => expression;
    }

    private sealed class UnaryValue(string op, SymbolicValue value) : SymbolicValue
    {
        public string Operator { get; } = op;
        public SymbolicValue Value { get; } = value;
        public override bool HasSideEffect => Value.HasSideEffect;
        public override SymbolicValue Clone() => new UnaryValue(Operator, Value.Clone());
        public override string Render() => $"{Operator}({Value.Render()})";
    }

    private sealed class StringValue(byte[] bytes) : SymbolicValue
    {
        public string Text { get; } = Encoding.Latin1.GetString(bytes);
        public override string Render() => Quote(bytes);
    }

    private sealed class NumberValue(double number) : SymbolicValue
    {
        public double Number { get; } = number;
        public override string Render() => Number.ToString("R", CultureInfo.InvariantCulture);
    }

    private sealed class BooleanValue(bool value) : SymbolicValue
    {
        public bool Value { get; } = value;
        public override string Render() => Value ? "true" : "false";
    }

    private sealed class TableValue : SymbolicValue
    {
        private readonly List<(SymbolicValue Key, SymbolicValue Value)> _entries = [];

        public void Set(SymbolicValue key, SymbolicValue value) => _entries.Add((key, value));

        public override SymbolicValue Clone()
        {
            var clone = new TableValue();
            foreach (var (key, value) in _entries)
            {
                clone.Set(key.Clone(), value.Clone());
            }
            return clone;
        }

        public override string Render()
        {
            if (_entries.Count == 0)
            {
                return "{}";
            }
            return "{" + string.Join(", ", _entries.Select(entry =>
                $"[{entry.Key.Render()}] = {entry.Value.Render()}")) + "}";
        }
    }

    private sealed class ListValue(
        IReadOnlyList<SymbolicValue> values,
        string? directExpression = null) : SymbolicValue
    {
        public IReadOnlyList<SymbolicValue> Values { get; } = values;
        public string? DirectExpression { get; } = directExpression;

        public SymbolicValue Index(SymbolicValue key)
        {
            if (DirectExpression is not null)
            {
                return new ExpressionValue($"({DirectExpression})[{key.Render()}]");
            }
            if (key is not NumberValue number || number.Number < 1 || number.Number % 1 != 0)
            {
                return new ExpressionValue($"({Render()})[{key.Render()}]", HasSideEffect);
            }

            var wanted = (int)number.Number;
            var position = 1;
            foreach (var value in Values)
            {
                if (value is SpreadValue spread)
                {
                    return spread.Value is ListValue list
                        ? list.Index(new NumberValue(wanted - position + 1))
                        : new ExpressionValue(
                            $"select({wanted - position + 1}, {spread.Render()})");
                }
                if (position == wanted)
                {
                    return value;
                }
                position++;
            }
            return new ExpressionValue("nil");
        }

        public string RenderArguments() =>
            DirectExpression ?? string.Join(", ", Values.Select(value =>
                value is SpreadValue spread ? spread.Render() : value.Render()));

        public string RenderReturns() => RenderArguments();

        public override bool HasSideEffect => Values.Any(value => value.HasSideEffect);
        public override SymbolicValue Clone() =>
            new ListValue(Values.Select(value => value.Clone()).ToArray(), DirectExpression);
        public override string Render() =>
            DirectExpression ?? $"{{{string.Join(", ", Values.Select(value => value.Render()))}}}";
    }

    private sealed class SpreadValue(SymbolicValue value) : SymbolicValue
    {
        public SymbolicValue Value { get; } = value;
        public override bool HasSideEffect => Value.HasSideEffect;
        public override SymbolicValue Clone() => new SpreadValue(Value.Clone());
        public override string Render() =>
            Value is ListValue { DirectExpression: not null } list &&
            (list.DirectExpression == "..." ||
             list.DirectExpression.StartsWith("select(", StringComparison.Ordinal))
                ? list.DirectExpression
                : $"unpack_values({Value.Render()})";
    }

    private sealed class SymbolicFrame(
        SymbolicFrame? parent = null,
        IEnumerable<SymbolicValue>? initial = null)
    {
        public SymbolicFrame? Parent { get; } = parent;
        public List<SymbolicValue> Values { get; } = initial?.ToList() ?? [];
        public int Count => Values.Count;

        public void Push(SymbolicValue value) => Values.Add(value);

        public SymbolicValue Pop()
        {
            if (Values.Count == 0)
            {
                return new ExpressionValue("nil");
            }
            var value = Values[^1];
            Values.RemoveAt(Values.Count - 1);
            return value;
        }

        public SymbolicValue Peek(int fromTop = 0) =>
            Values.Count > fromTop ? Values[Values.Count - fromTop - 1] : new ExpressionValue("nil");

        public void ReplaceTop(SymbolicValue value)
        {
            if (Values.Count == 0)
            {
                Values.Add(value);
            }
            else
            {
                Values[^1] = value;
            }
        }

        public void SetFromTop(int fromTop, SymbolicValue value)
        {
            if (Values.Count > fromTop)
            {
                Values[Values.Count - fromTop - 1] = value;
            }
        }

        public void Swap(int distance)
        {
            var other = Values.Count - distance - 1;
            if (Values.Count == 0 || other < 0 || other >= Values.Count)
            {
                return;
            }
            (Values[^1], Values[other]) = (Values[other], Values[^1]);
        }

        public SymbolicFrame DeepClone() =>
            new(Parent?.DeepClone(), Values.Select(value => value.Clone()));

        public SymbolicFrame WithValues(IEnumerable<SymbolicValue> values) =>
            new(Parent, values);
    }

    private sealed class SymbolicState
    {
        private int _nextEnvironment = 1;
        private int _nextResult = 1;
        private int _nextPhi = 1;
        private int _nextLoop = 1;
        private readonly FunctionAnalysis _analysis;

        public SymbolicState(FunctionAnalysis analysis)
        {
            _analysis = analysis;
            Environment = new EnvironmentScope(0, null);
        }

        public SymbolicFrame Frame { get; set; } = new();
        public EnvironmentScope Environment { get; set; }
        public HashSet<string> LocalVariables { get; } = [];
        public int ResultCount => _nextResult - 1;
        public int PhiCount => _nextPhi - 1;
        public bool Terminated { get; set; }

        public EnvironmentScope CreateEnvironment(EnvironmentScope parent) =>
            new(_nextEnvironment++, parent);

        public string CreateResult() => $"result{_nextResult++}";
        public string CreatePhi() => $"value{_nextPhi++}";
        public string CreateLoop() => $"i{_nextLoop++}";
        public string ArgumentName(int index) => $"arg{index}";

        public string RenderAllArguments() =>
            string.Join(
                ", ",
                Enumerable.Range(1, _analysis.ArgumentCount)
                    .Select(ArgumentName)
                    .Append("..."));

        public ListValue CreateVarargList(int offset)
        {
            var values = Enumerable.Range(
                    offset + 1,
                    Math.Max(0, _analysis.ArgumentCount - offset))
                .Select(index => (SymbolicValue)new ExpressionValue(ArgumentName(index)))
                .ToList();
            values.Add(new SpreadValue(new ListValue([], "...")));
            return new ListValue(values);
        }

        public string ResolveVariable(int depth, int slot) =>
            ResolveVariable(Environment, depth, slot);

        public string ResolveVariable(EnvironmentScope environment, int depth, int slot)
        {
            while (depth > 0 && environment.Parent is not null)
            {
                environment = environment.Parent;
                depth--;
            }

            if (depth > 0)
            {
                return _analysis.CaptureName(new CaptureReference(depth, slot));
            }

            if (environment.TryGetBinding(slot, out var binding))
            {
                return binding;
            }

            var name = environment.Id == 0
                ? $"v{slot}"
                : $"v{environment.Id}_{slot}";
            environment.Bind(slot, name);
            LocalVariables.Add(name);
            return name;
        }

        public void AbsorbLocals(SymbolicState other)
        {
            foreach (var local in other.LocalVariables)
            {
                LocalVariables.Add(local);
            }
        }

        public StateSnapshot Snapshot() =>
            new(Frame.DeepClone(), Environment, Terminated);

        public void Restore(StateSnapshot snapshot)
        {
            Frame = snapshot.Frame.DeepClone();
            Environment = snapshot.Environment;
            Terminated = snapshot.Terminated;
        }

        public SymbolicState CloneForPreview()
        {
            var clone = new SymbolicState(_analysis)
            {
                _nextEnvironment = _nextEnvironment,
                _nextResult = _nextResult,
                _nextPhi = _nextPhi,
                _nextLoop = _nextLoop,
                Frame = Frame.DeepClone(),
                Environment = Environment,
                Terminated = Terminated
            };
            foreach (var local in LocalVariables)
            {
                clone.LocalVariables.Add(local);
            }
            return clone;
        }
    }

    private sealed class EnvironmentScope(int id, EnvironmentScope? parent)
    {
        private readonly Dictionary<int, string> _bindings = [];

        public int Id { get; } = id;
        public EnvironmentScope? Parent { get; } = parent;

        public void Bind(int slot, string name) => _bindings[slot] = name;

        public bool TryGetBinding(int slot, out string name) =>
            _bindings.TryGetValue(slot, out name!);
    }

    private sealed record StateSnapshot(
        SymbolicFrame Frame,
        EnvironmentScope Environment,
        bool Terminated);
    private sealed record FunctionSlice(int Index, int StartPc, int EndPc);
    private sealed record CaptureReference(int Depth, int Slot);
    private sealed record ClosureSite(int ChildIndex, int LocalDepth);
    private sealed class FunctionAnalysis(
        FunctionSlice function,
        string name,
        int argumentCount,
        bool usesVarargs,
        List<CaptureReference> captures)
    {
        public FunctionSlice Function { get; } = function;
        public string Name { get; } = name;
        public int ArgumentCount { get; } = argumentCount;
        public bool UsesVarargs { get; } = usesVarargs;
        public List<CaptureReference> Captures { get; } = captures;

        public string CaptureName(CaptureReference capture)
        {
            for (var index = 0; index < Captures.Count; index++)
            {
                if (Captures[index] == capture)
                {
                    return $"upvalue{index + 1}";
                }
            }
            Captures.Add(capture);
            return $"upvalue{Captures.Count}";
        }
    }
    private sealed record ProtectionScaffold(
        HashSet<int> HiddenFunctions,
        Dictionary<int, HashSet<int>> SkippedInstructions)
    {
        public static ProtectionScaffold Empty { get; } = new([], []);
    }
    private sealed record FunctionResult(string Source, int Unknown);

    private static string Quote(byte[] bytes)
    {
        var output = new StringBuilder("\"");
        foreach (var value in bytes)
        {
            switch (value)
            {
                case (byte)'\\':
                    output.Append(@"\\");
                    break;
                case (byte)'"':
                    output.Append("\\\"");
                    break;
                case (byte)'\n':
                    output.Append(@"\n");
                    break;
                case (byte)'\r':
                    output.Append(@"\r");
                    break;
                case (byte)'\t':
                    output.Append(@"\t");
                    break;
                case >= 0x20 and <= 0x7E:
                    output.Append((char)value);
                    break;
                default:
                    output.Append('\\').Append(value.ToString("D3", CultureInfo.InvariantCulture));
                    break;
            }
        }
        return output.Append('"').ToString();
    }

    [GeneratedRegex(@"^[A-Za-z_][A-Za-z0-9_]*$")]
    private static partial Regex IdentifierRegex();
}
