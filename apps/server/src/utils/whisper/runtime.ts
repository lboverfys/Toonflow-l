import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeAtomic } from "@toonflow/file";
import { parseSrt, serializeSrt } from "@toonflow/node-shared/subtitleSrt";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import conf from "@/utils/conf";
import { getStatus } from "@/utils/ffmpeg";
import { isWithin, lockWorkspaceFiles } from "@/utils/workspace/files";
import { whisperModels } from "./types";
import type { WhisperCheckResult, WhisperStartInput, WhisperTask, WhisperTaskPhase } from "./types";

const dataDirectory = dirname(conf.path);
const cacheDirectory = join(dataDirectory, "whisper", "cache");
const taskDirectory = join(dataDirectory, "whisper", "tasks");
const tasks = new Map<string, WhisperTaskEntry>();
const maxCompletedTasks = 64;
const maxOutputLength = 64 * 1024;
let activeTask = false;

type WhisperTaskEntry = {
  controller: AbortController;
  child?: Bun.Subprocess;
  completion: Promise<WhisperTask>;
  resolveCompletion: (task: WhisperTask) => void;
  state: WhisperTask;
  outputPath: string;
  output: string;
  temporaryDirectory: string;
  pythonPath: string;
  ffmpegPath: string;
  release: () => void;
  finished: boolean;
};

type ProbeResult = {
  whisper: boolean;
  whisperError?: string;
  torchVersion?: string;
  torchCuda: boolean;
  torchError?: string;
  error?: string;
};

const probeScript = [
  "import importlib.util, json",
  "result = {'whisper': False, 'torchCuda': False}",
  "try:",
  " if importlib.util.find_spec('whisper') is None:",
  "  raise ModuleNotFoundError('openai-whisper is not installed')",
  " import whisper",
  " result['whisper'] = True",
  "except Exception as error:",
  " result['whisperError'] = str(error)",
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

function updateTask(entry: WhisperTaskEntry, phase: WhisperTaskPhase) {
  entry.state = { ...entry.state, phase, updatedAt: Date.now() };
}

function throwIfCancelled(entry: WhisperTaskEntry) {
  entry.controller.signal.throwIfAborted();
}

async function resolvePython(pythonPath?: string) {
  if (pythonPath !== undefined && !pythonPath.trim()) return { error: "Python 路径不能为空" };
  const requested = pythonPath?.trim();
  const path = requested ? isAbsolute(requested) ? requested : Bun.which(requested) : Bun.which("python");
  if (!path) return { error: requested ? `找不到 Python：${requested}` : "找不到 Python，请安装 Python 或配置路径" };
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { error: `找不到 Python：${path}` };
  if (!info.isFile()) return { error: `Python 路径不是普通文件：${path}` };
  return { path };
}

async function probePython(path: string): Promise<ProbeResult> {
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([path, "-c", probeScript], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 30000 });
  } catch (error) {
    return { whisper: false, torchCuda: false, error: `Python 无法启动：${errorMessage(error)}` };
  }
  const [stdout, stderr, code] = await Promise.all([readProcessOutput(child.stdout), readProcessOutput(child.stderr), child.exited]).catch(error => {
    return ["", `Python 探测失败：${errorMessage(error)}`, -1] as const;
  });
  if (code !== 0) return { whisper: false, torchCuda: false, error: stderr.trim() || `Python 探测失败（退出码 ${code}）` };
  try {
    const result = JSON.parse(stdout) as Partial<ProbeResult>;
    if (typeof result.whisper !== "boolean" || typeof result.torchCuda !== "boolean") throw new Error("探测结果格式无效");
    return {
      whisper: result.whisper,
      whisperError: typeof result.whisperError === "string" ? result.whisperError : undefined,
      torchVersion: typeof result.torchVersion === "string" ? result.torchVersion : undefined,
      torchCuda: result.torchCuda,
      torchError: typeof result.torchError === "string" ? result.torchError : undefined,
    };
  } catch (error) {
    return { whisper: false, torchCuda: false, error: `Python 探测结果无效：${errorMessage(error)}` };
  }
}

async function readProcessOutput(stream: Bun.Subprocess["stdout"] | Bun.Subprocess["stderr"], onText?: (text: string) => void) {
  if (!stream || typeof stream === "number") return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      onText?.(text);
      tail = (tail + text).slice(-maxOutputLength);
    }
    const finalText = decoder.decode();
    onText?.(finalText);
    return (tail + finalText).slice(-maxOutputLength);
  } finally {
    reader.releaseLock();
  }
}

