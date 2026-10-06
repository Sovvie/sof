// The Windows tool shim. `sof run tools setup` compiles this once with the C# compiler that ships
// with Windows (.NET Framework's csc.exe, so C# 5 only) and copies the result to
// ~/.sof/bin/<tool>.exe for every tool, the same way Rokit copies itself. It has to be a real .exe:
// editors and other programs start tools without a shell, and Windows only finds .exe files that
// way (not .cmd).
//
// A shim finds the tool it stands for from its own file name, then picks the version in two steps:
//
//  1. Quick path. Walk up from the current folder to the nearest sof.toml that lists the tool under
//     [tools], read the pinned version, and start ~/.sof/tools/<owner>/<repo>/<version>/<repo>.exe
//     directly. This only trusts a plain `name = "owner/repo@version"` line in a plain [tools]
//     table; anything else (an unusual way of writing the table, a tool that isn't installed, the
//     global ~/.sof/tools.toml, an error) takes step 2.
//  2. `node <sof> run tools exec <tool> <arguments>`: sof's own resolver, which handles every case
//     and prints the explanations.
//
// SOF_SHIM_SLOW=1 skips step 1. ~/.sof/bin/sof-shim.cfg (written by sof) holds the node.exe and the
// sof entry point, one per line, for step 2.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;

internal static class SofShim
{
    // TOML names are case-sensitive: [Tools] is another table. (OtherToolsPattern is not, so a
    // header spelled differently sends the lookup to sof, which reads it properly.)
    private static readonly Regex HeaderPattern = new Regex(@"^\s*\[\s*tools\s*\]\s*(#.*)?$");
    private static readonly Regex OtherToolsPattern = new Regex(@"^\s*(\[\[?\s*[""']?tools\b|[""']?tools[""']?\s*[.=])", RegexOptions.IgnoreCase);
    private static readonly Regex AnyHeaderPattern = new Regex(@"^\s*\[");
    // name = "value": the name is quoted, or bare. A bare name has no dot in it, because name.other is
    // a dotted key (a table) to TOML; groups 1-3 are the name, 4-5 the value.
    private static readonly Regex EntryPattern = new Regex(@"^\s*(?:""([^""\\]+)""|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*(?:""([^""\\]*)""|'([^']*)')\s*(#.*)?$");
    private static readonly Regex NamePattern = new Regex(@"^[A-Za-z0-9_][A-Za-z0-9_.-]*$");
    private static readonly Regex VersionPattern = new Regex(@"^[A-Za-z0-9][A-Za-z0-9._+-]*$");
    private static readonly Regex VersionPrefixPattern = new Regex(@"^v(?=\d)", RegexOptions.IgnoreCase);

    private enum Lookup { NotListed, Found, Unsure }

    private static int Fail(string message)
    {
        Console.Error.WriteLine("sof: " + message);
        return 127;
    }

    // Everything after the program name in the raw command line, untouched, so the tool receives
    // exactly the arguments it was started with.
    private static string ArgumentsAfterProgramName()
    {
        string commandLine = Environment.CommandLine;
        int index = 0;
        if (commandLine.Length > 0 && commandLine[0] == '"')
        {
            index = commandLine.IndexOf('"', 1);
            index = index < 0 ? commandLine.Length : index + 1;
        }
        else
        {
            while (index < commandLine.Length && commandLine[index] != ' ' && commandLine[index] != '\t')
            {
                index++;
            }
        }
        return commandLine.Substring(index);
    }

