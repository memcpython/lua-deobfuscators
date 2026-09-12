using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace IronBrew2Deobfuscator;

internal sealed class ExternalDecompiler
{
    private readonly string? _unluacJar;
    private readonly string _javaPath;

    private ExternalDecompiler(string? unluacJar, string javaPath)
    {
        _unluacJar = unluacJar;
        _javaPath = javaPath;
    }

    public static ExternalDecompiler Create()
    {
        var jar = FindUnluacJar();
        var java = Environment.GetEnvironmentVariable("JAVA_EXE");
        if (string.IsNullOrWhiteSpace(java))
            java = "java";

        return new ExternalDecompiler(jar, java);
    }

    public DecompileResult Decompile(string luacPath, string outputPath)
    {
        if (_unluacJar == null)
            return DecompileResult.Failed("unluac.jar was not found. Expected tools\\unluac.jar next to the deobfuscator project.");

        var process = new Process
        {
            StartInfo =
            {
                FileName = _javaPath,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
        };

        process.StartInfo.ArgumentList.Add("-jar");
        process.StartInfo.ArgumentList.Add(_unluacJar);
        process.StartInfo.ArgumentList.Add(luacPath);

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data != null)
                stdout.AppendLine(e.Data);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data != null)
                stderr.AppendLine(e.Data);
        };

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        process.WaitForExit();

        var source = stdout.ToString();
        if (source.Trim().Length == 0)
            return DecompileResult.Failed(stderr.ToString().Trim());

        File.WriteAllText(outputPath, SourcePostProcessor.Process(source), Encoding.GetEncoding(28591));

        if (process.ExitCode != 0)
            return DecompileResult.PartialSuccess(stderr.ToString().Trim());

        return DecompileResult.Success();
    }

    private static string? FindUnluacJar()
    {
        var baseDir = AppContext.BaseDirectory;
        var candidates = new[]
        {
            Path.Combine(baseDir, "tools", "unluac.jar"),
            Path.Combine(baseDir, "..", "..", "..", "tools", "unluac.jar"),
            Path.Combine(baseDir, "..", "..", "..", "..", "tools", "unluac.jar"),
            Path.Combine(Directory.GetCurrentDirectory(), "tools", "unluac.jar")
        };

        foreach (var candidate in candidates)
        {
            var path = Path.GetFullPath(candidate);
            if (File.Exists(path))
                return path;
        }

        return null;
    }
}

internal sealed class DecompileResult
{
    private DecompileResult(bool succeeded, bool partial, string message)
    {
        Succeeded = succeeded;
        Partial = partial;
        Message = message;
    }

    public bool Succeeded { get; }
    public bool Partial { get; }
    public string Message { get; }

    public static DecompileResult Success() => new(true, false, string.Empty);
    public static DecompileResult PartialSuccess(string message) => new(true, true, message);
    public static DecompileResult Failed(string message) => new(false, false, message);
}
