using HerculesDeobfuscator.Model;

namespace HerculesDeobfuscator.Core;

public static class HerculesPayloadExtractor
{
    public static HerculesPayload Extract(string source)
    {
        if (!source.Contains("Hercules", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Hercules marker was not found.");
        }

        var literals = LuaStringScanner.Scan(source);
        foreach (var charsetLiteral in literals
                     .Where(literal => IsCharset(literal.Value))
                     .OrderByDescending(literal => literal.Start))
        {
            var charset = charsetLiteral.Value;
            var alphabet = charset.ToHashSet();
            var payload = literals
                .Where(literal =>
                    literal.End <= charsetLiteral.Start &&
                    literal.Value.Length > 256 &&
                    literal.Value.All(value => value == (byte)'_' || alphabet.Contains(value)))
                .OrderByDescending(literal => literal.End)
                .FirstOrDefault();
            if (payload is not null)
            {
                return new HerculesPayload(payload.Value, charset);
            }
        }

        throw new InvalidDataException("Hercules bytecode payload was not found.");
    }

    private static bool IsCharset(byte[] value)
    {
        if (value.Length != 94 || value.Distinct().Count() != 94)
        {
            return false;
        }
        var sorted = value.Order().ToArray();
        return sorted.Select((item, index) => item == index + 1).All(match => match);
    }
}
