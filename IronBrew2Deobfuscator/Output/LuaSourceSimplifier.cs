using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace IronBrew2Deobfuscator;

internal static partial class LuaSourceSimplifier
{
    public static string Process(string source)
    {
        var normalized = source.Replace("\r\n", "\n", StringComparison.Ordinal);
        var hadTrailingNewLine = normalized.EndsWith('\n');
        var lines = normalized.Split('\n').ToList();
        if (hadTrailingNewLine && lines.Count > 0 && lines[^1].Length == 0)
            lines.RemoveAt(lines.Count - 1);

        for (var i = 0; i < 4; i++)
        {
            var changed = false;
            changed |= SimplifyEmptyElse(lines);
            changed |= ReduceMethodCalls(lines);
            changed |= ReduceImmediateTempCalls(lines);
            changed |= ReduceInlineMethodExpressions(lines);
            changed |= ReduceImmediateMethodArguments(lines);
            changed |= InlineImmediateTableArguments(lines);
            if (!changed)
                break;
        }

        return string.Join(Environment.NewLine, lines) + (hadTrailingNewLine ? Environment.NewLine : string.Empty);
    }

    private static bool SimplifyEmptyElse(List<string> lines)
    {
        var changed = false;
        for (var i = 0; i + 1 < lines.Count; i++)
        {
            var match = IfLineRegex().Match(lines[i]);
            if (!match.Success)
                continue;

            if (lines[i + 1].Trim() != "else")
                continue;

            var indent = match.Groups["indent"].Value;
            if (GetIndent(lines[i + 1]) != indent)
                continue;

            lines[i] = indent + "if " + InvertCondition(match.Groups["cond"].Value.Trim()) + " then";
            lines.RemoveAt(i + 1);
            changed = true;
        }

        return changed;
    }

    private static bool ReduceMethodCalls(List<string> lines)
    {
        var changed = false;
        for (var i = 0; i < lines.Count; i++)
        {
            var call = CallLineRegex().Match(lines[i]);
            if (!call.Success)
                continue;

            var indent = call.Groups["indent"].Value;
            var functionVar = call.Groups["func"].Value;
            var args = SplitArguments(call.Groups["args"].Value);
            if (args.Count == 0 || !TempRegex().IsMatch(args[0]))
                continue;

            var selfVar = args[0];
            if (!TryFindMethodSetup(lines, i, indent, functionVar, selfVar, out var setup))
                continue;

            var rewrittenArgs = args.Skip(1).Select(arg => SubstituteTemps(arg, setup.ArgumentAliases)).ToList();
            var target = call.Groups["target"].Success ? call.Groups["target"].Value + " = " : string.Empty;
            lines[i] = indent + target + setup.BaseExpression + ":" + setup.MemberName + "(" + string.Join(", ", rewrittenArgs) + ")";

            RemoveIndexes(lines, setup.RemoveIndexes);
            i -= setup.RemoveIndexes.Count(index => index < i);
            changed = true;
        }

        return changed;
    }

    private static bool ReduceImmediateTempCalls(List<string> lines)
    {
        var changed = false;
        for (var i = 0; i < lines.Count; i++)
        {
            var call = CallLineRegex().Match(lines[i]);
            if (!call.Success)
                continue;

            var indent = call.Groups["indent"].Value;
            var assignments = new List<(int Index, string Var, string Expr)>();
            for (var j = i - 1; j >= 0; j--)
            {
                var assignment = AssignmentRegex().Match(lines[j]);
                if (!assignment.Success || assignment.Groups["indent"].Value != indent)
                    break;

                var expression = assignment.Groups["expr"].Value.Trim();
                if (!IsSafeInlineExpression(expression))
                    break;

                assignments.Add((j, assignment.Groups["var"].Value, expression));
            }

            if (assignments.Count == 0)
                continue;

            assignments.Reverse();
            assignments = SelectUsedAssignments(
                assignments,
                new[] { call.Groups["func"].Value }.Concat(SplitArguments(call.Groups["args"].Value)));

            if (assignments.Count == 0)
                continue;

            var aliases = BuildAliases(assignments);

            var functionExpression = SubstituteTemps(call.Groups["func"].Value, aliases);
            if (functionExpression == call.Groups["func"].Value)
                continue;

            var args = SplitArguments(call.Groups["args"].Value)
                .Select(arg => SubstituteTemps(arg, aliases))
                .ToList();

            var target = call.Groups["target"].Success ? call.Groups["target"].Value + " = " : string.Empty;
            lines[i] = indent + target + functionExpression + "(" + string.Join(", ", args) + ")";
            RemoveIndexes(lines, assignments.Select(assignment => assignment.Index).ToList());
            i -= assignments.Count;
            changed = true;
        }

        return changed;
    }

