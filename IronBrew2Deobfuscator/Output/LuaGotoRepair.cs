using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace IronBrew2Deobfuscator;

internal static partial class LuaGotoRepair
{
    public static string Process(string source)
    {
        var normalized = source.Replace("\r\n", "\n", StringComparison.Ordinal);
        var hadTrailingNewLine = normalized.EndsWith('\n');
        var lines = normalized.Split('\n').ToList();
        if (hadTrailingNewLine && lines.Count > 0 && lines[^1].Length == 0)
            lines.RemoveAt(lines.Count - 1);

        var infos = Analyze(lines);
        var labels = infos
            .Where(static info => info.Label != null)
            .GroupBy(static info => info.Label!, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.ToList(), StringComparer.Ordinal);

        foreach (var info in infos.Where(static info => info.Goto != null))
        {
            if (labels.TryGetValue(info.Goto!, out var targets) &&
                targets.Any(target => IsVisible(target.Path, info.Path)))
            {
                continue;
            }

            var indent = new string(' ', info.Indent);
            lines[info.Index] = indent + "-- " + lines[info.Index].TrimStart() + " -- repaired: invisible decompiler label";
        }

        return string.Join(Environment.NewLine, lines) + (hadTrailingNewLine ? Environment.NewLine : string.Empty);
    }

    private static List<LineInfo> Analyze(IReadOnlyList<string> lines)
    {
        var infos = new List<LineInfo>(lines.Count);
        var blocks = new Stack<Block>();
        var nextBlockId = 1;

        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i];
            var indent = GetIndent(line);
            var trimmed = line.Trim();
            while (blocks.Count > 0 && indent < blocks.Peek().BodyIndent)
                blocks.Pop();

            var path = blocks.Reverse().Select(static block => block.Id).ToArray();
            var gotoMatch = GotoRegex().Match(trimmed);
            var labelMatch = LabelRegex().Match(trimmed);
            infos.Add(new LineInfo(
                i,
                indent,
                path,
                gotoMatch.Success ? gotoMatch.Groups["label"].Value : null,
                labelMatch.Success ? labelMatch.Groups["label"].Value : null));

            if (StartsBlock(trimmed))
                blocks.Push(new Block(nextBlockId++, indent + 2));
        }

        return infos;
    }

    private static bool StartsBlock(string trimmed)
    {
        if (trimmed.Length == 0 || trimmed.StartsWith("--", StringComparison.Ordinal))
            return false;

        return trimmed.StartsWith("if ", StringComparison.Ordinal) && trimmed.EndsWith(" then", StringComparison.Ordinal) ||
               trimmed.StartsWith("elseif ", StringComparison.Ordinal) && trimmed.EndsWith(" then", StringComparison.Ordinal) ||
               trimmed == "else" ||
               trimmed.StartsWith("for ", StringComparison.Ordinal) && trimmed.EndsWith(" do", StringComparison.Ordinal) ||
               trimmed.StartsWith("while ", StringComparison.Ordinal) && trimmed.EndsWith(" do", StringComparison.Ordinal) ||
               trimmed == "repeat" ||
               trimmed.StartsWith("function ", StringComparison.Ordinal) ||
               trimmed.StartsWith("local function ", StringComparison.Ordinal);
    }

    private static bool IsVisible(IReadOnlyList<int> labelPath, IReadOnlyList<int> gotoPath)
    {
        if (labelPath.Count > gotoPath.Count)
            return false;

        for (var i = 0; i < labelPath.Count; i++)
            if (labelPath[i] != gotoPath[i])
                return false;

        return true;
    }

    private static int GetIndent(string line)
    {
        var count = 0;
        while (count < line.Length && line[count] == ' ')
            count++;
        return count;
    }

    private readonly record struct Block(int Id, int BodyIndent);
    private readonly record struct LineInfo(int Index, int Indent, IReadOnlyList<int> Path, string? Goto, string? Label);

    [GeneratedRegex(@"^goto\s+(?<label>[A-Za-z_]\w*)\s*$")]
    private static partial Regex GotoRegex();

    [GeneratedRegex(@"^::(?<label>[A-Za-z_]\w*)::\s*$")]
    private static partial Regex LabelRegex();
}
