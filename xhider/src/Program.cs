using XHiderDeobfuscator.Core;
using XHiderDeobfuscator.Emit;
using XHiderDeobfuscator.Model;

if (args.Length is < 1 or > 2)
{
    Console.Error.WriteLine("Usage: XHiderDeobfuscator <input.lua> [output.lua]");
    return 2;
}

var inputPath = Path.GetFullPath(args[0]);
var outputPath = args.Length == 2
    ? Path.GetFullPath(args[1])
    : Path.Combine(
        Path.GetDirectoryName(inputPath) ?? Environment.CurrentDirectory,
        $"{Path.GetFileNameWithoutExtension(inputPath)}.xhider.deobf.lua");

try
{
    var source = await File.ReadAllTextAsync(inputPath);
    var wrapper = WrapperAnalyzer.Analyze(source);
    var image = XHiderDecoder.Decode(source, wrapper);
    var handlers = HandlerSemanticAnalyzer.Classify(wrapper);
    if (Environment.GetEnvironmentVariable("XHIDER_TRACE_HANDLERS") == "1")
    {
        var usage = image.Instructions
            .GroupBy(instruction => instruction.Opcode)
            .ToDictionary(group => group.Key, group => group.Count());
        foreach (var handler in wrapper.Handlers.OrderBy(handler => handler.Opcode))
        {
            var semantic = handlers[handler.Opcode];
            Console.WriteLine(
                $"{handler.Opcode:X2} {semantic.Kind,-24} uses={usage.GetValueOrDefault(handler.Opcode),4} " +
                handler.Body);
        }
    }
    if (Environment.GetEnvironmentVariable("XHIDER_TRACE") == "1")
    {
        foreach (var instruction in image.Instructions)
        {
            var semantic = handlers.TryGetValue(instruction.Opcode, out var handler)
                ? handler.Kind
                : SemanticKind.Nop;
            Console.WriteLine(
                $"{instruction.Pc:D4} {instruction.Opcode:X2} {semantic,-24} " +
                $"u16={instruction.Operand16} u24={instruction.Operand24} byte={instruction.OperandByte}");
        }
    }
    var result = LuaSourceEmitter.Emit(image, handlers);

    Directory.CreateDirectory(Path.GetDirectoryName(outputPath) ?? Environment.CurrentDirectory);
    await File.WriteAllTextAsync(outputPath, result.Source);

    Console.WriteLine($"ok: {outputPath}");
    Console.WriteLine($"functions: {image.FunctionEntries.Count}");
    Console.WriteLine($"constants: {image.Constants.Count}");
    Console.WriteLine($"instructions: {image.Instructions.Count}");
    Console.WriteLine($"handlers: {handlers.Count}");
    Console.WriteLine($"unknown: {result.UnknownInstructions}");
    return result.UnknownInstructions == 0 ? 0 : 3;
}
catch (Exception ex)
{
    if (Environment.GetEnvironmentVariable("XHIDER_TRACE") == "1")
    {
        Console.Error.WriteLine(ex);
    }
    else
    {
        Console.Error.WriteLine("This file hasnt been obfuscated using Xhider");
    }
    return 1;
}