    private static bool ReduceInlineMethodExpressions(List<string> lines)
    {
        var changed = false;
        for (var i = 0; i < lines.Count; i++)
        {
            var rewritten = InlineMethodExpressionRegex().Replace(lines[i], match =>
                match.Groups["base"].Value + ":" + match.Groups["member"].Value + "(");
            rewritten = StringLiteralMethodExpressionRegex().Replace(rewritten, match =>
                "(" + match.Groups["literal"].Value + "):" + match.Groups["member"].Value + "(");
            rewritten = StringLiteralColonCallRegex().Replace(rewritten, match =>
                "(" + match.Groups["literal"].Value + "):" + match.Groups["member"].Value + "(");
            if (rewritten == lines[i])
                continue;

            lines[i] = rewritten;
            changed = true;
        }

        return changed;
    }

    private static bool ReduceImmediateMethodArguments(List<string> lines)
    {
        var changed = false;
        for (var i = 0; i < lines.Count; i++)
        {
            var call = MethodCallLineRegex().Match(lines[i]);
            if (!call.Success)
                continue;

            var indent = call.Groups["indent"].Value;
            var assignments = new List<(int Index, string Var, string Expr)>();
            for (var j = i - 1; j >= 0; j--)
            {
                var assignment = AssignmentRegex().Match(lines[j]);
                if (!assignment.Success || assignment.Groups["indent"].Value != indent)
                    break;

                var expression = assignment.Groups["expr"].Value.Trim();
                if (!IsSafeInlineExpression(expression))
                    break;

                assignments.Add((j, assignment.Groups["var"].Value, expression));
            }

            if (assignments.Count == 0)
                continue;

            assignments.Reverse();
            assignments = SelectUsedAssignments(
                assignments,
                new[] { call.Groups["base"].Value }.Concat(SplitArguments(call.Groups["args"].Value)));

            if (assignments.Count == 0)
                continue;

            var aliases = BuildAliases(assignments);

            var baseExpression = SubstituteTemps(call.Groups["base"].Value, aliases);
            var args = SplitArguments(call.Groups["args"].Value)
                .Select(arg => SubstituteTemps(arg, aliases))
                .ToList();

            var target = call.Groups["target"].Success ? call.Groups["target"].Value + " = " : string.Empty;
            var rewritten = indent + target + baseExpression + ":" + call.Groups["member"].Value + "(" + string.Join(", ", args) + ")";
            if (rewritten == lines[i])
                continue;

            lines[i] = rewritten;
            RemoveIndexes(lines, assignments.Select(assignment => assignment.Index).ToList());
            i -= assignments.Count;
            changed = true;
        }

        return changed;
    }

    private static bool InlineImmediateTableArguments(List<string> lines)
    {
        var changed = false;
        for (var i = 0; i < lines.Count; i++)
        {
            if (!lines[i].Contains('('))
                continue;

            if (!TryReadImmediateTable(lines, i, out var table))
                continue;

            if (!ContainsIdentifier(lines[i], table.Variable) || IsUsedSoon(lines, i + 1, table.Variable))
                continue;

            var literal = BuildInlineTableLiteral(table, GetIndent(lines[i]));
            var rewritten = ReplaceIdentifierOnce(lines[i], table.Variable, literal);
            if (rewritten == lines[i])
                continue;

            lines[i] = rewritten;
            RemoveIndexes(lines, table.RemoveIndexes);
            i -= table.RemoveIndexes.Count(index => index < i);
            changed = true;
        }

        return changed;
    }

