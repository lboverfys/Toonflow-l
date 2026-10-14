import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeAtomic } from "@toonflow/file";
import { dirname, isAbsolute, join } from "node:path";
import conf from "@/utils/conf";
import { getStatus } from "@/utils/ffmpeg";
import { lockWorkspaceFiles } from "@/utils/workspace/files";
import { whisperModels } from "./types";
import type { WhisperCheckResult, WhisperStartInput, WhisperTask, WhisperTaskPhase } from "./types";

const dataDirectory = dirname(conf.path);
const cacheDirectory = join(dataDirectory, "whisper", "cache");
const taskDirectory = join(dataDirectory, "whisper", "tasks");
const tasks = new Map<string, WhisperTaskEntry>();

type WhisperTaskEntry = {
  controller: AbortController;
  child?: Bun.Subprocess;
  completion: Promise<WhisperTask>;
  resolveCompletion: (task: WhisperTask) => void;
  state: WhisperTask;
  outputPath: string;
  temporaryDirectory: string;
  release: () => void;
  finished: boolean;
};

type ProbeResult = {
  whisper: boolean;
  torchVersion?: string;
  torchCuda: boolean;
  torchError?: string;
  error?: string;
};

const probeScript = [
  "import importlib.util, json",
  "result = {'whisper': importlib.util.find_spec('whisper') is not None, 'torchCuda': False}",
  "try:",
  " import torch",
  " result['torchVersion'] = str(torch.__version__)",
  " result['torchCuda'] = bool(torch.cuda.is_available())",
  "except Exception as error:",
  " result['torchError'] = str(error)",
  "print(json.dumps(result, ensure_ascii=False))",
].join("\n");

