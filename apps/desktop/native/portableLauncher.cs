using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class portableLauncher
{
    [STAThread]
    private static int Main()
    {
        try
        {
            string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            string identity;
            using (var hash = SHA256.Create())
                identity = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).Replace("-", "");
            bool created;
            using (var mutex = new Mutex(true, "Local\\ToonflowPortable-" + identity, out created))
            {
                if (!created)
                {
                    MessageBox.Show("这个便携目录中的 Toonflow 已在运行，请使用已打开的窗口。", "Toonflow");
                    return 0;
                }
                try
                {
                    // runtime 不符合 SDK 的安装目录布局，因此不会注册卸载项和协议。
                    string bin = Path.Combine(root, "runtime", "bin");
                    string launcher = Path.Combine(bin, "launcher.exe");
                    if (!File.Exists(launcher))
                        throw new FileNotFoundException("请先完整解压便携包，再双击 toonflow.exe。不要只复制 EXE。", launcher);
                    var check = new ProcessStartInfo(Path.Combine(bin, "checkWebView2.exe"))
                    {
                        WorkingDirectory = bin,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    using (var process = Process.Start(check))
                    {
                        process.WaitForExit();
                        if (process.ExitCode != 0)
                            throw new InvalidOperationException("需要 Microsoft Edge WebView2 Runtime 120 或更新版本。此便携包不会自动安装或更新系统组件。");
                    }
                    var start = new ProcessStartInfo(launcher)
                    {
                        WorkingDirectory = bin,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    setDirectory(start, "TOONFLOW_DATA_DIR", Path.Combine(root, "data"));
                    setDirectory(start, "LOCALAPPDATA", Path.Combine(root, "profile", "local"));
                    setDirectory(start, "APPDATA", Path.Combine(root, "profile", "roaming"));
                    setDirectory(start, "WEBVIEW2_USER_DATA_FOLDER", Path.Combine(root, "profile", "webview2"));
                    setDirectory(start, "TEMP", Path.Combine(root, "temp"));
                    setDirectory(start, "TMP", Path.Combine(root, "temp"));
                    setDirectory(start, "BUN_INSTALL_CACHE_DIR", Path.Combine(root, "cache", "bun"));
                    setDirectory(start, "BUN_RUNTIME_TRANSPILER_CACHE_PATH", Path.Combine(root, "cache", "bun", "transpiler"));
                    start.EnvironmentVariables["TOONFLOW_PORTABLE"] = "1";
                    using (var process = Process.Start(start))
                    {
                        process.WaitForExit();
                        if (process.ExitCode != 0)
                            throw new InvalidOperationException("Toonflow 未能正常运行，退出码：" + process.ExitCode);
                    }
                    return 0;
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Toonflow 便携版", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void setDirectory(ProcessStartInfo start, string name, string path)
    {
        Directory.CreateDirectory(path);
        start.EnvironmentVariables[name] = path;
    }
}
