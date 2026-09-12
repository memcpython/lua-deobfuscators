using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace IronBrew2Deobfuscator;

internal enum LuaTokenKind
{
    Identifier,
    Number,
    String,
    Symbol,
    Keyword,
    Eof
}

internal readonly record struct LuaToken(LuaTokenKind Kind, string Text, int Start, int End);

internal static class LuaTokenizer
{
    private static readonly HashSet<string> Keywords = new(StringComparer.Ordinal)
    {
        "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if",
        "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"
    };

    public static List<LuaToken> Tokenize(string source)
    {
        var tokens = new List<LuaToken>();
        var i = 0;

        while (i < source.Length)
        {
            var ch = source[i];

            if (char.IsWhiteSpace(ch))
            {
                i++;
                continue;
            }

            if (ch == '-' && i + 1 < source.Length && source[i + 1] == '-')
            {
                i = SkipComment(source, i + 2);
                continue;
            }

            if (ch is '\'' or '"')
            {
                tokens.Add(ReadQuotedString(source, ref i));
                continue;
            }

            if (ch == '[' && TryReadLongBracket(source, i, out var longToken, out var longEnd))
            {
                tokens.Add(new LuaToken(LuaTokenKind.String, longToken, i, longEnd));
                i = longEnd;
                continue;
            }

            if (IsIdentStart(ch))
            {
                var start = i++;
                while (i < source.Length && IsIdentPart(source[i]))
                    i++;

                var text = source[start..i];
                tokens.Add(new LuaToken(Keywords.Contains(text) ? LuaTokenKind.Keyword : LuaTokenKind.Identifier, text, start, i));
                continue;
            }

            if (char.IsDigit(ch))
            {
                tokens.Add(ReadNumber(source, ref i));
                continue;
            }

            var two = i + 1 < source.Length ? source.Substring(i, 2) : string.Empty;
            if (two is "==" or "~=" or "<=" or ">=" or "..")
            {
                tokens.Add(new LuaToken(LuaTokenKind.Symbol, two, i, i + 2));
                i += 2;
                continue;
            }

            tokens.Add(new LuaToken(LuaTokenKind.Symbol, ch.ToString(), i, i + 1));
            i++;
        }

        tokens.Add(new LuaToken(LuaTokenKind.Eof, string.Empty, source.Length, source.Length));
        return tokens;
    }

    public static string Canonicalize(string source)
    {
        var tokens = Tokenize(source);
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        var parts = new List<string>();
        var nextName = 0;

        string NewName() => "v" + (nextName++).ToString(CultureInfo.InvariantCulture);
        string GetName(string text)
        {
            if (!names.TryGetValue(text, out var name))
            {
                name = NewName();
                names[text] = name;
            }

            return name;
        }

        for (var i = 0; i < tokens.Count;)
        {
            var token = tokens[i];
            if (token.Kind == LuaTokenKind.Eof || token.Text == ";")
            {
                i++;
                continue;
            }

            if (token.IsText("local"))
            {
                i = CanonicalizeLocal(tokens, i, names, parts, NewName, GetName);
                continue;
            }

            if (token.IsText("for") && i + 2 < tokens.Count && tokens[i + 1].Kind == LuaTokenKind.Identifier)
            {
                i = CanonicalizeFor(tokens, i, names, parts, NewName, GetName);
                continue;
            }

            AddCanonicalToken(token, parts, GetName);
            i++;
        }

        return string.Join("|", parts);
    }

    private static int CanonicalizeLocal(
        IReadOnlyList<LuaToken> tokens,
        int localIndex,
        Dictionary<string, string> names,
        List<string> parts,
        Func<string> newName,
        Func<string, string> getName)
    {
        var pending = new List<(string Source, string Canonical)>();
        var i = localIndex + 1;

        while (i < tokens.Count && tokens[i].Kind == LuaTokenKind.Identifier)
        {
            var canonical = newName();
            pending.Add((tokens[i].Text, canonical));
            parts.Add(canonical);
            i++;

            if (i < tokens.Count && tokens[i].IsText(","))
            {
                parts.Add(",");
                i++;
                continue;
            }

            break;
        }

        if (i < tokens.Count && tokens[i].IsText("="))
        {
            parts.Add("=");
            i++;
            var exprEnd = FindLocalInitializerEnd(tokens, i);
            while (i < exprEnd)
            {
                AddCanonicalToken(tokens[i], parts, getName);
                i++;
            }
        }

        foreach (var (source, canonical) in pending)
            names[source] = canonical;

        return i;
    }

    private static int CanonicalizeFor(
        IReadOnlyList<LuaToken> tokens,
        int forIndex,
        Dictionary<string, string> names,
        List<string> parts,
        Func<string> newName,
        Func<string, string> getName)
    {
        parts.Add("for");
        var pending = new List<(string Source, string Canonical)>();
        var i = forIndex + 1;

        while (i < tokens.Count && tokens[i].Kind == LuaTokenKind.Identifier)
        {
            var canonical = newName();
            pending.Add((tokens[i].Text, canonical));
            parts.Add(canonical);
            i++;

            if (i < tokens.Count && tokens[i].IsText(","))
            {
                parts.Add(",");
                i++;
                continue;
            }

            break;
        }

        while (i < tokens.Count && !tokens[i].IsText("do"))
        {
            AddCanonicalToken(tokens[i], parts, getName);
            i++;
        }

        foreach (var (source, canonical) in pending)
            names[source] = canonical;

        if (i < tokens.Count && tokens[i].IsText("do"))
        {
            parts.Add("do");
            i++;
        }

        return i;
    }