    private static bool TryReadImmediateTable(IReadOnlyList<string> lines, int useIndex, out InlineTable table)
    {
        table = default;
        var fields = new List<(string Name, string Value)>();
        var removeIndexes = new List<int>();
        string? tableVar = null;
        string? indent = null;

        for (var i = useIndex - 1; i >= 0; i--)
        {
            var field = TableFieldAssignmentRegex().Match(lines[i]);
            if (field.Success && (indent == null || field.Groups["indent"].Value == indent))
            {
                var currentVar = field.Groups["var"].Value;
                tableVar ??= currentVar;
                indent ??= field.Groups["indent"].Value;
                if (currentVar == tableVar)
                {
                    fields.Add((field.Groups["field"].Value, field.Groups["expr"].Value.Trim()));
                    removeIndexes.Add(i);
                    continue;
                }
            }

            var init = TableInitRegex().Match(lines[i]);
            if (!init.Success || fields.Count == 0)
                return false;

            if (indent != null && init.Groups["indent"].Value != indent)
                return false;

            if (tableVar == null || init.Groups["var"].Value != tableVar)
                return false;

            removeIndexes.Add(i);
            fields.Reverse();
            table = new InlineTable(tableVar, fields, removeIndexes);
            return true;
        }

        return false;
    }

    private static bool IsUsedSoon(IReadOnlyList<string> lines, int start, string identifier)
    {
        var end = Math.Min(lines.Count, start + 12);
        for (var i = start; i < end; i++)
        {
            if (IsHardBoundary(lines[i]))
                return false;

            var assignment = AssignmentRegex().Match(lines[i]);
            if (assignment.Success && assignment.Groups["var"].Value == identifier)
                return false;

            if (ContainsIdentifier(lines[i], identifier))
                return true;
        }

        return false;
    }

    private static string BuildInlineTableLiteral(InlineTable table, string callIndent)
    {
        var fieldIndent = callIndent + "  ";
        var lines = new List<string> { "{" };
        for (var i = 0; i < table.Fields.Count; i++)
        {
            var field = table.Fields[i];
            var comma = i + 1 == table.Fields.Count ? string.Empty : ",";
            lines.Add(fieldIndent + field.Name + " = " + field.Value + comma);
        }

        lines.Add(callIndent + "}");
        return string.Join(Environment.NewLine, lines);
    }

    private static string ReplaceIdentifierOnce(string line, string identifier, string replacement)
    {
        var firstArgumentOffset = line.IndexOf('(');
        if (firstArgumentOffset < 0)
            return line;

        var regex = new Regex($@"(?<![A-Za-z0-9_]){Regex.Escape(identifier)}(?![A-Za-z0-9_])");
        var prefix = line[..(firstArgumentOffset + 1)];
        var suffix = line[(firstArgumentOffset + 1)..];
        return prefix + regex.Replace(suffix, replacement, 1);
    }

    private static bool TryFindMethodSetup(
        IReadOnlyList<string> lines,
        int callIndex,
        string indent,
        string functionVar,
        string selfVar,
        out MethodSetup setup)
    {
        setup = default;
        var minimum = Math.Max(0, callIndex - 48);
        var methodIndex = -1;
        Match? methodMatch = null;
        for (var i = callIndex - 1; i >= minimum; i--)
        {
            if (IsHardBoundary(lines[i]))
                break;

            var match = MethodAssignmentRegex().Match(lines[i]);
            if (!match.Success || match.Groups["indent"].Value != indent || match.Groups["var"].Value != functionVar)
                continue;

            methodIndex = i;
            methodMatch = match;
            break;
        }

        if (methodIndex < 0 || methodMatch == null)
            return false;

        var baseExpression = methodMatch.Groups["base"].Value.Trim();
        var selfIndex = -1;
        for (var i = methodIndex - 1; i >= minimum; i--)
        {
            if (IsHardBoundary(lines[i]))
                break;

            var match = AssignmentRegex().Match(lines[i]);
            if (!match.Success || match.Groups["indent"].Value != indent || match.Groups["var"].Value != selfVar)
                continue;

            var selfExpression = match.Groups["expr"].Value.Trim();
            if (selfExpression != baseExpression)
                continue;

            selfIndex = i;
            break;
        }

        if (selfIndex < 0)
            return false;

        for (var i = selfIndex + 1; i < callIndex; i++)
        {
            if (i == methodIndex)
                continue;

            var line = lines[i];
            if (ContainsIdentifier(line, functionVar) || ContainsIdentifier(line, selfVar))
                return false;
        }

        setup = new MethodSetup(
            baseExpression,
            methodMatch.Groups["member"].Value,
            new Dictionary<string, string>(StringComparer.Ordinal),
            new List<int> { methodIndex, selfIndex });
        return true;
    }