export async function checkWhisper(pythonPath?: string): Promise<WhisperCheckResult> {
  const [python, ffmpeg] = await Promise.all([resolvePython(pythonPath), getStatus()]);
  const probe = python.path ? await probePython(python.path) : undefined;
  const pythonError = python.error ?? probe?.error;
  const whisperError = probe?.whisperError ?? (!probe?.whisper ? pythonError ? "Python 不可用，无法探测 Whisper" : "当前 Python 环境未安装 openai-whisper" : undefined);
  const torchError = probe?.torchError ?? (!probe?.torchVersion ? pythonError ? "Python 不可用，无法探测 PyTorch" : "当前 Python 环境未安装 PyTorch" : undefined);
  const ffmpegError = ffmpeg.tools.ffmpeg.error ?? (!ffmpeg.tools.ffmpeg.path ? "未找到 FFmpeg" : undefined);
  const ffprobeError = ffmpeg.tools.ffprobe.error ?? (!ffmpeg.tools.ffprobe.path ? "未找到 FFprobe" : undefined);
  const errors = [pythonError, whisperError, torchError, ffmpegError, ffprobeError].filter((error): error is string => Boolean(error));
  const torchAvailable = Boolean(probe?.torchVersion) && !torchError;
  return {
    models: whisperModels,
    python: { path: python.path, available: !pythonError, error: pythonError },
    whisper: { available: Boolean(probe?.whisper), error: whisperError },
    torch: { available: torchAvailable, version: probe?.torchVersion, cuda: probe?.torchCuda ?? false, error: torchError },
    device: torchAvailable ? probe?.torchCuda ? "cuda" : "cpu" : "unavailable",
    ffmpeg,
    cacheDirectory,
    ready: !errors.length,
    errors,
  };
}

async function modelIsCached(model: WhisperStartInput["model"]) {
  // 官方 Whisper 的别名 large/turbo 分别落到以下检查点文件。
  const filename = model === "large" ? "large-v3.pt" : model === "turbo" ? "large-v3-turbo.pt" : `${model}.pt`;
  const info = await lstat(join(cacheDirectory, "whisper", filename)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return Boolean(info?.isFile());
}

async function runWhisper(entry: WhisperTaskEntry, input: WhisperStartInput) {
  try {
    const cached = await modelIsCached(input.model);
    throwIfCancelled(entry);
    if (!cached) updateTask(entry, "downloadingModel");
    const pathSeparator = process.platform === "win32" ? ";" : ":";
    const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, value ?? ""]));
    environment.XDG_CACHE_HOME = cacheDirectory;
    const pathKey = Object.keys(environment).find(key => key.toUpperCase() === "PATH") ?? "PATH";
    environment[pathKey] = `${dirname(entry.ffmpegPath)}${pathSeparator}${environment[pathKey] ?? ""}`;
    throwIfCancelled(entry);
    entry.child = Bun.spawn([
      entry.pythonPath, "-u", "-m", "whisper", input.sourcePath,
      "--model", input.model,
      "--output_dir", entry.temporaryDirectory,
      "--output_format", "srt",
      "--task", "transcribe",
      "--verbose", "True",
      ...(input.language ? ["--language", input.language] : []),
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: environment, signal: entry.controller.signal });
    if (cached) updateTask(entry, "transcribing");
    let lineTail = "";
    const onStdout = (text: string) => {
      if (entry.state.phase !== "downloadingModel") return;
      lineTail = (lineTail + text).slice(-256);
      if (!entry.controller.signal.aborted && /\[\d{2}:\d{2}(?::\d{2})?\.\d{3}\s*-->/.test(lineTail)) updateTask(entry, "transcribing");
    };
    const [stdout, stderr, code] = await Promise.all([readProcessOutput(entry.child.stdout, onStdout), readProcessOutput(entry.child.stderr), entry.child.exited]);
    throwIfCancelled(entry);
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `Whisper 退出码为 ${code}`);
    const results = (await readdir(entry.temporaryDirectory, { withFileTypes: true }))
      .filter(item => item.isFile() && item.name.toLowerCase().endsWith(".srt"));
    throwIfCancelled(entry);
    if (results.length !== 1) throw new Error(results.length ? "Whisper 生成了多个 SRT 文件" : "Whisper 未生成 SRT 文件");
    const content = await readFile(join(entry.temporaryDirectory, results[0].name), "utf8");
    throwIfCancelled(entry);
    const segments = parseSrt(content);
    if (!segments.length) throw new Error("Whisper 生成了空字幕");
    const normalized = serializeSrt(segments);
    // ACT: writing 是不可取消的提交边界；开始排他原子写入后，取消请求只等待真实结果。
    updateTask(entry, "writing");
    await writeAtomic(entry.outputPath, normalized, { exclusive: true });
    await finishTask(entry, "completed");
  } catch (error) {
    try { entry.child?.kill(); }
    catch { /* 子进程可能已经退出，保留原始失败原因。 */ }
    await finishTask(entry, entry.controller.signal.aborted ? "cancelled" : "failed", errorMessage(error));
  }
}

