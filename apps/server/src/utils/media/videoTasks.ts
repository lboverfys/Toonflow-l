import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { mkdir, open, readFile, stat, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import type { VideoTaskContext } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, VideoTaskStatus } from "@toonflow/tools-scaffold/runtime";
import { videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { resolveWorkspacePath } from "@/utils/workspace/files";

const maxVideoSize = 100 * 1024 * 1024;
const active = new Set<string>();
const taskIdSchema = z.uuid();
const stateSchema = z.object({
  phase: z.enum(["prepared", "submitting", "queued", "in_progress", "downloading", "failed"]),
  taskId: z.string().min(1).optional(), progress: z.number().min(0).max(100).optional(), error: z.string().optional(),
});
const recordSchema = z.object({
  version: z.literal(1), id: taskIdSchema, identity: z.string(), request: videoGenerationSchema,
  state: stateSchema, createdAt: z.number(), updatedAt: z.number(), lastError: z.string().optional(),
  result: z.array(z.object({ path: z.string(), mimeType: z.string(), mediaType: z.literal("video") })).optional(),
  download: z.object({ validator: z.string().optional(), total: z.number().int().positive().max(maxVideoSize).optional() }).optional(),
});
type TaskRecord = z.infer<typeof recordSchema>;

function invalid(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
function hash(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function taskDirectory(cwd: string, outputDirectory: string) {
  const output = await resolveWorkspacePath(cwd, outputDirectory, true);
  const key = process.platform === "win32" ? output.path.toLowerCase() : output.path;
  return (await resolveWorkspacePath(cwd, `.toonflow/videoTasks/${hash(key)}`, true)).path;
}

async function readRecord(path: string) {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.size > 2 * 1024 * 1024) invalid("视频任务记录无效，请保留现场并检查文件");
  return recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function currentRecord(cwd: string, directory: string) {
  const path = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, "current.json")))).path;
  const id = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (id === null) return null;
  const parsed = taskIdSchema.parse(JSON.parse(id));
  const recordPath = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, `${parsed}.json`)))).path;
  const record = await readRecord(recordPath);
  if (!record || record.id !== parsed) invalid("视频任务索引不完整，请保留现场，不能重新提交");
  return record;
}

export async function getVideoTask(cwd: string, outputDirectory: string): Promise<VideoTaskStatus | null> {
  const directory = await taskDirectory(cwd, outputDirectory);
  if (!(await stat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }))) return null;
  const task = await currentRecord(cwd, directory);
  if (!task) return null;
  return {
    operationId: task.id, providerId: task.request.providerId, modelId: task.request.modelId,
    phase: task.result ? "completed" : task.state.phase, taskId: task.state.taskId,
    progress: task.result ? 100 : task.state.progress, error: task.state.error ?? task.lastError,
    running: active.has(directory), result: task.result, updatedAt: task.updatedAt,
  };
}

export async function getVideoTaskRequest(cwd: string, outputDirectory: string, operationId: string): Promise<MediaGenerationRequest> {
  const directory = await taskDirectory(cwd, outputDirectory);
  const task = await currentRecord(cwd, directory);
  if (!task || task.id !== operationId) invalid("原视频任务不存在或已被新操作替代");
  if (task.request.outputDirectory !== outputDirectory) invalid("视频任务与节点不匹配");
  return task.request;
}

function validateMp4(bytes: Buffer) {
  let offset = 0;
  const boxes = new Set<string>();
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) invalid("原片不完整，请恢复下载", 502);
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (bytes.length - offset < 16) invalid("原片不完整，请恢复下载", 502);
      const largeSize = bytes.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(bytes.length)) invalid("原片不完整，请恢复下载", 502);
      size = Number(largeSize); headerSize = 16;
    } else if (size === 0) size = bytes.length - offset;
    if (size < headerSize || offset + size > bytes.length) invalid("原片不完整，请恢复下载", 502);
    boxes.add(type);
    offset += size;
  }
  if (!["ftyp", "moov", "mdat"].every(type => boxes.has(type))) invalid("下载内容不是完整的 MP4 原片", 502);
}

