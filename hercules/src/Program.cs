using HerculesDeobfuscator.Core;
using HerculesDeobfuscator.Emit;
using HerculesDeobfuscator.Model;

if (args.Length is < 1 or > 2)
{
    Console.Error.WriteLine("Usage: HerculesDeobfuscator <input.lua> [output.lua]");
    return 2;
}

var inputPath = Path.GetFullPath(args[0]);
var outputPath = args.Length == 2
    ? Path.GetFullPath(args[1])
    : Path.Combine(
        Path.GetDirectoryName(inputPath) ?? Environment.CurrentDirectory,
        $"{Path.GetFileNameWithoutExtension(inputPath)}.hercules.deobf.lua");

try
{
    var source = await File.ReadAllTextAsync(inputPath);
    var payload = HerculesPayloadExtractor.Extract(source);
    var chunk = HerculesDecoder.Decode(payload);
    var bytecode = Lua51ChunkWriter.Write(chunk, $"@{Path.GetFileName(inputPath)}");
    var dumpPath = Environment.GetEnvironmentVariable("HERCULES_DUMP_BYTECODE");
    if (!string.IsNullOrWhiteSpace(dumpPath))
    {
        await File.WriteAllBytesAsync(Path.GetFullPath(dumpPath), bytecode);
    }
    var recovered = await UnluacDecompiler.DecompileAsync(bytecode);
    var output = SourcePostProcessor.Process(recovered);

    Directory.CreateDirectory(Path.GetDirectoryName(outputPath) ?? Environment.CurrentDirectory);
    await File.WriteAllTextAsync(outputPath, output);

    var statistics = HerculesStatistics.From(chunk);
    Console.WriteLine($"ok: {outputPath}");
    Console.WriteLine($"functions: {statistics.Functions}");
    Console.WriteLine($"constants: {statistics.Constants}");
    Console.WriteLine($"instructions: {statistics.Instructions}");
    return 0;
}
catch (Exception ex)
{
    if (Environment.GetEnvironmentVariable("HERCULES_TRACE") == "1")
    {
        Console.Error.WriteLine(ex);
    }
    else
    {
        Console.Error.WriteLine("This file hasnt been obfuscated using Hercules");
    }
    return 1;
}
