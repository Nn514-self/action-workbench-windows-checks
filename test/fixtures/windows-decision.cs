// Test-only console program for the adapter's native process contract. Not a model or a Codex distribution.
using System;
using System.IO;
using System.Text;
using System.Threading;

class DecisionFixture {
    static string Value(string[] args, string option) {
        int i = Array.IndexOf(args, option);
        return i < 0 || i+1 >= args.Length ? null : args[i+1];
    }
    static int Main(string[] args) {
        var utf8 = new UTF8Encoding(false, true);
        string output = Value(args, "-o"), schema = Value(args, "--output-schema");
        if (output == null || !File.Exists(schema) || Value(args, "-m") != "验收 模型") return 2;
        string turn;
        using (var input = new StreamReader(Console.OpenStandardInput(), utf8)) turn = input.ReadToEnd();
        if (turn.Contains("记录参数")) {
            string home = Environment.GetEnvironmentVariable("CODEX_HOME");
            File.WriteAllText(Path.Combine(home, "adapter-argv"), String.Join("\0", args), utf8);
        }
        if (turn.Contains("等待取消")) {
            var home = Environment.GetEnvironmentVariable("CODEX_HOME");
            var marker = Path.Combine(home, "started");
            File.WriteAllText(marker+".tmp", Environment.CurrentDirectory, utf8);
            File.Move(marker+".tmp", marker);
            Thread.Sleep(60000);
            return 3;
        }
        if (!turn.Contains("查询运费")) return 4;
        File.WriteAllText(output, "{\"type\":\"reply\",\"text\":\"运费八元\"}", utf8);
        return 0;
    }
}