    private static string FindOnPath(string fileName)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string directory in path.Split(Path.PathSeparator))
        {
            try
            {
                // An empty entry would mean "the current folder": never start a program from there.
                string trimmed = directory.Trim().Trim('"');
                if (trimmed.Length == 0 || !Path.IsPathRooted(trimmed))
                {
                    continue;
                }

                string candidate = Path.Combine(trimmed, fileName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch (ArgumentException)
            {
            }
        }
        return null;
    }

    // Looks for `tool` in the [tools] table of one sof.toml. Unsure means the file writes [tools]
    // (or tools) in a way this quick reader doesn't take on trust.
    private static Lookup FindInToolsTable(string text, string tool, out string specifier)
    {
        specifier = null;
        string[] lines = text.Split('\n');

        int header = -1;
        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i].TrimEnd('\r');
            if (HeaderPattern.IsMatch(line))
            {
                if (header != -1)
                {
                    return Lookup.Unsure;
                }
                header = i;
            }
            else if (OtherToolsPattern.IsMatch(line))
            {
                return Lookup.Unsure;
            }
        }

        if (header == -1)
        {
            return Lookup.NotListed;
        }

        bool found = false;
        for (int i = header + 1; i < lines.Length; i++)
        {
            string line = lines[i].TrimEnd('\r');
            if (AnyHeaderPattern.IsMatch(line))
            {
                break;
            }

            string trimmed = line.Trim();
            if (trimmed.Length == 0 || trimmed[0] == '#')
            {
                continue;
            }

            Match match = EntryPattern.Match(line);
            if (!match.Success)
            {
                return Lookup.Unsure;
            }

            string name = match.Groups[1].Success ? match.Groups[1].Value : (match.Groups[2].Success ? match.Groups[2].Value : match.Groups[3].Value);
            if (string.Equals(name, tool, StringComparison.OrdinalIgnoreCase))
            {
                if (found)
                {
                    return Lookup.Unsure;
                }
                found = true;
                specifier = match.Groups[4].Success ? match.Groups[4].Value : match.Groups[5].Value;
            }
        }

        return found ? Lookup.Found : Lookup.NotListed;
    }

    // "owner/repo@version" (optionally "github:owner/repo@version") -> the installed program, or
    // null when it isn't a plain installed tool.
    private static string ExecutableFor(string toolsRoot, string specifier)
    {
        string raw = specifier.Trim();
        if (raw.StartsWith("github:", StringComparison.Ordinal))
        {
            raw = raw.Substring(7);
        }

        int at = raw.LastIndexOf('@');
        int slash = raw.IndexOf('/');
        if (at <= 0 || slash <= 0 || slash > at)
        {
            return null;
        }

        string owner = raw.Substring(0, slash);
        string repo = raw.Substring(slash + 1, at - slash - 1);
        string version = VersionPrefixPattern.Replace(raw.Substring(at + 1), "");
        if (!NamePattern.IsMatch(owner) || !NamePattern.IsMatch(repo) || !VersionPattern.IsMatch(version))
        {
            return null;
        }

        string lowerRepo = repo.ToLowerInvariant();
        string executable = Path.Combine(Path.Combine(Path.Combine(Path.Combine(toolsRoot, owner.ToLowerInvariant()), lowerRepo), version), lowerRepo + ".exe");
        return File.Exists(executable) ? executable : null;
    }

    private static string QuickResolve(string tool, string sofHome)
    {
        string toolsRoot = Path.Combine(sofHome, "tools");
        string directory = Directory.GetCurrentDirectory();

        while (!string.IsNullOrEmpty(directory))
        {
            string file = Path.Combine(directory, "sof.toml");
            if (File.Exists(file))
            {
                string specifier;
                Lookup result = FindInToolsTable(File.ReadAllText(file), tool, out specifier);
                if (result == Lookup.Unsure)
                {
                    return null;
                }
                if (result == Lookup.Found)
                {
                    return ExecutableFor(toolsRoot, specifier);
                }
            }

            DirectoryInfo parent = Directory.GetParent(directory);
            directory = parent == null ? null : parent.FullName;
        }

        // Not in any project: the global tools list is for sof to read.
        return null;
    }

    private static int Run(string fileName, string arguments)
    {
        // Ctrl+C reaches the whole console, the tool included: let the tool decide how to stop and
        // keep this process alive until it has.
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };

        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = fileName;
        start.Arguments = arguments;
        start.UseShellExecute = false;

        try
        {
            using (Process process = Process.Start(start))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception e)
        {
            // A file that isn't a program (a quarantined or damaged download, say).
            return StartFailed(fileName, e.Message);
        }
    }

    private static int StartFailed(string fileName, string reason)
    {
        Console.Error.WriteLine("sof: couldn't start " + fileName + ": " + reason);
        return 126;
    }

    private static int Main()
    {
        string self = Assembly.GetExecutingAssembly().Location;
        string tool = Path.GetFileNameWithoutExtension(self);
        string binDirectory = Path.GetDirectoryName(self);
        string arguments = ArgumentsAfterProgramName();

        if (Environment.GetEnvironmentVariable("SOF_SHIM_SLOW") != "1")
        {
            string executable = null;
            try
            {
                executable = QuickResolve(tool, Path.GetDirectoryName(binDirectory));
            }
            catch (Exception)
            {
                executable = null;
            }

            if (executable != null)
            {
                return Run(executable, arguments);
            }
        }

        string configPath = Path.Combine(binDirectory, "sof-shim.cfg");
        if (!File.Exists(configPath))
        {
            return Fail("can't find " + configPath + ". Run: sof run tools setup");
        }

        string[] config = File.ReadAllLines(configPath);
        string node = config.Length > 0 ? config[0].Trim() : "";
        string entry = config.Length > 1 ? config[1].Trim() : "";

        if (node == "" || !File.Exists(node))
        {
            node = FindOnPath("node.exe");
        }
        if (node == null)
        {
            return Fail("Node.js was not found. Install it from https://nodejs.org, then run: sof run tools setup");
        }
        if (entry == "" || !File.Exists(entry))
        {
            return Fail("sof is no longer at " + entry + ". Run: sof run tools setup");
        }

        return Run(node, "\"" + entry + "\" run tools exec " + tool + arguments);
    }
}
