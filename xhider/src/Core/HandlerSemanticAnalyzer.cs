using System.Text.RegularExpressions;
using XHiderDeobfuscator.Model;

namespace XHiderDeobfuscator.Core;

public static class HandlerSemanticAnalyzer
{
    public static IReadOnlyDictionary<byte, HandlerSemantic> Classify(WrapperAnalysis wrapper) =>
        wrapper.Handlers.ToDictionary(handler => handler.Opcode, handler => ClassifyBody(handler.Body));

    private static HandlerSemantic ClassifyBody(string body)
    {
        if (body == "return{}end")
        {
            return New(SemanticKind.ReturnEmpty, body);
        }
        if (body.StartsWith("return$stack[$top]", StringComparison.Ordinal))
        {
            return New(SemanticKind.ReturnTop, body);
        }
        if (Regex.IsMatch(body, @"^\$pc=\w+\(\$pos\+0x1,0x3\)-0x1$"))
        {
            return New(SemanticKind.Jump, body);
        }
        if (body.Contains("if$stack[$top]then$pc=", StringComparison.Ordinal) &&
            body.Contains("$top=$top-0x1", StringComparison.Ordinal))
        {
            return New(SemanticKind.BranchTruePop, body);
        }
        if (body.Contains("$stack[$top-0x2]=$stack[$top-0x2]+$stack[$top]if$stack[$top]<0x0", StringComparison.Ordinal))
        {
            return New(SemanticKind.NumericFor, body);
        }
        if (body.Contains("$top=$top+0x1$stack[$top]=", StringComparison.Ordinal) &&
            body.Contains("ifnot$stack[$top]then", StringComparison.Ordinal) &&
            body.Contains("$bytes[", StringComparison.Ordinal))
        {
            return New(SemanticKind.PushConstant, body);
        }
        if (body.Contains("$top=$top+0x1$stack[$top]=", StringComparison.Ordinal) &&
            Regex.IsMatch(body, @"\[\w+\(\$pos\+0x1,0x3\)\],\$globals,\$env\)"))
        {
            return New(SemanticKind.PushClosure, body);
        }
        if (body.Contains("$stack[$top+0x1]=", StringComparison.Ordinal) &&
            body.Contains("$env", StringComparison.Ordinal) &&
            body.Contains("$bytes[$pos+0x3]", StringComparison.Ordinal))
        {
            return New(SemanticKind.PushEnvironment, body);
        }
        if (body.Contains("$env", StringComparison.Ordinal) &&
            body.Contains("=$stack[$top-0x1][$stack[$top]]", StringComparison.Ordinal))
        {
            return New(SemanticKind.SetEnvironmentIndexed, body);
        }
        if (body.Contains("$env", StringComparison.Ordinal) &&
            body.Contains("=$stack[$top]", StringComparison.Ordinal) &&
            body.Contains("$bytes[$pos+0x3]", StringComparison.Ordinal))
        {
            return New(SemanticKind.SetEnvironment, body);
        }
        if (body == "$env={[0x0]=$env}")
        {
            return New(SemanticKind.EnterEnvironment, body);
        }
        if (body == "$env=$env[0x0]")
        {
            return New(SemanticKind.LeaveEnvironment, body);
        }
        if (body == "$stack[$top]=$globals[$stack[$top]]")
        {
            return New(SemanticKind.GetGlobal, body);
        }
        if (body == "$stack[$top]=$args[$stack[$top]]")
        {
            return New(SemanticKind.GetArgument, body);
        }
        if (Regex.IsMatch(body, @"^\$top=\$top\+0x1\$stack\[\$top\]=\$args\[\w+\(\$pos\+0x1,0x2\)\]$"))
        {
            return New(SemanticKind.PushArgument, body);
        }
        if (body.Contains("$args", StringComparison.Ordinal) &&
            body.Contains("$top=$top+0x1", StringComparison.Ordinal) &&
            body.Contains("else$stack[$top]=$args", StringComparison.Ordinal))
        {
            return New(SemanticKind.PushVarargs, body);
        }
        if (body == "$top=$top+0x1$stack[$top]={}")
        {
            return New(SemanticKind.NewTable, body);
        }
        if (body == "$stack[$top+0x1]=nil$top=$top+0x1")
        {
            return New(SemanticKind.PushNil, body);
        }
        if (Regex.IsMatch(body, @"^\$stack\[\$top\+0x1\]=(true|false)\$top=\$top\+0x1$"))
        {
            return New(SemanticKind.PushBoolean, body);
        }
        if (body == "$stack[$top]=not$stack[$top]")
        {
            return New(SemanticKind.LogicalNot, body);
        }
        if (body == "$stack[$top]=#$stack[$top]")
        {
            return New(SemanticKind.Length, body);
        }
        if (body == "$top=$top-0x1$stack[$top+0x1]=nil")
        {
            return New(SemanticKind.Pop, body);
        }
        if (body.Contains("$stack[$top],$stack[$top-", StringComparison.Ordinal) &&
            body.EndsWith(",$stack[$top]", StringComparison.Ordinal))
        {
            return New(SemanticKind.Swap, body);
        }
        if (body == "$stack[$top+0x1]=$stack[$top]$top=$top+0x1")
        {
            return New(SemanticKind.Duplicate, body);
        }
        if (body == "$stack[$top]=$stack[$top][0x1]")
        {
            return New(SemanticKind.First, body);
        }
        if (body == "$stack[$top]=$stack[$top-0x1][$stack[$top]]")
        {
            return New(SemanticKind.GetTableKeepKey, body);
        }
        if (body.Contains("$top=$top-0x1$stack[$top],$stack[$top+0x1]=$stack[$top][$stack[$top+0x1]],nil", StringComparison.Ordinal))
        {
            return New(SemanticKind.GetTable, body);
        }
        if (body.Contains("$top=$top-0x2$stack[$top][$stack[$top+0x1]]=$stack[$top+0x2]", StringComparison.Ordinal))
        {
            return New(SemanticKind.SetTable, body);
        }
        if (Regex.IsMatch(
                body,
                @"^\$top=\$top-0x1\$stack\[\$top\]\[\w+\(\$pos\+0x1,0x2\)\]=\$stack\[\$top\+0x1\]\$stack\[\$top\+0x1\]=nil$"))
        {
            return New(SemanticKind.SetTableImmediate, body);
        }
        if (body.Contains("for$bytes,$pcinipairs(V)do", StringComparison.Ordinal) &&
            body.Contains("$stack[$top][$bytes+C]=$pc", StringComparison.Ordinal))
        {
            return New(SemanticKind.AppendTableResults, body);
        }
        if (body.Contains("$stack[$top-V][$stack[($top-V)+0x1]]=$stack[$top]", StringComparison.Ordinal) &&
            body.Contains("d($pos+0x1,0x2)", StringComparison.Ordinal))
        {
            return New(SemanticKind.SetTableFromResult, body);
        }
        if (body.Contains("$globals[$stack[$top+0x1]]=$stack[$top+0x2]", StringComparison.Ordinal))
        {
            return New(SemanticKind.SetGlobal, body);
        }
        if (body.Contains("$globals[$stack[$top+0x1]]=$stack[$top]", StringComparison.Ordinal) &&
            body.Contains("d($pos+0x1,0x2)", StringComparison.Ordinal))
        {
            return New(SemanticKind.SetGlobalIndexed, body);
        }
        if (body.Contains("={$stack[$top](", StringComparison.Ordinal) && body.Contains(",nil", StringComparison.Ordinal))
        {
            return New(SemanticKind.Call, body);
        }
        if (body.Contains("inipairs(", StringComparison.Ordinal) &&
            body.Contains("$stack[$top]=", StringComparison.Ordinal) &&
            body.Contains("$top=$top+0x1", StringComparison.Ordinal))
        {
            return New(SemanticKind.ExpandResults, body);
        }
        if (body.Contains("$top=0x0$stack={[0x0]=$stack}", StringComparison.Ordinal))
        {
            return New(SemanticKind.FramePush, body);
        }
        if (body.Contains("]=$top$stack={[0x0]=$stack,[0x1]=$stack[$top]}$top=0x1", StringComparison.Ordinal) ||
            body.Contains("]=$top$stack={[0x0]=$stack;[0x1]=$stack[$top]}$top=0x1", StringComparison.Ordinal))
        {
            return New(SemanticKind.FrameCaptureTop, body);
        }
        if ((body.Contains("$stack={[0x0]=$stack[0x0],[0x1]=", StringComparison.Ordinal) ||
             body.Contains("$stack={[0x0]=$stack[0x0];[0x1]=", StringComparison.Ordinal)) &&
            body.Contains("$top=0x1", StringComparison.Ordinal))
        {
            return New(SemanticKind.FrameClone, body);
        }
        if (body.Contains("$stack={[0x0]=$stack[0x0]}", StringComparison.Ordinal) &&
            body.Contains("$top=0x0", StringComparison.Ordinal))
        {
            return New(SemanticKind.FrameReset, body);
        }
        if (body.StartsWith("$stack=$stack[0x0]$top=$stack[", StringComparison.Ordinal))
        {
            return New(SemanticKind.FrameRestore, body);
        }
        if (body.Contains("if$top>0x0then", StringComparison.Ordinal) &&
            body.Contains("$stack=$stack[0x0]", StringComparison.Ordinal))
        {
            return New(SemanticKind.FrameRestoreKeepTop, body);
        }
        if (body.Contains("C={V[0x1](V[0x2],V[0x3])}", StringComparison.Ordinal) &&
            body.Contains("ifC[0x1]~=nilthen", StringComparison.Ordinal) &&
            body.Contains("$env={[0x0]=$env}", StringComparison.Ordinal))
        {
            return New(SemanticKind.GenericFor, body);
        }

        var binaryOperator = FindBinaryOperator(body);
        if (binaryOperator is not null)
        {
            if (body.StartsWith("$top=$top-0x1$stack[$top],$stack[$top+0x1]=", StringComparison.Ordinal))
            {
                return new HandlerSemantic(SemanticKind.BinaryReplace, binaryOperator, body);
            }
            if (body.Contains("$stack[$top-0x1]=$stack[$top-0x1]", StringComparison.Ordinal))
            {
                return new HandlerSemantic(SemanticKind.BinaryReduce, binaryOperator, body);
            }
            if (body.Contains("$stack[$top-0x2]=$stack[$top-0x2]", StringComparison.Ordinal))
            {
                return new HandlerSemantic(SemanticKind.BinaryTopTwo, binaryOperator, body);
            }
        }

        return New(SemanticKind.Unknown, body);
    }

    private static string? FindBinaryOperator(string body)
    {
        var match = Regex.Match(
            body,
            @"\$stack\[[^\]]+\](?<operator>\.\.|==|~=|<=|>=|[+\-*/%^<>])\$stack\[");
        return match.Success ? match.Groups["operator"].Value : null;
    }

    private static HandlerSemantic New(SemanticKind kind, string body) => new(kind, null, body);
}
