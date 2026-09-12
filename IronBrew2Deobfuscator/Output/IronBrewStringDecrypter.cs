using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace IronBrew2Deobfuscator;

internal static partial class IronBrewStringDecrypter
{
    private static readonly Encoding LuaEncoding = Encoding.GetEncoding(28591);

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
            if (TryMatchInlinedDecryptor(lines, i, out var replacement, out var nextIndex))
            {
                output.Add(replacement);
                i = nextIndex;
                continue;
            }

            output.Add(lines[i]);
            i++;
        }

        return string.Join(Environment.NewLine, output) + (hadTrailingNewLine ? Environment.NewLine : string.Empty);
    }

    private static bool TryMatchInlinedDecryptor(
        IReadOnlyList<string> lines,
        int start,
        out string replacement,
        out int nextIndex)
    {
        replacement = string.Empty;
        nextIndex = start;

        var encryptedAssignment = AssignmentStringRegex().Match(lines[start]);
        if (!encryptedAssignment.Success)
            return false;

        var encrypted = UnescapeLuaString(encryptedAssignment.Groups["literal"].Value);

        var outputIndex = FindEmptyAccumulator(lines, start + 1, Math.Min(lines.Count, start + 20));
        if (outputIndex < 0)
            return false;

        var outputAssignment = AssignmentStringRegex().Match(lines[outputIndex]);
        var indent = encryptedAssignment.Groups["indent"].Value;
        if (outputAssignment.Groups["indent"].Value != indent || CrossesFunctionBoundary(lines, start + 1, outputIndex))
            return false;

        var accumulatorVar = outputAssignment.Groups["var"].Value;

        if (!LooksLikeStringTableSetup(lines, outputIndex))
            return false;

        var keyIndex = FindKeyAssignment(lines, outputIndex + 1, Math.Min(lines.Count, outputIndex + 35));
        if (keyIndex < 0)
            return false;

        var keyAssignment = AssignmentStringRegex().Match(lines[keyIndex]);
        if (keyAssignment.Groups["indent"].Value != indent)
            return false;

        var key = UnescapeLuaString(keyAssignment.Groups["literal"].Value);
        if (key.Length == 0)
            return false;

        var decryptLoopIndex = FindDecryptLoop(lines, keyIndex + 1, Math.Min(lines.Count, keyIndex + 12), key.Length, indent);
        if (decryptLoopIndex < 0)
            return false;

        var decryptLoopEnd = FindLuaBlockEnd(lines, decryptLoopIndex);
        if (decryptLoopEnd < 0)
            return false;

        var resultIndex = FindResultAssignment(lines, decryptLoopEnd + 1, Math.Min(lines.Count, decryptLoopEnd + 8), accumulatorVar, out var resultVar);
        if (resultIndex < 0)
            return false;

        var plaintext = Decrypt(encrypted, key);
        replacement = indent + resultVar + " = " + QuoteLuaString(plaintext);
        nextIndex = SkipInlinedTail(lines, resultIndex + 1);
        return true;
    }

    private static int FindEmptyAccumulator(IReadOnlyList<string> lines, int start, int end)
    {
        for (var i = start; i < end; i++)
        {
            var match = AssignmentStringRegex().Match(lines[i]);
            if (match.Success && match.Groups["literal"].Value == "\"\"")
                return i;
        }

        return -1;
    }

    private static bool LooksLikeStringTableSetup(IReadOnlyList<string> lines, int accumulatorIndex)
    {
        var end = Math.Min(lines.Count, accumulatorIndex + 18);
        var window = string.Join("\n", lines.Skip(accumulatorIndex).Take(end - accumulatorIndex));
        return window.Contains("= string", StringComparison.Ordinal) &&
               window.Contains("= {}", StringComparison.Ordinal) &&
               window.Contains("for ", StringComparison.Ordinal) &&
               window.Contains("255", StringComparison.Ordinal);
    }

    private static int FindKeyAssignment(IReadOnlyList<string> lines, int start, int end)
    {
        for (var i = start; i < end; i++)
        {
            var match = AssignmentStringRegex().Match(lines[i]);
            if (!match.Success)
                continue;

            var literal = match.Groups["literal"].Value;
            if (literal != "\"\"")
                return i;
        }

        return -1;
    }

    private static int FindDecryptLoop(IReadOnlyList<string> lines, int start, int end, int keyLength, string indent)
    {
        var firstFor = -1;
        for (var i = start; i < end; i++)
        {
            if (!IsForLine(lines[i]) || GetIndent(lines[i]) != indent)
                continue;

            firstFor = firstFor < 0 ? i : firstFor;
            var loopWindow = string.Join("\n", lines.Skip(i).Take(Math.Min(14, lines.Count - i)));
            if (loopWindow.Contains("% " + keyLength.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal) ||
                loopWindow.Contains("%" + keyLength.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
            {
                return i;
            }
        }

        return firstFor;
    }

    private static bool CrossesFunctionBoundary(IReadOnlyList<string> lines, int start, int end)
    {
        for (var i = start; i < end; i++)
        {
            var trimmed = lines[i].TrimStart();
            if (trimmed.StartsWith("function ", StringComparison.Ordinal) ||
                trimmed.StartsWith("local function ", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static int FindLuaBlockEnd(IReadOnlyList<string> lines, int start)
    {
        var depth = 0;
        for (var i = start; i < lines.Count; i++)
        {
            var trimmed = lines[i].Trim();
            if (IsBlockStarter(trimmed))
                depth++;

            if (trimmed == "end")
            {
                depth--;
                if (depth == 0)
                    return i;
            }
        }

        return -1;
    }

    private static int FindResultAssignment(
        IReadOnlyList<string> lines,
        int start,
        int end,
        string accumulatorVar,
        out string resultVar)
    {
        resultVar = string.Empty;
        for (var i = start; i < end; i++)
        {
            var match = AssignmentIdentifierRegex().Match(lines[i]);
            if (!match.Success)
                continue;

            if (match.Groups["value"].Value != accumulatorVar)
                continue;

            resultVar = match.Groups["var"].Value;
            return i;
        }

        return -1;
    }

    private static bool IsForLine(string line) => line.TrimStart().StartsWith("for ", StringComparison.Ordinal);

    private static string GetIndent(string line)
    {
        var count = 0;
        while (count < line.Length && char.IsWhiteSpace(line[count]))
            count++;
        return line[..count];
    }

    private static int SkipInlinedTail(IReadOnlyList<string> lines, int start)
    {
        var end = Math.Min(lines.Count, start + 6);
        for (var i = start; i + 1 < end; i++)
        {
            var gotoMatch = GotoRegex().Match(lines[i]);
            if (!gotoMatch.Success)
                continue;

            var label = gotoMatch.Groups["label"].Value;
            if (!IsLabel(lines[i + 1], label))
                continue;

            for (var j = start; j < i; j++)
            {
                if (!AssignmentIdentifierRegex().IsMatch(lines[j]))
                    return start;
            }

            return i + 2;
        }

        return start;
    }

    private static bool IsBlockStarter(string trimmed)
    {
        if (trimmed.StartsWith("for ", StringComparison.Ordinal) && trimmed.EndsWith(" do", StringComparison.Ordinal))
            return true;

        if (trimmed.StartsWith("while ", StringComparison.Ordinal) && trimmed.EndsWith(" do", StringComparison.Ordinal))
            return true;

        return trimmed.StartsWith("if ", StringComparison.Ordinal) && trimmed.EndsWith(" then", StringComparison.Ordinal);
    }

    private static string Decrypt(string encrypted, string key)
    {
        var encryptedBytes = LuaEncoding.GetBytes(encrypted);
        var keyBytes = LuaEncoding.GetBytes(key);
        var output = new byte[encryptedBytes.Length];
        for (var i = 0; i < encryptedBytes.Length; i++)
            output[i] = (byte)(encryptedBytes[i] ^ keyBytes[i % keyBytes.Length]);

        return LuaEncoding.GetString(output);
    }

    private static string UnescapeLuaString(string literal)
    {
        var bytes = new List<byte>();
        for (var i = 1; i < literal.Length - 1;)
        {
            var current = literal[i++];
            if (current != '\\')
            {
                bytes.Add((byte)current);
                continue;
            }

            if (i >= literal.Length - 1)
                break;

            var next = literal[i++];
            switch (next)
            {
                case 'a':
                    bytes.Add((byte)'\a');
                    break;
                case 'b':
                    bytes.Add((byte)'\b');
                    break;
                case 'f':
                    bytes.Add((byte)'\f');
                    break;
                case 'n':
                    bytes.Add((byte)'\n');
                    break;
                case 'r':
                    bytes.Add((byte)'\r');
                    break;
                case 't':
                    bytes.Add((byte)'\t');
                    break;
                case 'v':
                    bytes.Add((byte)'\v');
                    break;
                default:
                    if (!char.IsDigit(next))
                    {
                        bytes.Add((byte)next);
                        break;
                    }

                    var digits = next.ToString();
                    for (var consumed = 0; consumed < 2 && i < literal.Length - 1 && char.IsDigit(literal[i]); consumed++, i++)
                        digits += literal[i];

                    bytes.Add((byte)int.Parse(digits, CultureInfo.InvariantCulture));
                    break;
            }
        }

        return LuaEncoding.GetString(bytes.ToArray());
    }

    private static string QuoteLuaString(string value)
    {
        var bytes = LuaEncoding.GetBytes(value);
        var sb = new StringBuilder(bytes.Length + 2);
        sb.Append('"');
        foreach (var b in bytes)
        {
            switch (b)
            {
                case (byte)'\\':
                    sb.Append(@"\\");
                    break;
                case (byte)'"':
                    sb.Append("\\\"");
                    break;
                case (byte)'\a':
                    sb.Append(@"\a");
                    break;
                case (byte)'\b':
                    sb.Append(@"\b");
                    break;
                case (byte)'\f':
                    sb.Append(@"\f");
                    break;
                case (byte)'\n':
                    sb.Append(@"\n");
                    break;
                case (byte)'\r':
                    sb.Append(@"\r");
                    break;
                case (byte)'\t':
                    sb.Append(@"\t");
                    break;
                case (byte)'\v':
                    sb.Append(@"\v");
                    break;
                default:
                    if (b is >= 32 and <= 126)
                        sb.Append((char)b);
                    else
                        sb.Append('\\').Append(b.ToString("D3", CultureInfo.InvariantCulture));
                    break;
            }
        }

        sb.Append('"');
        return sb.ToString();
    }

    [GeneratedRegex(@"^(?<indent>\s*)(?:local\s+)?(?<var>[A-Za-z_]\w*)\s*=\s*(?<literal>""(?:\\.|[^""\\])*"")\s*$")]
    private static partial Regex AssignmentStringRegex();

    [GeneratedRegex(@"^(?<indent>\s*)(?:local\s+)?(?<var>[A-Za-z_]\w*)\s*=\s*(?<value>[A-Za-z_]\w*)\s*$")]
    private static partial Regex AssignmentIdentifierRegex();

    [GeneratedRegex(@"^\s*goto\s+(?<label>lbl_\d+)\s*$")]
    private static partial Regex GotoRegex();

    private static bool IsLabel(string line, string label) =>
        string.Equals(line.Trim(), "::" + label + "::", StringComparison.Ordinal);
}
