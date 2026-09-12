using System.Diagnostics;
using System.Text;

namespace HerculesDeobfuscator.Emit;

public static class UnluacDecompiler
{
    public static async Task<string> DecompileAsync(byte[] bytecode)
    {
        var jar = FindJar();
        var directory = Path.Combine(
            Path.GetTempPath(),
            $"hercules_deobf_{Environment.ProcessId}_{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        var input = Path.Combine(directory, "payload.luac");

        try
        {
            await File.WriteAllBytesAsync(input, bytecode);
            using var process = new Process
            {
                StartInfo =
                {
                    FileName = Environment.GetEnvironmentVariable("JAVA_EXE") ?? "java",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                }
            };
            process.StartInfo.ArgumentList.Add("-jar");
            process.StartInfo.ArgumentList.Add(jar);
            process.StartInfo.ArgumentList.Add("--nodebug");
            process.StartInfo.ArgumentList.Add(input);

            process.Start();
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
            await process.WaitForExitAsync(timeout.Token);
            var source = await stdout;
            var error = await stderr;
            if (process.ExitCode != 0 || string.IsNullOrWhiteSpace(source))
            {
                throw new InvalidDataException(
                    string.IsNullOrWhiteSpace(error)
                        ? "Hercules bytecode decompilation failed."
                        : error.Trim());
            }
            return source;
        }
        finally
        {
            try
            {
                Directory.Delete(directory, true);
            }
            catch
            {
            }
        }
    }

    private static string FindJar()
    {
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "tools", "unluac.jar"),
            Path.Combine(AppContext.BaseDirectory, "unluac.jar"),
            Path.Combine(Directory.GetCurrentDirectory(), "tools", "unluac.jar"),
            Path.Combine(Directory.GetCurrentDirectory(), "src", "tools", "unluac.jar")
        };
        return candidates
            .Select(Path.GetFullPath)
            .FirstOrDefault(File.Exists)
            ?? throw new FileNotFoundException("unluac.jar was not found.");
    }
}
