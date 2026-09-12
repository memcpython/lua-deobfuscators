using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace IronBrew2Deobfuscator;

internal static class PayloadExtractor
{
    private static readonly Regex StringLiteralRegex = new(
        @"(?<quote>['""])(?<value>(?:\\.|(?!\k<quote>).)*?)\k<quote>",
        RegexOptions.Compiled | RegexOptions.Singleline);

    public static IReadOnlyList<PayloadCandidate> Extract(string source)
    {
        var results = new List<PayloadCandidate>();
        var seen = new HashSet<string>();

        foreach (Match match in StringLiteralRegex.Matches(source).Cast<Match>().OrderByDescending(m => m.Groups["value"].Length))
        {
            var rawLiteral = match.Groups["value"].Value;
            if (rawLiteral.Length < 32 || !seen.Add(rawLiteral))
                continue;

            var decodedLiteral = DecodeLuaStringEscapes(rawLiteral);

            if (LooksLikeCompressed(decodedLiteral))
            {
                try
                {
                    results.Add(new PayloadCandidate
                    {
                        Description = $"LZW/base36 string at offset {match.Index}",
                        Bytes = DecompressBase36Lzw(decodedLiteral)
                    });
                }
                catch
                {
                    // Not every base36-looking string is the VM payload.
                }
            }

            foreach (var shiftOffset in ShiftedBase36Offsets(decodedLiteral))
            {
                try
                {
                    results.Add(new PayloadCandidate
                    {
                        Description = $"shifted LZW/base36 string at offset {match.Index}, shift={shiftOffset}",
                        Bytes = DecompressShiftedBase36Lzw(decodedLiteral, shiftOffset)
                    });
                }
                catch
                {
                    // 25ms-style wrappers share the same string-literal surface as ordinary data.
                }
            }

            if (LooksLikeDecimalEscapedByteString(rawLiteral))
            {
                try
                {
                    results.Add(new PayloadCandidate
                    {
                        Description = $"decimal-escaped byte string at offset {match.Index}",
                        Bytes = DecodeDecimalEscapes(rawLiteral)
                    });
                }
                catch
                {
                    // Keep scanning for other payload candidates.
                }
            }
        }

        return results
            .GroupBy(r => Convert.ToBase64String(r.Bytes))
            .Select(g => g.First())
            .OrderByDescending(r => r.Bytes.Length)
            .ToList();
    }

