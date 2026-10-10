using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class portableLauncher
{
    private static readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
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
                    start.EnvironmentVariables["TOONFLOW_PORTABLE_LAUNCHER_PID"] = Process.GetCurrentProcess().Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    using (var process = Process.Start(start))
                    {
                        while (!process.WaitForExit(250)) startPendingUpdate(root);
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

    private static void startPendingUpdate(string root)
    {
        string cache = Path.Combine(root, "cache", "updates");
        string handoff = Path.Combine(cache, "portableHandoff.txt");
        if (!File.Exists(handoff)) return;
        string transaction = null;
        Dictionary<string, object> plan = null;
        try
        {
            ensurePlainPath(handoff);
            if (new FileInfo(handoff).Length != 32) throw new InvalidOperationException("更新交接标识无效。");
            transaction = File.ReadAllText(handoff, Encoding.UTF8);
            if (!Regex.IsMatch(transaction, "^[a-f0-9]{32}$")) throw new InvalidOperationException("更新交接标识无效。");
            File.Delete(handoff);
            string planPath = Path.Combine(cache, "update-" + transaction + ".json");
            if (!File.Exists(planPath)) return;
            ensurePlainPath(planPath);
            if (new FileInfo(planPath).Length > 65536) throw new InvalidOperationException("更新计划过大。");
            plan = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(planPath, Encoding.UTF8));
            object parent, install, mode, id;
            if (!plan.TryGetValue("parentPid", out parent) || !(parent is int) || (int)parent != Process.GetCurrentProcess().Id
                || !plan.TryGetValue("installDirectory", out install) || !(install is string)
                || !String.Equals(Path.GetFullPath((string)install).TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)
                || !plan.TryGetValue("portable", out mode) || !(mode is bool) || !(bool)mode
                || !plan.TryGetValue("transactionId", out id) || (id as string) != transaction)
                throw new InvalidOperationException("更新计划不属于当前便携应用。");
            string helper = Path.Combine(root, "temp", "toonflowUpdate-" + transaction + ".exe");
            ensurePlainPath(helper);
            // ACT: 此启动器位于 SDK Job 外，直接启动助手，便携更新无需注册计划任务。
            var start = new ProcessStartInfo(helper, "--apply-update \"" + planPath + "\" --quiet")
            {
                WorkingDirectory = Path.GetDirectoryName(helper), UseShellExecute = false,
                CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
            };
            setDirectory(start, "TEMP", Path.Combine(root, "temp"));
            setDirectory(start, "TMP", Path.Combine(root, "temp"));
            using (var helperProcess = Process.Start(start))
                if (helperProcess == null) throw new InvalidOperationException("无法启动便携更新助手。");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            if (transaction == null || !Regex.IsMatch(transaction, "^[a-f0-9]{32}$")) return;
            try
            {
                string resultPath = Path.Combine(cache, "updateResult.json");
                ensurePlainPath(resultPath);
                string temporary = resultPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
                object version = null, hash = null;
                if (plan != null) { plan.TryGetValue("version", out version); plan.TryGetValue("hash", out hash); }
                string result = serializer.Serialize(new { transactionId = transaction, success = false, error = error.Message, version = version, hash = hash });
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(result);
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (File.Exists(resultPath)) File.Replace(temporary, resultPath, null);
                else File.Move(temporary, resultPath);
            }
            catch (Exception resultError) { Console.Error.WriteLine(resultError.Message); }
        }
    }

    private static void ensurePlainPath(string path)
    {
        for (string current = Path.GetFullPath(path); current != null; current = Path.GetDirectoryName(current))
        {
            try
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidOperationException("便携更新路径不能包含链接。");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }
}
