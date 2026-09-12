using System.Globalization;
using System.Text.RegularExpressions;
using XHiderDeobfuscator.Model;

namespace XHiderDeobfuscator.Core;

public static partial class WrapperAnalyzer
{
    public static WrapperAnalysis Analyze(string source)
    {
        var payloadMatch = PayloadRegex().Match(source);
        if (!payloadMatch.Success)
        {
            throw new InvalidDataException("XHD payload was not found.");
        }

        var prefix = source[..payloadMatch.Index];
        var key = FindContainerKey(prefix);
        var suffixLength = Math.Min(700, source.Length - payloadMatch.Index - payloadMatch.Length);
        var suffix = source.Substring(payloadMatch.Index + payloadMatch.Length, suffixLength);
        var decoderMatch = DecoderNameRegex().Match(suffix);
        var trimMatch = TrimRegex().Match(suffix);
        if (!decoderMatch.Success || !trimMatch.Success)
        {
            throw new InvalidDataException("XHider string container metadata was not found.");
        }

        var normalized = Regex.Replace(source, @"\s+", " ");
        var runtime = RuntimeRegex().Match(normalized);
        if (!runtime.Success)
        {
            throw new InvalidDataException("XHider VM runtime was not recognized.");
        }

        var roles = new WrapperRoles(
            runtime.Groups["pc"].Value,
            runtime.Groups["args"].Value,
            runtime.Groups["globals"].Value,
            runtime.Groups["parent"].Value,
            runtime.Groups["env"].Value,
            runtime.Groups["stack"].Value,
            runtime.Groups["top"].Value,
            runtime.Groups["pos"].Value,
            runtime.Groups["base"].Value,
            runtime.Groups["opcode"].Value,
            runtime.Groups["bytes"].Value,
            runtime.Groups["flag"].Value);

        var handlerPattern =
            $@"while {Regex.Escape(roles.Opcode)}==0x(?<opcode>[0-9A-Fa-f]+) do" +
            $@"(?<body>.*?)(?=while {Regex.Escape(roles.Opcode)}==0x|if {Regex.Escape(roles.DispatchFlag)} then)";
        var handlers = Regex.Matches(normalized[runtime.Index..], handlerPattern, RegexOptions.Singleline)
            .Select(match => new HandlerSource(
                byte.Parse(match.Groups["opcode"].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture),
                Canonicalize(match.Groups["body"].Value, roles)))
            .ToArray();

        if (handlers.Length == 0)
        {
            throw new InvalidDataException("XHider opcode handlers were not found.");
        }

        return new WrapperAnalysis(
            key,
            ParseHex(trimMatch.Groups["trim"].Value),
            decoderMatch.Groups["name"].Value,
            roles,
            handlers);
    }

    private static byte[] FindContainerKey(string prefix)
    {
        foreach (Match match in LocalTableRegex().Matches(prefix))
        {
            var values = HexRegex().Matches(match.Groups["body"].Value)
                .Select(value => ParseHex(value.Groups["hex"].Value))
                .ToArray();
            if (values.Length == 4 && values.All(value => value is >= 0 and <= 255))
            {
                return values.Select(value => (byte)value).ToArray();
            }
        }

        throw new InvalidDataException("XHider container key was not found.");
    }

    private static string Canonicalize(string body, WrapperRoles roles)
    {
        var replacements = new Dictionary<string, string>
        {
            [roles.ProgramCounter] = "$pc",
            [roles.Arguments] = "$args",
            [roles.Globals] = "$globals",
            [roles.ParentEnvironment] = "$parent",
            [roles.Environment] = "$env",
            [roles.Stack] = "$stack",
            [roles.StackTop] = "$top",
            [roles.Position] = "$pos",
            [roles.InstructionBase] = "$base",
            [roles.Opcode] = "$opcode",
            [roles.Bytes] = "$bytes",
            [roles.DispatchFlag] = "$flag"
        };

        foreach (var replacement in replacements.OrderByDescending(pair => pair.Key.Length))
        {
            body = Regex.Replace(
                body,
                $@"\b{Regex.Escape(replacement.Key)}\b",
                _ => replacement.Value);
        }

        body = Regex.Replace(body, @"\s+", string.Empty);
        const string tail =
            "$pc=$pc+0x1$pos=$base+($pc-0x1)*0x4$opcode=$bytes[$pos]$flag=falseend";
        return body.EndsWith(tail, StringComparison.Ordinal)
            ? body[..^tail.Length]
            : body;
    }

    private static int ParseHex(string value) =>
        int.Parse(value, NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    [GeneratedRegex(@"\[(?<equals>=*)\[XHD:(?<payload>.*?)\]\k<equals>\]", RegexOptions.Singleline)]
    private static partial Regex PayloadRegex();

    [GeneratedRegex(@"local\s+\w+\s*=\s*\{(?<body>[^{}]+)\}")]
    private static partial Regex LocalTableRegex();

    [GeneratedRegex(@"0x(?<hex>[0-9A-Fa-f]+)")]
    private static partial Regex HexRegex();

    [GeneratedRegex(@"function\s+(?<name>\w+)\(\w+\)")]
    private static partial Regex DecoderNameRegex();

    [GeneratedRegex(@"string\.sub\(\w+\s*,\s*0x5\s*\)\s*,\s*0x(?<trim>[0-9A-Fa-f]+)", RegexOptions.IgnoreCase)]
    private static partial Regex TrimRegex();

    [GeneratedRegex(
        @"=function\((?<pc>\w+),(?<args>\w+),(?<globals>\w+),(?<parent>\w+)\)" +
        @"local (?<env>\w+)=\{\[0x0\]=\k<parent>\}" +
        @"local (?<stack>\w+)=\{\}local (?<top>\w+)=0x0 local [\w,]+ " +
        @"(?<pos>\w+)=(?<base>\w+)\+\(\k<pc>-0x1\)\*0x4 " +
        @"(?<opcode>\w+)=(?<bytes>\w+)\[\k<pos>\]while true do (?<flag>\w+)=true")]
    private static partial Regex RuntimeRegex();
}