    private static bool LooksLikeCompressed(string value)
    {
        if (value.Length < 100)
            return false;

        var alphaNumeric = 0;
        foreach (var ch in value)
        {
            if ((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z'))
                alphaNumeric++;
            else
                return false;
        }

        return alphaNumeric == value.Length;
    }

    private static IReadOnlyList<int> ShiftedBase36Offsets(string value)
    {
        if (value.Length < 100)
            return Array.Empty<int>();

        var sampleLength = Math.Min(value.Length, 256);
        var offsets = new List<(int Offset, int Score)>();
        for (var offset = -64; offset <= 64; offset++)
        {
            if (offset == 0)
                continue;

            var shiftedDigits = 0;
            foreach (var ch in value.Take(sampleLength))
            {
                var shifted = ch + offset;
                if (shifted is >= char.MinValue and <= char.MaxValue && IsBase36((char)shifted))
                    shiftedDigits++;
            }

            if (shiftedDigits >= Math.Min(sampleLength, 100))
                offsets.Add((offset, shiftedDigits));
        }

        return offsets
            .OrderByDescending(o => o.Score)
            .ThenBy(o => Math.Abs(o.Offset))
            .Select(o => o.Offset)
            .Take(32)
            .ToArray();
    }

    private static string DecodeLuaStringEscapes(string value)
    {
        var result = new StringBuilder(value.Length);
        for (var i = 0; i < value.Length; i++)
        {
            if (value[i] != '\\')
            {
                result.Append(value[i]);
                continue;
            }

            if (i + 1 >= value.Length)
            {
                result.Append('\\');
                break;
            }

            var next = value[++i];
            if (char.IsDigit(next))
            {
                var digits = next.ToString();
                while (i + 1 < value.Length && digits.Length < 3 && char.IsDigit(value[i + 1]))
                    digits += value[++i];

                result.Append((char)int.Parse(digits));
                continue;
            }

            result.Append(next switch
            {
                'a' => (char)7,
                'b' => (char)8,
                'f' => (char)12,
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'v' => (char)11,
                '\r' => '\n',
                '\n' => '\n',
                _ => next
            });
        }

        return result.ToString();
    }

    private static bool LooksLikeDecimalEscapedByteString(string value)
    {
        if (value.Length < 32)
            return false;

        var escapes = 0;
        for (var i = 0; i < value.Length - 1; i++)
        {
            if (value[i] == '\\' && char.IsDigit(value[i + 1]))
                escapes++;
        }

        return escapes >= 16;
    }

    private static byte[] DecodeDecimalEscapes(string value)
    {
        var bytes = new List<byte>(value.Length / 2);
        for (var i = 0; i < value.Length; i++)
        {
            if (value[i] != '\\')
            {
                bytes.Add((byte)value[i]);
                continue;
            }

            if (i + 1 >= value.Length)
                throw new FormatException("Dangling escape at end of Lua string.");

            if (!char.IsDigit(value[i + 1]))
            {
                bytes.Add(value[i + 1] switch
                {
                    'a' => 7,
                    'b' => 8,
                    'f' => 12,
                    'n' => 10,
                    'r' => 13,
                    't' => 9,
                    'v' => 11,
                    '\\' => (byte)'\\',
                    '"' => (byte)'"',
                    '\'' => (byte)'\'',
                    _ => (byte)value[i + 1]
                });
                i++;
                continue;
            }

            var start = i + 1;
            var end = start;
            while (end < value.Length && end - start < 3 && char.IsDigit(value[end]))
                end++;

            var number = int.Parse(value[start..end]);
            if (number is < 0 or > 255)
                throw new FormatException($"Invalid decimal byte escape: {number}");

            bytes.Add((byte)number);
            i = end - 1;
        }

        return bytes.ToArray();
    }

    private static byte[] DecompressBase36Lzw(string input)
    {
        return DecompressLzw(input, static (value, position) =>
        {
            if (position >= value.Length)
                throw new FormatException("Unexpected end of compressed stream.");

            var length = ParseBase36(value[position].ToString());
            position++;
            if (length <= 0 || position + length > value.Length)
                throw new FormatException("Invalid compressed code length.");

            var code = ParseBase36(value.Substring(position, length));
            position += length;
            return (code, position);
        });
    }

    private static byte[] DecompressShiftedBase36Lzw(string input, int shiftOffset)
    {
        return DecompressLzw(input, (value, position) =>
        {
            if (position >= value.Length)
                throw new FormatException("Unexpected end of compressed stream.");

            var length = ParseShiftedBase36(value[position].ToString(), shiftOffset);
            position++;
            if (length <= 0 || position + length > value.Length)
                throw new FormatException("Invalid shifted compressed code length.");

            var code = ParseShiftedBase36(value.Substring(position, length), shiftOffset);
            position += length;
            return (code, position);
        });
    }

    private static byte[] DecompressLzw(string input, Func<string, int, (int Code, int NextPosition)> readCode)
    {
        var dictionary = new Dictionary<int, string>();
        for (var i = 0; i < 256; i++)
            dictionary[i] = ((char)i).ToString();

        var position = 0;
        var firstRead = readCode(input, position);
        position = firstRead.NextPosition;
        var first = firstRead.Code;
        var previous = ((char)first).ToString();
        var output = new StringBuilder(previous);
        var nextCode = 256;

        while (position < input.Length)
        {
            var read = readCode(input, position);
            position = read.NextPosition;
            var code = read.Code;
            string entry;
            if (dictionary.TryGetValue(code, out var existing))
                entry = existing;
            else
                entry = previous + previous[0];

            dictionary[nextCode++] = previous + entry[0];
            output.Append(entry);
            previous = entry;
        }

        var bytes = new byte[output.Length];
        for (var i = 0; i < output.Length; i++)
            bytes[i] = (byte)(output[i] & 0xFF);

        return bytes;
    }

    private static int ParseShiftedBase36(string value, int shiftOffset)
    {
        Span<char> shifted = value.Length <= 64 ? stackalloc char[value.Length] : new char[value.Length];
        for (var i = 0; i < value.Length; i++)
            shifted[i] = (char)(value[i] + shiftOffset);

        return ParseBase36(new string(shifted));
    }

    private static int ParseBase36(string value)
    {
        var result = 0;
        foreach (var ch in value)
        {
            var digit = ch switch
            {
                >= '0' and <= '9' => ch - '0',
                >= 'A' and <= 'Z' => ch - 'A' + 10,
                >= 'a' and <= 'z' => ch - 'a' + 10,
                _ => throw new FormatException($"Invalid base36 digit: {ch}")
            };

            result = checked(result * 36 + digit);
        }

        return result;
    }

    private static bool IsBase36(char ch) =>
        ch is >= '0' and <= '9' or >= 'A' and <= 'Z' or >= 'a' and <= 'z';
}
