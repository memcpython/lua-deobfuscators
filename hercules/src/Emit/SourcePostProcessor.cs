namespace HerculesDeobfuscator.Emit;

public static class SourcePostProcessor
{
    private const string Watermark =
        "-- This file was deobfuscated by VX [ https://discord.gg/qa2fwcB7K ]";

    public static string Process(string source)
    {
        source = source.Replace("\r\n", "\n", StringComparison.Ordinal);
        source = RepairElseLabels(source).Trim();
        return $"{Watermark}\n\n{source}\n";
    }

    private static string RepairElseLabels(string source)
    {
        var lines = source.Split('\n').ToList();
        var repairIndex = 0;

        while (true)
        {
            var repaired = false;
            for (var elseIndex = 0; elseIndex < lines.Count; elseIndex++)
            {
                if (lines[elseIndex].Trim() != "else")
                {
                    continue;
                }

                var labelIndex = elseIndex + 1;
                while (labelIndex < lines.Count &&
                       string.IsNullOrWhiteSpace(lines[labelIndex]))
                {
                    labelIndex++;
                }
                if (labelIndex >= lines.Count ||
                    !TryReadLabel(lines[labelIndex], out var label))
                {
                    continue;
                }

                var indentation = LeadingWhitespace(lines[elseIndex]);
                var ifIndex = FindOpeningIf(lines, elseIndex, indentation);
                var endIndex = FindClosingEnd(lines, labelIndex, indentation);
                if (ifIndex < 0 || endIndex < 0)
                {
                    continue;
                }

                var afterLabel = $"__vx_after_{label}_{repairIndex++}";
                var replacement = new List<string>
                {
                    $"{indentation}  goto {afterLabel}",
                    $"{indentation}end",
                    $"{indentation}::{label}::",
                    $"{indentation}do"
                };
                replacement.AddRange(lines.Skip(labelIndex + 1).Take(endIndex - labelIndex - 1));
                replacement.Add($"{indentation}end");
                replacement.Add($"{indentation}::{afterLabel}::");

                lines.RemoveRange(elseIndex, endIndex - elseIndex + 1);
                lines.InsertRange(elseIndex, replacement);
                repaired = true;
                break;
            }

            if (!repaired)
            {
                return string.Join('\n', lines);
            }
        }
    }

    private static int FindOpeningIf(
        IReadOnlyList<string> lines,
        int elseIndex,
        string indentation)
    {
        for (var index = elseIndex - 1; index >= 0; index--)
        {
            var line = lines[index];
            var trimmed = line.Trim();
            if (LeadingWhitespace(line) == indentation &&
                trimmed.StartsWith("if ", StringComparison.Ordinal) &&
                trimmed.EndsWith(" then", StringComparison.Ordinal))
            {
                return index;
            }
        }
        return -1;
    }

    private static int FindClosingEnd(
        IReadOnlyList<string> lines,
        int labelIndex,
        string indentation)
    {
        for (var index = labelIndex + 1; index < lines.Count; index++)
        {
            if (LeadingWhitespace(lines[index]) == indentation &&
                lines[index].Trim() == "end")
            {
                return index;
            }
        }
        return -1;
    }

    private static bool TryReadLabel(string line, out string label)
    {
        var trimmed = line.Trim();
        if (trimmed.Length > 4 &&
            trimmed.StartsWith("::", StringComparison.Ordinal) &&
            trimmed.EndsWith("::", StringComparison.Ordinal))
        {
            label = trimmed[2..^2];
            return label.All(character =>
                character == '_' ||
                char.IsAsciiLetterOrDigit(character));
        }

        label = string.Empty;
        return false;
    }

    private static string LeadingWhitespace(string value) =>
        value[..(value.Length - value.TrimStart().Length)];
}