function taskKey(directory: string, operationId: string) {
  return `${directory}\0${operationId}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function snapshot(task: WhisperTask): WhisperTask {
  return { ...task };
}

function updateTask(entry: WhisperTaskEntry, phase: WhisperTaskPhase, values: Partial<Pick<WhisperTask, "output" | "error">> = {}) {
  entry.state = { ...entry.state, phase, running: phase === "preparing" || phase === "downloadingModel" || phase === "transcribing" || phase === "writing", ...values, updatedAt: Date.now() };
  return entry.state;
}

async function resolvePython(pythonPath?: string) {
  if (pythonPath !== undefined && !pythonPath.trim()) return { error: "Python 路径不能为空" };
  const requested = pythonPath?.trim();
  const path = requested ? isAbsolute(requested) ? requested : Bun.which(requested) : Bun.which("python");
  if (!path) return { error: requested ? `找不到 Python：${requested}` : "找不到 Python，请安装 Python 或配置路径" };
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { error: `找不到 Python：${path}` };
  if (info.isDirectory()) return { error: `Python 路径是目录：${path}` };
  return { path };
}

async function probePython(path: string): Promise<ProbeResult> {
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([path, "-c", probeScript], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 15000 });
  } catch (error) {
    return { whisper: false, torchCuda: false, error: `Python 无法启动：${errorMessage(error)}` };
  }
  const [stdout, stderr, code] = await Promise.all([readProcessOutput(child.stdout), readProcessOutput(child.stderr), child.exited]);
  if (code !== 0) return { whisper: false, torchCuda: false, error: stderr.trim() || `Python 探测失败（退出码 ${code}）` };
  try {
    const result = JSON.parse(stdout) as Partial<ProbeResult>;
    if (typeof result.whisper !== "boolean" || typeof result.torchCuda !== "boolean") throw new Error("探测结果格式无效");
    return {
      whisper: result.whisper,
      torchVersion: typeof result.torchVersion === "string" ? result.torchVersion : undefined,
      torchCuda: result.torchCuda,
      torchError: typeof result.torchError === "string" ? result.torchError : undefined,
    };
  } catch (error) {
    return { whisper: false, torchCuda: false, error: `Python 探测结果无效：${errorMessage(error)}` };
  }
}

function readProcessOutput(stream: Bun.Subprocess["stdout"] | Bun.Subprocess["stderr"]) {
  if (!stream || typeof stream === "number") return Promise.resolve("");
  return new Response(stream).text();
}

export async function checkWhisper(pythonPath?: string): Promise<WhisperCheckResult> {
  const [python, ffmpeg] = await Promise.all([resolvePython(pythonPath), getStatus()]);
  const errors: string[] = [];
  if (python.error || !python.path) {
    errors.push(python.error ?? "找不到 Python");
    return {
      python: { available: false, error: python.error ?? "找不到 Python" },
      whisper: { available: false, error: "无法探测 Whisper" },
      torch: { available: false, cuda: false, error: "无法探测 PyTorch" },
      device: "unavailable",
      ffmpeg,
      cacheDirectory,
      ready: false,
      errors,
    };
  }
  const probe = await probePython(python.path);
  if (probe.error) errors.push(probe.error);
  if (!probe.whisper) errors.push("当前 Python 环境未安装 openai-whisper");
  if (probe.torchError || !probe.torchVersion) errors.push(probe.torchError ?? "当前 Python 环境未安装 PyTorch");
  if (ffmpeg.tools.ffmpeg.error || !ffmpeg.tools.ffmpeg.path) errors.push(ffmpeg.tools.ffmpeg.error ?? "未找到 FFmpeg");
  if (ffmpeg.tools.ffprobe.error || !ffmpeg.tools.ffprobe.path) errors.push(ffmpeg.tools.ffprobe.error ?? "未找到 FFprobe");
  const torchAvailable = Boolean(probe.torchVersion) && !probe.torchError;
  return {
    python: { path: python.path, available: !probe.error },
    whisper: { available: probe.whisper, error: probe.whisper ? undefined : "当前 Python 环境未安装 openai-whisper" },
    torch: { available: torchAvailable, version: probe.torchVersion, cuda: probe.torchCuda, error: probe.torchError },
    device: torchAvailable ? probe.torchCuda ? "cuda" : "cpu" : "unavailable",
    ffmpeg,
    cacheDirectory,
    ready: !errors.length,
    errors,
  };
}

async function runWhisper(entry: WhisperTaskEntry, input: WhisperStartInput) {
  try {
    const modelPath = join(cacheDirectory, "whisper", `${input.model}.pt`);
    const modelExists = await lstat(modelPath).then(info => info.isFile()).catch(() => false);
    if (!modelExists) updateTask(entry, "downloadingModel");
    const ffmpeg = await getStatus();
    if (entry.controller.signal.aborted) throw new DOMException("任务已取消", "AbortError");
    const ffmpegPath = ffmpeg.tools.ffmpeg.path;
    const pathSeparator = process.platform === "win32" ? ";" : ":";
    const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, value ?? ""]));
    environment.XDG_CACHE_HOME = cacheDirectory;
    if (ffmpegPath) environment.PATH = `${dirname(ffmpegPath)}${pathSeparator}${process.env.PATH ?? ""}`;
    const resolvedPython = await resolvePython(input.pythonPath);
    if (!resolvedPython.path) throw new Error(resolvedPython.error ?? "找不到 Python，请安装 Python 或配置路径");
    const python = resolvedPython.path;
    entry.child = Bun.spawn([
      python, "-m", "whisper", input.sourcePath,
      "--model", input.model,
      "--output_dir", entry.temporaryDirectory,
      "--output_format", "srt",
      "--task", "transcribe",
      ...(input.language ? ["--language", input.language] : []),
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: environment, signal: entry.controller.signal });
    updateTask(entry, "transcribing");
    const [stdout, stderr, code] = await Promise.all([readProcessOutput(entry.child.stdout), readProcessOutput(entry.child.stderr), entry.child.exited]);
    if (entry.controller.signal.aborted) throw new DOMException("任务已取消", "AbortError");
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `Whisper 退出码为 ${code}`);
    const results = (await readdir(entry.temporaryDirectory, { withFileTypes: true }))
      .filter(item => item.isFile() && item.name.toLowerCase().endsWith(".srt"));
    if (results.length !== 1) throw new Error(results.length ? "Whisper 生成了多个 SRT 文件" : "Whisper 未生成 SRT 文件");
    const content = await readFile(join(entry.temporaryDirectory, results[0].name), "utf8");
    if (!content.trim()) throw new Error("Whisper 生成了空字幕");
    updateTask(entry, "writing");
    await writeAtomic(entry.outputPath, content);
    finishTask(entry, "completed", { output: entry.outputPath });
  } catch (error) {
    finishTask(entry, entry.controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError") ? "cancelled" : "failed", {
      error: errorMessage(error),
    });
  }
}

function finishTask(entry: WhisperTaskEntry, phase: "completed" | "failed" | "cancelled", values: Partial<Pick<WhisperTask, "output" | "error">> = {}) {
  if (entry.finished) return;
  entry.finished = true;
  updateTask(entry, phase, values);
  void (async () => {
    if (entry.child) await entry.child.exited.catch(() => {});
    await rm(entry.temporaryDirectory, { recursive: true, force: true }).catch(error => console.warn(`Whisper 临时目录清理失败：${entry.temporaryDirectory}`, error));
    entry.release();
    entry.resolveCompletion(snapshot(entry.state));
  })();
}

export async function startWhisper(input: WhisperStartInput): Promise<WhisperTask> {
  if (!whisperModels.includes(input.model)) throw new Error("Whisper 模型无效");
  if (!input.language || !input.language.trim()) input = { ...input, language: undefined };
  else if (input.language.trim().length > 32) throw new Error("语言代码长度不能超过 32 个字符");
  if (!isAbsolute(input.sourcePath) || !isAbsolute(input.outputPath) || !isAbsolute(input.directory)) throw new Error("Whisper 输入路径必须是绝对路径");
  const resolvedPython = await resolvePython(input.pythonPath);
  if (!resolvedPython.path) throw new Error(resolvedPython.error ?? "找不到 Python，请安装 Python 或配置路径");
  input = { ...input, pythonPath: resolvedPython.path };
  const release = lockWorkspaceFiles([input.outputPath]);
  let temporaryDirectory: string | undefined;
  try {
    await mkdir(taskDirectory, { recursive: true });
    temporaryDirectory = await mkdtemp(join(taskDirectory, "task-"));
    const operationId = crypto.randomUUID();
    const state: WhisperTask = { operationId, phase: "preparing", running: true, model: input.model, updatedAt: Date.now() };
    let resolveCompletion!: (task: WhisperTask) => void;
    const completion = new Promise<WhisperTask>(resolve => { resolveCompletion = resolve; });
    const entry: WhisperTaskEntry = { controller: new AbortController(), completion, resolveCompletion, state, outputPath: input.outputPath, temporaryDirectory, release, finished: false };
    tasks.set(taskKey(input.directory, operationId), entry);
    void runWhisper(entry, input);
    return snapshot(state);
  } catch (error) {
    release();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function findTask(directory: string, operationId: string) {
  const entry = tasks.get(taskKey(directory, operationId));
  if (!entry) throw Object.assign(new Error("任务已失效"), { code: "WHISPER_TASK_EXPIRED", status: 404 });
  return entry;
}

export function getWhisperTask(directory: string, operationId: string) {
  return snapshot(findTask(directory, operationId).state);
}

export async function cancelWhisper(directory: string, operationId: string) {
  const entry = findTask(directory, operationId);
  if (entry.state.running) {
    entry.controller.abort();
    try { entry.child?.kill(); }
    catch { /* 进程可能已在退出，仍等待 exited 和清理完成。 */ }
  }
  await entry.completion;
  return snapshot(entry.state);
}
