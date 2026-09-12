using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace IronBrew2Deobfuscator;

internal static partial class OpenCallReducer
{
    public static string Process(string source)
    {
        var normalized = source.Replace("\r\n", "\n", StringComparison.Ordinal);
        var hadTrailingNewLine = normalized.EndsWith('\n');
        var lines = normalized.Split('\n').ToList();
        if (hadTrailingNewLine && lines.Count > 0 && lines[^1].Length == 0)
            lines.RemoveAt(lines.Count - 1);

        var output = new List<string>(lines.Count);
        for (var i = 0; i < lines.Count;)
        {
            if (i + 1 < lines.Count && TryCollapse(lines[i], lines[i + 1], out var collapsedLine))
            {
                output.Add(collapsedLine);
                i += 2;
                continue;
            }

            output.Add(lines[i]);
            i++;
        }

        return string.Join(Environment.NewLine, output) + (hadTrailingNewLine ? Environment.NewLine : string.Empty);
    }

    private static bool TryCollapse(string assignmentLine, string consumerLine, out string collapsedLine)
    {
        collapsedLine = string.Empty;
        var match = MultiAssignmentRegex().Match(assignmentLine);
        if (!match.Success)
            return false;

        var vars = match.Groups["vars"].Value;
        var varCount = vars.Split(',').Length;
        if (varCount < 5)
            return false;

        var expression = match.Groups["expr"].Value;
        var firstCallParen = consumerLine.IndexOf('(');
        if (firstCallParen < 0)
            return false;

        var index = consumerLine.IndexOf(vars, firstCallParen + 1, StringComparison.Ordinal);
        if (index < 0)
            return false;

        collapsedLine = consumerLine.Remove(index, vars.Length).Insert(index, expression);
        return true;
    }

    [GeneratedRegex(@"^\s*(?<vars>[A-Za-z_]\w*(?:,\s*[A-Za-z_]\w*){4,})\s*=\s*(?<expr>(?:.+\)|\.\.\.))\s*$")]
    private static partial Regex MultiAssignmentRegex();
}
