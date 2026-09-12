using System.Globalization;

namespace HerculesDeobfuscator.Core;

internal sealed record LuaStringLiteral(int Start, int End, byte[] Value);

internal static class LuaStringScanner
{
    public static IReadOnlyList<LuaStringLiteral> Scan(string source)
    {
        var literals = new List<LuaStringLiteral>();
        for (var index = 0; index < source.Length; index++)
        {
            var quote = source[index];
            if (quote is not ('\'' or '"'))
            {
                continue;
            }

            if (TryRead(source, index, quote, out var literal))
            {
                literals.Add(literal);
                index = literal.End - 1;
            }
        }
        return literals;
    }

    private static bool TryRead(
        string source,
        int start,
        char quote,
        out LuaStringLiteral literal)
    {
        var bytes = new List<byte>();
        for (var index = start + 1; index < source.Length; index++)
        {
            var current = source[index];
            if (current == quote)
            {
                literal = new LuaStringLiteral(start, index + 1, bytes.ToArray());
                return true;
            }
            if (current != '\\')
            {
                if (current > byte.MaxValue)
                {
                    literal = default!;
                    return false;
                }
                bytes.Add((byte)current);
                continue;
            }

            index++;
            if (index >= source.Length)
            {
                break;
            }
            current = source[index];
            if (char.IsDigit(current))
            {
                var end = index;
                while (end + 1 < source.Length &&
                       end - index < 2 &&
                       char.IsDigit(source[end + 1]))
                {
                    end++;
                }
                var value = int.Parse(
                    source[index..(end + 1)],
                    NumberStyles.None,
                    CultureInfo.InvariantCulture);
                if (value > byte.MaxValue)
                {
                    literal = default!;
                    return false;
                }
                bytes.Add((byte)value);
                index = end;
                continue;
            }

            switch (current)
            {
                case 'a': bytes.Add(7); break;
                case 'b': bytes.Add(8); break;
                case 'f': bytes.Add(12); break;
                case 'n': bytes.Add(10); break;
                case 'r': bytes.Add(13); break;
                case 't': bytes.Add(9); break;
                case 'v': bytes.Add(11); break;
                case '\r':
                    if (index + 1 < source.Length && source[index + 1] == '\n')
                    {
                        index++;
                    }
                    bytes.Add(10);
                    break;
                case '\n':
                    bytes.Add(10);
                    break;
                case 'x' when index + 2 < source.Length &&
                              Uri.IsHexDigit(source[index + 1]) &&
                              Uri.IsHexDigit(source[index + 2]):
                    bytes.Add(byte.Parse(
                        source.Substring(index + 1, 2),
                        NumberStyles.HexNumber,
                        CultureInfo.InvariantCulture));
                    index += 2;
                    break;
                default:
                    if (current > byte.MaxValue)
                    {
                        literal = default!;
                        return false;
                    }
                    bytes.Add((byte)current);
                    break;
            }
        }

        literal = default!;
        return false;
    }
}