async function finishTask(entry: WhisperTaskEntry, phase: "completed" | "failed" | "cancelled", error?: string) {
  if (entry.finished) return;
  entry.finished = true;
  let cleanupError: unknown;
  try {
    if (entry.child) await entry.child.exited;
  } catch (cause) {
    cleanupError = cause;
  }
  try {
    if (!isWithin(taskDirectory, entry.temporaryDirectory) || resolve(entry.temporaryDirectory) === resolve(taskDirectory)) throw new Error("Whisper 临时目录路径无效");
    await rm(entry.temporaryDirectory, { recursive: true, force: true });
  } catch (cause) {
    cleanupError = cleanupError ? new AggregateError([cleanupError, cause], `${errorMessage(cleanupError)}；${errorMessage(cause)}`) : cause;
  } finally {
    if (cleanupError) {
      phase = "failed";
      error = `Whisper 清理失败：${errorMessage(cleanupError)}`;
    }
    entry.release();
    activeTask = false;
    entry.state = { ...entry.state, phase, running: false, output: phase === "completed" ? entry.output : undefined, error, updatedAt: Date.now() };
    entry.resolveCompletion(snapshot(entry.state));
    const completed = [...tasks].filter(([, task]) => !task.state.running);
    for (const [key] of completed.slice(0, -maxCompletedTasks)) tasks.delete(key);
  }
}

export async function startWhisper(input: WhisperStartInput): Promise<WhisperTask> {
  if (!whisperModels.includes(input.model)) throw new Error("Whisper 模型无效");
  const language = input.language?.trim();
  if (language && (language.length > 32 || !/^[a-zA-Z][a-zA-Z -]*$/.test(language))) throw new Error("Whisper 语言无效");
  if (!isAbsolute(input.sourcePath) || !isAbsolute(input.outputPath) || !isAbsolute(input.directory)) throw new Error("Whisper 输入路径必须是绝对路径");
  if (!isWithin(input.directory, input.sourcePath) || !isWithin(input.directory, input.outputPath)) throw new Error("Whisper 文件必须位于工作区内");
  if (resolve(input.sourcePath).toLowerCase() === resolve(input.outputPath).toLowerCase()) throw new Error("Whisper 输出不能覆盖源文件");
  if (extname(input.outputPath).toLowerCase() !== ".srt") throw Object.assign(new Error("Whisper 输出必须是 SRT 文件"), { status: 400 });
  if (activeTask) throw Object.assign(new Error("Whisper 任务正在运行，请等待完成"), { status: 409, code: "EBUSY" });
  activeTask = true;
  let release: (() => void) | undefined;
  let temporaryDirectory: string | undefined;
  try {
    const source = await lstat(input.sourcePath);
    if (!source.isFile()) throw Object.assign(new Error("Whisper 源文件必须是普通文件"), { status: 400 });
    if (!(await stat(dirname(input.outputPath))).isDirectory()) throw Object.assign(new Error("Whisper 输出目录不存在"), { status: 400 });
    const output = await lstat(input.outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (output) throw Object.assign(new Error("Whisper 输出文件已存在"), { code: "EEXIST" });
    const check = await checkWhisper(input.pythonPath);
    if (!check.ready || !check.python.path || !check.ffmpeg.tools.ffmpeg.path) throw new Error(check.errors.join("；") || "Whisper 运行环境不可用");
    release = lockWorkspaceFiles([input.outputPath]);
    await mkdir(taskDirectory, { recursive: true });
    temporaryDirectory = await mkdtemp(join(taskDirectory, "task-"));
    const operationId = crypto.randomUUID();
    const state: WhisperTask = { operationId, phase: "preparing", running: true, model: input.model, updatedAt: Date.now() };
    let resolveCompletion!: (task: WhisperTask) => void;
    const completion = new Promise<WhisperTask>(resolve => { resolveCompletion = resolve; });
    const entry: WhisperTaskEntry = {
      controller: new AbortController(), completion, resolveCompletion, state,
      outputPath: input.outputPath, output: relative(input.directory, input.outputPath).split(sep).join("/"),
      temporaryDirectory, pythonPath: check.python.path, ffmpegPath: check.ffmpeg.tools.ffmpeg.path,
      release, finished: false,
    };
    tasks.set(taskKey(input.directory, operationId), entry);
    void runWhisper(entry, { ...input, language });
    return snapshot(state);
  } catch (error) {
    try {
      if (temporaryDirectory && isWithin(taskDirectory, temporaryDirectory) && resolve(temporaryDirectory) !== resolve(taskDirectory)) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${errorMessage(error)}；临时目录清理失败：${errorMessage(cleanupError)}`);
    } finally {
      release?.();
      activeTask = false;
    }
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
  if (entry.state.running && entry.state.phase !== "writing") {
    entry.controller.abort();
    try { entry.child?.kill(); }
    catch { /* 进程可能已在退出，仍等待 exited 和清理完成。 */ }
  }
  await entry.completion;
  return snapshot(entry.state);
}