async function downloadVideo(
  cwd: string, path: string, url: string, headers: Record<string, string>, record: TaskRecord,
  save: () => Promise<void>, signal?: AbortSignal,
) {
  await resolveWorkspacePath(cwd, relative(cwd, path));
  const local = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (local && (!local.isFile() || local.size > maxVideoSize)) invalid("原片临时文件无效");
  if (local?.size && local.size === record.download?.total) {
    const bytes = await readFile(path);
    try { validateMp4(bytes); return bytes; }
    catch { record.download = undefined; await save(); }
  }
  let offset = record.download?.validator ? local?.size ?? 0 : 0;
  const response = await fetch(url, {
    headers: { ...headers, ...(offset ? { Range: `bytes=${offset}-`, "If-Range": record.download!.validator! } : {}) },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000), redirect: "error",
  });
  const reject = async (message: string): Promise<never> => { await response.body?.cancel(); return invalid(message, 502); };
  if (!response.ok) return reject(`原片下载暂未完成（HTTP ${response.status}），请恢复原任务，不要重新生成`);
  if (response.headers.get("x-video-quality")?.toLowerCase() !== "original") return reject("接口未返回原片标记，已保留任务，请稍后恢复下载");
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mime !== "video/mp4" && mime !== "application/octet-stream") return reject("原片内容类型不正确，已保留任务");
  const lengthHeader = response.headers.get("content-length");
  const length = lengthHeader === null ? undefined : Number(lengthHeader);
  if (length !== undefined && (!Number.isSafeInteger(length) || length <= 0 || length > maxVideoSize)) return reject("原片长度无效或超过 Toonflow 的 100 MiB 限制");
  const etag = response.headers.get("etag");
  const validator = etag && !etag.startsWith("W/") ? etag : response.headers.get("last-modified") ?? undefined;
  let total = length;
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (!range || Number(range[1]) !== offset || Number(range[2]) !== Number(range[3]) - 1 || (length !== undefined && Number(range[2]) - offset + 1 !== length)) return reject("原片续传范围不匹配，请保留任务并检查下载接口");
    total = Number(range[3]);
    if (offset && (validator !== record.download?.validator || (record.download?.total !== undefined && total !== record.download.total))) return reject("原片在续传期间发生变化，已停止追加");
  } else if (response.status === 200) offset = 0;
  else return reject("原片下载返回了不支持的状态码");
  if (total !== undefined && (!Number.isSafeInteger(total) || total <= 0 || total > maxVideoSize)) return reject("原片超过 Toonflow 的 100 MiB 限制或长度无效");
  record.download = { validator, total };
  await save();
  const reader = response.body?.getReader();
  if (!reader) invalid("原片响应为空", 502);
  const file = await open(path, offset ? "a" : "w");
  let received = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received + offset > maxVideoSize || (total !== undefined && received + offset > total)) invalid("原片实际长度超过声明值或 100 MiB 限制", 502);
      await file.writeFile(value);
    }
    await file.sync();
  } finally { await file.close(); await reader.cancel(); }
  if (!received || (length !== undefined && received !== length) || (total !== undefined && received + offset !== total)) invalid("原片下载中断，已保存断点，请恢复原任务", 502);
  const bytes = await readFile(path);
  try { validateMp4(bytes); }
  catch (error) { record.download = undefined; await save(); throw error; }
  return bytes;
}

export async function runVideoTask(
  cwd: string, input: MediaGenerationRequest, config: Record<string, unknown>,
  generate: (request: MediaGenerationRequest, context: VideoTaskContext) => Promise<GeneratedMedia[]>,
  sanitize: (error: unknown) => string, signal?: AbortSignal,
) {
  const outputDirectory = input.outputDirectory ?? "assets/generated";
  const directory = await taskDirectory(cwd, outputDirectory);
  if (active.has(directory)) invalid("此节点的原视频任务仍在运行，请等待或恢复查询，不能重复提交");
  active.add(directory);
  try {
    await mkdir(directory, { recursive: true });
    const previous = await currentRecord(cwd, directory);
    const operationId = taskIdSchema.parse(input.operationId ?? crypto.randomUUID());
    const request = videoGenerationSchema.parse({ ...input, outputDirectory, operationId });
    const recordPath = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, `${operationId}.json`)))).path;
    let record = await readRecord(recordPath);
    if (previous && previous.id !== operationId && !previous.result && previous.state.phase !== "failed") invalid("此节点存在未完成的视频任务，请先恢复原任务");
    const identity = hash(canonical({ apiKey: String(config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "").trim(), apiUrl: String(config.apiUrl ?? "").replace(/\/+$/, "") }));
    if (record) {
      if (record.id !== operationId || canonical(record.request) !== canonical(request)) invalid("同一操作不能修改生成参数，请先恢复原任务");
      if (record.result) return record.result;
      if (record.identity !== identity) invalid("恢复任务须使用原 API 地址和密钥，请恢复原配置");
      if (record.state.phase === "failed") invalid(record.state.error || "原任务已失败，请确认后发起新生成");
    } else {
      record = { version: 1, id: operationId, identity, request, state: { phase: "prepared" }, createdAt: Date.now(), updatedAt: Date.now() };
      await writeAtomic(recordPath, JSON.stringify(record), { exclusive: true });
    }
    await writeAtomic(join(directory, "current.json"), JSON.stringify(operationId));
    const task = record;
    const save = async () => { task.updatedAt = Date.now(); await writeAtomic(recordPath, JSON.stringify(task)); };
    const requestPath = (await resolveWorkspacePath(cwd, relative(cwd, join(directory, `${operationId}.request.json`)))).path;
    let requestSaved = !!(await stat(requestPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }));
    const context: VideoTaskContext = {
      id: operationId,
      get state() { return task.state; },
      get requestSaved() { return requestSaved; },
      async readRequest() {
        const info = await stat(requestPath);
        if (!info.isFile() || info.size > 128 * 1024 * 1024) invalid("原始请求记录无效");
        return readFile(requestPath, "utf8");
      },
      async saveRequest(body) {
        if (requestSaved) invalid("不能覆盖原视频请求");
        await writeAtomic(requestPath, body, { exclusive: true });
        requestSaved = true;
      },
      async update(state) { task.state = stateSchema.parse({ ...task.state, ...state }); task.lastError = undefined; await save(); },
      download: (url, headers) => downloadVideo(cwd, join(directory, `${operationId}.part`), url, headers, task, save, signal),
    };
    try {
      const result = await generate(request, context);
      if (result.length !== 1 || result[0]?.mediaType !== "video") invalid("视频任务应返回一条视频", 502);
      task.result = result as TaskRecord["result"];
      task.lastError = undefined;
      await save();
      return result;
    } catch (error) {
      task.lastError = signal?.aborted ? "本地等待已中断，原任务已保留；恢复不会新建视频" : sanitize(error);
      if (!requestSaved) task.state = { phase: "failed", error: task.lastError };
      await save();
      throw error;
    }
  } finally { active.delete(directory); }
}