    private static int FindLocalInitializerEnd(IReadOnlyList<LuaToken> tokens, int start)
    {
        var depth = 0;
        for (var i = start; i < tokens.Count; i++)
        {
            var token = tokens[i];
            if (token.Kind == LuaTokenKind.Eof || token.IsText(";"))
                return i;

            if (depth == 0 && i > start && IsStatementBoundary(tokens[i - 1], token))
                return i;

            if (token.IsText("(") || token.IsText("[") || token.IsText("{"))
                depth++;
            else if (token.IsText(")") || token.IsText("]") || token.IsText("}"))
                depth = Math.Max(0, depth - 1);
        }

        return tokens.Count - 1;
    }

    private static bool IsStatementBoundary(LuaToken previous, LuaToken current)
    {
        if (!IsExpressionTerminator(previous))
            return false;

        if (current.Kind == LuaTokenKind.Identifier)
            return true;

        return current.Text is "local" or "if" or "for" or "while" or "do" or "return" or "break";
    }

    private static bool IsExpressionTerminator(LuaToken token) =>
        token.Kind is LuaTokenKind.Identifier or LuaTokenKind.Number or LuaTokenKind.String ||
        token.Text is "]" or ")" or "}" or "true" or "false" or "nil";

    private static void AddCanonicalToken(LuaToken token, List<string> parts, Func<string, string> getName)
    {
        if (token.Kind == LuaTokenKind.Eof || token.Text == ";")
            return;

        if (token.Kind == LuaTokenKind.Identifier)
        {
            parts.Add(getName(token.Text));
            return;
        }

        if (token.Kind == LuaTokenKind.Number &&
            int.TryParse(token.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
        {
            parts.Add(n.ToString(CultureInfo.InvariantCulture));
            return;
        }

        if (token.Kind == LuaTokenKind.String)
        {
            parts.Add("str");
            return;
        }

        parts.Add(token.Text);
    }

    private static int SkipComment(string source, int i)
    {
        if (i < source.Length && source[i] == '[' && TryReadLongBracket(source, i, out _, out var end))
            return end;

        while (i < source.Length && source[i] is not '\r' and not '\n')
            i++;
        return i;
    }

    private static LuaToken ReadQuotedString(string source, ref int i)
    {
        var quote = source[i];
        var start = i++;
        while (i < source.Length)
        {
            if (source[i] == '\\')
            {
                i = Math.Min(source.Length, i + 2);
                continue;
            }

            if (source[i] == quote)
            {
                i++;
                break;
            }

            i++;
        }

        return new LuaToken(LuaTokenKind.String, source[start..i], start, i);
    }

    private static LuaToken ReadNumber(string source, ref int i)
    {
        var start = i++;
        while (i < source.Length)
        {
            var ch = source[i];
            if (char.IsLetterOrDigit(ch) || ch is '.' or '_')
            {
                i++;
                continue;
            }

            if ((ch == '+' || ch == '-') && i > start && (source[i - 1] == 'e' || source[i - 1] == 'E'))
            {
                i++;
                continue;
            }

            break;
        }

        return new LuaToken(LuaTokenKind.Number, source[start..i], start, i);
    }

    private static bool TryReadLongBracket(string source, int start, out string text, out int end)
    {
        text = string.Empty;
        end = start;
        if (source[start] != '[')
            return false;

        var i = start + 1;
        while (i < source.Length && source[i] == '=')
            i++;

        if (i >= source.Length || source[i] != '[')
            return false;

        var equals = i - start - 1;
        var close = "]" + new string('=', equals) + "]";
        var closeIndex = source.IndexOf(close, i + 1, StringComparison.Ordinal);
        if (closeIndex < 0)
            return false;

        end = closeIndex + close.Length;
        text = source[start..end];
        return true;
    }

    private static bool IsIdentStart(char ch) => char.IsLetter(ch) || ch == '_';
    private static bool IsIdentPart(char ch) => char.IsLetterOrDigit(ch) || ch == '_';
}

internal static class LuaTokenExtensions
{
    public static bool IsText(this LuaToken token, string text) => string.Equals(token.Text, text, StringComparison.Ordinal);

    public static int PreviousSignificant(this IReadOnlyList<LuaToken> tokens, int index)
    {
        for (var i = index - 1; i >= 0; i--)
        {
            if (tokens[i].Kind != LuaTokenKind.Eof)
                return i;
        }

        return -1;
    }

    public static string SliceSource(this IReadOnlyList<LuaToken> tokens, string source, int startToken, int endTokenExclusive)
    {
        while (startToken < endTokenExclusive && tokens[startToken].Text == ";")
            startToken++;
        while (endTokenExclusive > startToken && tokens[endTokenExclusive - 1].Text == ";")
            endTokenExclusive--;

        if (startToken >= endTokenExclusive)
            return string.Empty;

        var start = tokens[startToken].Start;
        var end = tokens[endTokenExclusive - 1].End;
        return source[start..end].Trim();
    }
}