    private static void RemoveIndexes(List<string> lines, IReadOnlyCollection<int> indexes)
    {
        foreach (var index in indexes.OrderByDescending(static index => index))
            lines.RemoveAt(index);
    }

    private static string InvertCondition(string condition)
    {
        if (condition.StartsWith("not ", StringComparison.Ordinal))
            return condition[4..].Trim();

        return IsSimpleExpression(condition) ? "not " + condition : "not (" + condition + ")";
    }

    private static string SubstituteTemps(string expression, IReadOnlyDictionary<string, string> aliases)
    {
        return TempIdentifierRegex().Replace(expression, match =>
        {
            var name = match.Value;
            return aliases.TryGetValue(name, out var value) ? value : name;
        });
    }

    private static Dictionary<string, string> BuildAliases(IReadOnlyList<(int Index, string Var, string Expr)> assignments)
    {
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var assignment in assignments)
            aliases[assignment.Var] = SubstituteTemps(assignment.Expr, aliases);
        return aliases;
    }

    private static List<(int Index, string Var, string Expr)> SelectUsedAssignments(
        IReadOnlyList<(int Index, string Var, string Expr)> assignments,
        IEnumerable<string> roots)
    {
        var byVar = assignments
            .GroupBy(static assignment => assignment.Var, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.Last(), StringComparer.Ordinal);

        var selected = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Stack<string>(roots.SelectMany(ExtractTemps));
        while (pending.Count > 0)
        {
            var variable = pending.Pop();
            if (!selected.Add(variable))
                continue;

            if (!byVar.TryGetValue(variable, out var assignment))
                continue;

            foreach (var dependency in ExtractTemps(assignment.Expr))
                pending.Push(dependency);
        }

        return assignments.Where(assignment => selected.Contains(assignment.Var)).ToList();
    }

    private static IEnumerable<string> ExtractTemps(string expression) =>
        TempIdentifierRegex().Matches(expression).Select(static match => match.Value);

    private static bool ContainsIdentifier(string text, string identifier) =>
        Regex.IsMatch(text, $@"(?<![A-Za-z0-9_]){Regex.Escape(identifier)}(?![A-Za-z0-9_])");

    private static bool IsHardBoundary(string line)
    {
        var trimmed = line.Trim();
        return trimmed.Length == 0 ||
               trimmed == "else" ||
               trimmed == "end" ||
               trimmed.StartsWith("::", StringComparison.Ordinal) ||
               trimmed.StartsWith("return ", StringComparison.Ordinal) ||
               trimmed.StartsWith("if ", StringComparison.Ordinal) ||
               trimmed.StartsWith("for ", StringComparison.Ordinal) ||
               trimmed.StartsWith("while ", StringComparison.Ordinal) ||
               trimmed.StartsWith("repeat", StringComparison.Ordinal) ||
               trimmed.StartsWith("function ", StringComparison.Ordinal);
    }

    private static bool IsSafeInlineExpression(string expression)
    {
        expression = expression.Trim();
        if (expression.Length == 0 || expression is "{}")
            return false;

        if (StringLiteralRegex().IsMatch(expression) ||
            NumberRegex().IsMatch(expression) ||
            expression is "true" or "false" or "nil")
            return true;

        if (expression.StartsWith("#", StringComparison.Ordinal))
            return IsSimpleExpression(expression[1..].Trim());

        return IsSimpleExpression(expression);
    }

    private static bool IsSimpleExpression(string expression) => SimpleExpressionRegex().IsMatch(expression.Trim());

    private static string GetIndent(string line)
    {
        var count = 0;
        while (count < line.Length && char.IsWhiteSpace(line[count]))
            count++;
        return line[..count];
    }

    private static List<string> SplitArguments(string args)
    {
        var output = new List<string>();
        var start = 0;
        var depth = 0;
        var quote = '\0';
        var escaped = false;
        for (var i = 0; i < args.Length; i++)
        {
            var ch = args[i];
            if (quote != '\0')
            {
                if (escaped)
                {
                    escaped = false;
                    continue;
                }

                if (ch == '\\')
                {
                    escaped = true;
                    continue;
                }

                if (ch == quote)
                    quote = '\0';
                continue;
            }

            if (ch is '"' or '\'')
            {
                quote = ch;
                continue;
            }

            if (ch is '(' or '{' or '[')
            {
                depth++;
                continue;
            }

            if (ch is ')' or '}' or ']')
            {
                depth = Math.Max(0, depth - 1);
                continue;
            }

            if (ch != ',' || depth != 0)
                continue;

            output.Add(args[start..i].Trim());
            start = i + 1;
        }

        var tail = args[start..].Trim();
        if (tail.Length > 0)
            output.Add(tail);
        return output;
    }

    private readonly record struct MethodSetup(
        string BaseExpression,
        string MemberName,
        IReadOnlyDictionary<string, string> ArgumentAliases,
        IReadOnlyCollection<int> RemoveIndexes);

    private readonly record struct InlineTable(
        string Variable,
        IReadOnlyList<(string Name, string Value)> Fields,
        IReadOnlyCollection<int> RemoveIndexes);

    [GeneratedRegex(@"^(?<indent>\s*)if\s+(?<cond>.+)\s+then\s*$")]
    private static partial Regex IfLineRegex();

    [GeneratedRegex(@"^(?<indent>\s*)(?:(?<target>L\d+_\d+)\s*=\s*)?(?<func>L\d+_\d+)\((?<args>.*)\)\s*$")]
    private static partial Regex CallLineRegex();

    [GeneratedRegex(@"^(?<indent>\s*)(?<var>L\d+_\d+)\s*=\s*(?<expr>.+?)\s*$")]
    private static partial Regex AssignmentRegex();

    [GeneratedRegex(@"^(?<indent>\s*)(?<var>L\d+_\d+)\s*=\s*(?<base>.+)\.(?<member>[A-Za-z_]\w*)\s*$")]
    private static partial Regex MethodAssignmentRegex();

    [GeneratedRegex(@"^L\d+_\d+$")]
    private static partial Regex TempRegex();

    [GeneratedRegex(@"(?<![A-Za-z0-9_])L\d+_\d+(?![A-Za-z0-9_])")]
    private static partial Regex TempIdentifierRegex();

    [GeneratedRegex(@"^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$")]
    private static partial Regex SimpleExpressionRegex();

    [GeneratedRegex(@"^-?\d+(?:\.\d+)?$")]
    private static partial Regex NumberRegex();

    [GeneratedRegex("^\"(?:\\\\.|[^\"\\\\])*\"$")]
    private static partial Regex StringLiteralRegex();

    [GeneratedRegex(@"(?<base>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.(?<member>[A-Za-z_]\w*)\(\s*\k<base>\s*,\s*")]
    private static partial Regex InlineMethodExpressionRegex();

    [GeneratedRegex("(?<literal>\"(?:\\\\.|[^\"\\\\])*\")\\.(?<member>[A-Za-z_]\\w*)\\(\\s*\\k<literal>\\s*,\\s*")]
    private static partial Regex StringLiteralMethodExpressionRegex();

    [GeneratedRegex("(?<literal>\"(?:\\\\.|[^\"\\\\])*\"):(?<member>[A-Za-z_]\\w*)\\(")]
    private static partial Regex StringLiteralColonCallRegex();

    [GeneratedRegex(@"^(?<indent>\s*)(?:(?<target>L\d+_\d+)\s*=\s*)?(?<base>L\d+_\d+):(?<member>[A-Za-z_]\w*)\((?<args>.*)\)\s*$")]
    private static partial Regex MethodCallLineRegex();

    [GeneratedRegex(@"^(?<indent>\s*)(?<var>L\d+_\d+)\s*=\s*\{\}\s*$")]
    private static partial Regex TableInitRegex();

    [GeneratedRegex(@"^(?<indent>\s*)(?<var>L\d+_\d+)\.(?<field>[A-Za-z_]\w*)\s*=\s*(?<expr>.+?)\s*$")]
    private static partial Regex TableFieldAssignmentRegex();
}
