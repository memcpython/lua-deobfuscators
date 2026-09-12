using System;
using System.Text.RegularExpressions;

namespace IronBrew2Deobfuscator;

internal static partial class SourcePostProcessor
{
    public static string Process(string source)
    {
        source = IronBrewStringDecrypter.Process(source);
        source = OpenCallReducer.Process(source);
        source = LuaSourceSimplifier.Process(source);
        source = LuaGotoRepair.Process(source);
        source = StripHugeLocalHeaders(source);
        source = CollapseExtraBlankLines(source);
        return source.TrimEnd() + Environment.NewLine;
    }

    private static string StripHugeLocalHeaders(string source)
    {
        return HugeRegisterHeaderRegex().Replace(source, match =>
        {
            var line = match.Value;
            var commaCount = 0;
            foreach (var ch in line)
                if (ch == ',')
                    commaCount++;

            return commaCount >= 20 ? string.Empty : line;
        });
    }

    private static string CollapseExtraBlankLines(string source) =>
        BlankLineRegex().Replace(source, Environment.NewLine + Environment.NewLine);

    [GeneratedRegex(@"(?m)^\s*local\s+L\d+_\d+(?:,\s*L\d+_\d+){20,}\s*\r?\n")]
    private static partial Regex HugeRegisterHeaderRegex();

    [GeneratedRegex(@"(?:\r?\n){3,}")]
    private static partial Regex BlankLineRegex();
}
