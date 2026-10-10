// Native launcher for Wealth Ledger. Starts the Node server if port 3000 is not
// already listening, then opens the app in a new Chrome tab. install-shortcut.ps1
// compiles this into WealthLedger.exe, which has to sit beside server.js.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class WealthLedger
{
    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        int port;
        if (!int.TryParse(Environment.GetEnvironmentVariable("PORT"), out port) || port < 1 || port > 65535)
        {
            port = 3000;
        }

        if (!PortIsOpen(port))
        {
            // A second double-click during boot must not start a second server
            // writing the same ledger file.
            if (!StartServerUnderLock(root, port)) return 1;
        }

        OpenInChrome("http://localhost:" + port);
        return 0;
    }

    private static bool StartServerUnderLock(string root, int port)
    {
        using (Mutex boot = new Mutex(false, @"Local\WealthLedgerLauncher"))
        {
            bool owned;
            try { owned = boot.WaitOne(TimeSpan.FromMinutes(1)); }
            catch (AbandonedMutexException) { owned = true; }

            if (!owned)
            {
                Fail("Another launch is still starting the server. Try again in a few seconds.");
                return false;
            }

            try
            {
                return PortIsOpen(port) || StartServer(root, port);
            }
            finally { boot.ReleaseMutex(); }
        }
    }

    private static bool StartServer(string root, int port)
    {
        string script = Path.Combine(root, "server.js");
        if (!File.Exists(script))
        {
            Fail("server.js is missing from\r\n\r\n" + root +
                "\r\n\r\nKeep WealthLedger.exe in the Wealth Ledger folder.");
            return false;
        }

        string node = FindNode();
        if (node == null)
        {
            Fail("Node.js was not found, so the ledger server cannot start." +
                "\r\n\r\nInstall it from nodejs.org, then try again.");
            return false;
        }

        string log = Path.Combine(root, "server.log");

        // cmd owns the log handles, so the server keeps logging after this launcher exits.
        // cmd also eats the first and last quote of a /c string that starts with one, so the
        // whole command gets a sacrificial outer pair to lose and keep the inner paths quoted.
        ProcessStartInfo info = new ProcessStartInfo(ComSpec(),
            "/c \"\"" + node + "\" \"" + script + "\" >> \"" + log + "\" 2>&1\"");
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;

        Process wrapper;
        try { wrapper = Process.Start(info); }
        catch (Exception ex)
        {
            Fail("The ledger server could not be started:\r\n\r\n" + ex.Message);
            return false;
        }

        using (wrapper)
        {
            // Boot fetches exchange rates before it starts listening, so allow for a slow feed.
            for (int tick = 0; tick < 133; tick++)
            {
                if (PortIsOpen(port)) return true;
                Thread.Sleep(300);
                wrapper.Refresh();
                if (wrapper.HasExited) break;
            }
        }

        Fail("The ledger did not come up on port " + port + ".\r\n\r\n" + TailOf(log));
        return false;
    }

    private static bool PortIsOpen(int port)
    {
        try
        {
            using (TcpClient client = new TcpClient())
            {
                client.Connect(IPAddress.Loopback, port);
                return true;
            }
        }
        catch (Exception) { return false; }
    }

    private static string FindNode()
    {
        string path = Environment.GetEnvironmentVariable("PATH");
        if (path != null)
        {
            foreach (string dir in path.Split(';'))
            {
                string trimmed = dir.Trim().Trim('"');
                if (trimmed.Length == 0) continue;
                try
                {
                    string candidate = Path.Combine(trimmed, "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch (Exception) { } // PATH entries are free to be malformed
            }
        }

        foreach (string programFiles in new string[]
        {
            Environment.GetEnvironmentVariable("ProgramFiles"),
            Environment.GetEnvironmentVariable("ProgramW6432"),
            Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
        })
        {
            if (string.IsNullOrEmpty(programFiles)) continue;
            string candidate = Path.Combine(programFiles, @"nodejs\node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static void OpenInChrome(string url)
    {
        string chrome = FindChrome();
        if (chrome != null)
        {
            try
            {
                Process.Start(chrome, "--new-tab " + url);
                return;
            }
            catch (Exception) { }
        }

        try
        {
            ProcessStartInfo info = new ProcessStartInfo(url);
            info.UseShellExecute = true; // hand the URL to whatever owns http
            Process.Start(info);
        }
        catch (Exception ex)
        {
            Fail("The ledger is running at " + url + " but no browser could be opened." +
                "\r\n\r\n" + ex.Message);
        }
    }

    private static string FindChrome()
    {
        using (RegistryKey key = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64)
            .OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"))
        {
            if (key != null)
            {
                string registered = key.GetValue(null) as string;
                if (!string.IsNullOrEmpty(registered) && File.Exists(registered)) return registered;
            }
        }

        foreach (string programFiles in new string[]
        {
            Environment.GetEnvironmentVariable("ProgramFiles"),
            Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
            Environment.GetEnvironmentVariable("LOCALAPPDATA"),
        })
        {
            if (string.IsNullOrEmpty(programFiles)) continue;
            string candidate = Path.Combine(programFiles, @"Google\Chrome\Application\chrome.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static string ComSpec()
    {
        string comSpec = Environment.GetEnvironmentVariable("ComSpec");
        return string.IsNullOrEmpty(comSpec) ? "cmd.exe" : comSpec;
    }

    private static string TailOf(string log)
    {
        try
        {
            List<string> lines = new List<string>();
            foreach (string line in File.ReadAllLines(log))
            {
                if (line.Trim().Length > 0) lines.Add(line.Trim());
            }
            if (lines.Count == 0) return "server.log is empty.";
            int from = Math.Max(0, lines.Count - 5);
            return string.Join("\r\n", lines.GetRange(from, lines.Count - from).ToArray());
        }
        catch (Exception)
        {
            return "Check server.log in " + Path.GetDirectoryName(log);
        }
    }

    private static void Fail(string message)
    {
        MessageBox.Show(message, "Wealth Ledger", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
