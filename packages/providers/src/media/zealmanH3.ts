const rules = [
  { type: "input", field: "apiUrl" as const, title: "面板地址", value: "", props: { placeholder: "填写机器 6008 端口对应的 HTTP(S) 访问地址，可稍后填写" } },
  { type: "input", field: "u08WorkflowId" as const, title: "U08 工作流 ID", value: "API-U08" },
  { type: "input", field: "u06WorkflowId" as const, title: "U06 工作流 ID", value: "API-U06-9图3音频-V5" },
  { type: "input", field: "u24WorkflowId" as const, title: "U24 工作流 ID", value: "API-U24-文武双修T8版" },
  { type: "input", field: "u32WorkflowId" as const, title: "U32 工作流 ID", value: "API-U32" },
  { type: "input", field: "u30WorkflowId" as const, title: "U30 工作流 ID", value: "API-U30" },
];

const workflows: Record<string, { field: string; megapixels: number[]; defaultMegapixels: number; audios: number; seed?: string }> = {
  u08: { field: "u08WorkflowId", megapixels: [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1], defaultMegapixels: 0.4, audios: 3 },
  u06: { field: "u06WorkflowId", megapixels: [0.4, 0.5, 0.6, 0.8, 1, 1.2], defaultMegapixels: 1, audios: 3, seed: "seed" },
  u24: { field: "u24WorkflowId", megapixels: [0.2, 0.25, 0.3, 0.35, 0.4], defaultMegapixels: 0.4, audios: 3, seed: "noise_seed" },
  u32: { field: "u32WorkflowId", megapixels: [0.5, 1, 1.5, 2, 2.5], defaultMegapixels: 2, audios: 0 },
  u30: { field: "u30WorkflowId", megapixels: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1], defaultMegapixels: 0.7, audios: 3, seed: "noise_seed" },
};
const aspectRatios: Record<string, string> = {
  "16:9": "16:9 (Widescreen)", "9:16": "9:16 (Portrait Widescreen)", "4:3": "4:3 (Standard)", "3:4": "3:4 (Portrait Standard)",
  "3:2": "3:2 (Photo)", "2:3": "2:3 (Portrait Photo)", "1:1": "1:1 (Square)", "21:9": "21:9 (Ultrawide)",
};
type ZealmanSnapshot = { base: string; workflowId: string; inputValues: Record<string, string | number>; clientId: string };
type ZealmanOutput = { type?: string; url?: string };
type ZealmanResponse = {
  success?: boolean; error?: unknown; status?: string; hasGPU?: boolean; running?: boolean;
  busy?: boolean; running_count?: number; pending_count?: number;
  name?: string; subfolder?: string; type?: string; prompt_id?: string; pending?: boolean; results?: ZealmanOutput[];
  api_config?: { enabledParams?: Record<string, boolean>; apiNames?: Record<string, string> };
  task?: { id?: string; prompt_id?: string; status?: string; progress?: number; error?: unknown; outputs?: ZealmanOutput[] };
};

function apiBase(context: ProviderContext) {
  const value = typeof context.config.apiUrl === "string" ? context.config.apiUrl.trim() : "";
  if (!value) throw new Error("请先在 ZEALMAN-H3 自部署设置中填写面板地址");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("面板地址须为 HTTP(S) 协议、主机和端口，不含账号密码、/api 路径或查询参数");
  }
  return url.origin;
}

async function apiRequest(context: ProviderContext, base: string, path: string, init: RequestInit = {}, timeout = 30000): Promise<ZealmanResponse> {
  const response = await context.tool.fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeout), redirect: "error", cache: "no-store" });
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`ZEALMAN-H3 响应正文为空（HTTP ${response.status}）`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("ZEALMAN-H3 接口响应超过 8 MiB 接收上限，原任务不会重新提交");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  let value: ZealmanResponse;
  try { value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { throw Object.assign(new Error(`ZEALMAN-H3 未返回有效 JSON（HTTP ${response.status}）`), { httpStatus: response.status }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ZEALMAN-H3 返回的接口数据无效");
  if (!response.ok) throw Object.assign(new Error(`ZEALMAN-H3 HTTP ${response.status}：${context.tool.errorMessage(value) || "请求失败"}`), { httpStatus: response.status });
  return value;
}

function fileBytes(input: MediaInput) {
  if (input.type === "binary") return Buffer.from(input.data);
  if (input.type !== "base64") throw new Error("上传素材需要本地图片或音频内容");
  const data = input.data.replace(/^data:[^;,]+;base64,/, "").replace(/\s/g, "");
  if (data.length > Math.ceil(100 * 1024 * 1024 / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("参考素材 Base64 无效或超过 100 MiB");
  return Buffer.from(data, "base64");
}

async function upload(context: ProviderContext, base: string, field: string, input: MediaInput) {
  if (input.type === "url") {
    const url = new URL(input.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("参考素材须使用不含账号密码或片段的 HTTP(S) 公网地址");
    return url.href;
  }
  let bytes = fileBytes(input);
  let mimeType = input.mimeType;
  const mediaType = field.startsWith("ref_image_") ? "image" : "audio";
  if (!bytes.length || bytes.length > 100 * 1024 * 1024 || !new RegExp(`^${mediaType}/[a-z0-9.+-]+$`, "i").test(mimeType)) throw new Error("参考素材为空、类型不匹配或超过 100 MiB");
  if (mediaType === "image") {
    const source: MediaInput = { type: "binary", data: bytes, mimeType };
    const info = await context.tool.media.inspectImage(source);
    if (Math.max(info.width, info.height) > 2048) {
      const scale = 2048 / Math.max(info.width, info.height);
      const resized = await context.tool.media.resizeImage(source, { width: Math.max(1, Math.round(info.width * scale)), height: Math.max(1, Math.round(info.height * scale)) });
      bytes = fileBytes(resized);
      mimeType = resized.mimeType!;
    }
  }
  const extension = ({ "image/jpeg": "jpg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-wav": "wav" } as Record<string, string>)[mimeType] ?? mimeType.split("/")[1];
  const name = `zealman${context.videoTask!.idHash}${field.replaceAll("_", "")}${context.tool.sha256(bytes).slice(0, 16)}.${extension}`;
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), name);
  form.append("overwrite", "false");
  const result = await apiRequest(context, base, "/api/comfy/upload/file", { method: "POST", body: form }, 300000);
  if (result.success === false || typeof result.name !== "string" || !result.name || (result.type !== undefined && result.type !== "input")) throw new Error("ZEALMAN-H3 未返回有效的素材文件名");
  const path = [result.subfolder, result.name].filter(Boolean).join("/");
  if (path.includes("\\") || path.startsWith("/") || path.split("/").some(part => part === "." || part === "..")) throw new Error("ZEALMAN-H3 返回的素材路径无效");
  return path;
}

async function createSnapshot(context: ProviderContext, request: VideoRequest): Promise<ZealmanSnapshot> {
  const workflow = Object.hasOwn(workflows, request.model) ? workflows[request.model] : undefined;
  if (!workflow) throw new Error("请选择 ZEALMAN-H3 预置的 U08、U06、U24、U32 或 U30 工作流");
  const base = apiBase(context);
  const configuredId = context.config[workflow.field];
  const workflowId = typeof configuredId === "string" ? configuredId.trim() : "";
  if (!workflowId || workflowId.length > 200) throw new Error("请填写所选 ZEALMAN-H3 模型对应的工作流 ID（最多 200 字符）");
  if (!request.prompt.trim() || request.prompt.length > 10000) throw new Error("ZEALMAN-H3 提示词须为 1～10000 字符，且不能全为空白");
  const images = request.images ?? [];
  const audios = request.audios ?? [];
  if (images.length > 9 || audios.length > workflow.audios) throw new Error(`此工作流最多支持 9 张图片、${workflow.audios} 段参考音频`);
  if (request.videos?.length || request.firstFrame || request.lastFrame) throw new Error("ZEALMAN-H3 预置工作流不支持参考视频或首尾帧模式");
  if (request.mode && (!Array.isArray(request.mode) || request.mode.length !== (workflow.audios ? 2 : 1) || !request.mode.includes("imageReference:9") || (workflow.audios && !request.mode.includes("audioReference:3")))) throw new Error("请选择所选 ZEALMAN-H3 模型的混合参考模式");
  if (request.generateAudio !== undefined || request.watermark !== undefined) throw new Error("ZEALMAN-H3 文档未提供声音或水印开关");
  for (const match of request.prompt.matchAll(/<(Picture|Audio)\s+(\d+)>/g)) {
    const count = match[1] === "Picture" ? images.length : audios.length;
    if (Number(match[2]) < 1 || Number(match[2]) > count) throw new Error(`提示词 ${match[0]} 没有对应的参考素材，请按实际素材顺序修改编号`);
  }
  const duration = request.duration ?? 5;
  const ratio = request.ratio ?? "16:9";
  const resolution = request.resolution ?? `${workflow.defaultMegapixels}MP`;
  const megapixels = Number(resolution.replace(/MP$/, ""));
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error("ZEALMAN-H3 时长须为 1～15 秒的整数");
  if (!Object.hasOwn(aspectRatios, ratio) || !/^\d+(?:\.\d+)?MP$/.test(resolution) || !workflow.megapixels.includes(megapixels)) throw new Error("所选工作流不支持此比例或分辨率，请使用模型提供的选项");
  if (request.seed !== undefined && (!workflow.seed || !Number.isSafeInteger(request.seed) || request.seed < 1 || request.seed > 2147483647)) throw new Error("此工作流不支持种子，或种子不在 1～2147483647 整数范围内");
  const inputValues: ZealmanSnapshot["inputValues"] = { prompt: request.prompt, value: duration };
  if (request.model === "u06") {
    const [width, height] = ratio.split(":").map(Number);
    const unit = Math.sqrt(megapixels * 1000000 / (width * height));
    inputValues.param_4 = Math.max(16, Math.round(unit * width / 16) * 16);
    inputValues.param_5 = Math.max(16, Math.round(unit * height / 16) * 16);
  } else {
    inputValues.aspect_ratio = aspectRatios[ratio];
    inputValues.megapixels = megapixels;
  }
  if (request.model === "u08") Object.assign(inputValues, { aspect_ratio_2: aspectRatios[ratio], megapixels_2: 1 });
  if (request.model === "u24") inputValues.value_2 = 1.5;
  if (workflow.seed) inputValues[workflow.seed] = request.seed ?? Math.floor(Math.random() * 2147483647) + 1;
  const references: [string, MediaInput][] = [
    ...images.map((input, index): [string, MediaInput] => [`ref_image_${index}`, input]),
    ...audios.map((input, index): [string, MediaInput] => [`ref_audio_${index}`, input]),
  ];
  const [health, gpu, status, config] = await Promise.all([
    apiRequest(context, base, "/api/health"), apiRequest(context, base, "/api/gpu/info"),
    apiRequest(context, base, "/api/comfy/status"), apiRequest(context, base, `/api/workflow/config/${encodeURIComponent(workflowId)}`),
  ]);
  if (health.status !== "ok" || gpu.hasGPU !== true || status.running !== true) throw new Error("ZEALMAN-H3 未就绪，请确认机器有 GPU，并先在面板中启动 ComfyUI");
  const enabled = config.api_config?.enabledParams;
  const names = config.api_config?.apiNames;
  if (config.success === false || !enabled || !names) throw new Error("工作流未开放 API 参数，请在面板「API 生成」页打开此工作流并保存后重试");
  const allowed = new Set(Object.entries(enabled).filter(([, value]) => value === true).map(([key]) => names[key]));
  for (const key of [...Object.keys(inputValues), ...references.map(([field]) => field)]) {
    if (!allowed.has(key)) throw new Error(`工作流未开放参数 ${key}，请核对面板「API 生成」页与所选工作流`);
  }
  for (const [field, input] of references) inputValues[field] = await upload(context, base, field, input);
  return { base, workflowId, inputValues, clientId: context.videoTask!.id };
}

async function submit(context: ProviderContext, snapshot: ZealmanSnapshot) {
  const task = context.videoTask!;
  if (task.state.phase !== "prepared") throw new Error("ZEALMAN-H3 提交受理状态尚未确认，请到面板核查；此操作不会重复提交生成");
  const queue = await apiRequest(context, snapshot.base, "/api/comfy/queue-status");
  if (queue.busy === false && queue.running_count === 0 && queue.pending_count === 0) {
    const freed = await apiRequest(context, snapshot.base, "/api/comfy/proxy/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) }, 60000);
    if (freed.success === false) throw new Error(`ZEALMAN-H3 清理显存失败：${context.tool.errorMessage(freed)}`);
  }
  context.signal?.throwIfAborted();
  // ACT: 面板未提供幂等提交协议；先保存提交状态，回执丢失时保留原操作，不自动重发。
  await task.update({ phase: "submitting", error: undefined, retryAt: undefined });
  let result: ZealmanResponse;
  try {
    result = await apiRequest(context, snapshot.base, "/api/workflow/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id: snapshot.workflowId, client_id: snapshot.clientId, input_values: snapshot.inputValues }),
    }, 120000);
  } catch (error) {
    context.signal?.throwIfAborted();
    const message = context.tool.errorMessage(error);
    if ([400, 401, 403, 404, 413, 422].includes((error as { httpStatus?: number }).httpStatus ?? 0)) await task.update({ phase: "failed", error: message });
    throw new Error(`ZEALMAN-H3 提交未完成，请核查面板任务记录。${message}`);
  }
  if (result.success !== true || typeof result.prompt_id !== "string" || !result.prompt_id.trim() || result.prompt_id.length > 2048) throw new Error(`ZEALMAN-H3 未返回有效任务编号，已保留原操作，请到面板核查。${context.tool.errorMessage(result)}`);
  await task.update({ taskId: result.prompt_id, phase: "queued", error: undefined });
}

async function wait(context: ProviderContext, milliseconds = 3000) {
  context.signal?.throwIfAborted();
  await context.videoTask!.update({ retryAt: Date.now() + milliseconds });
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(context.signal?.reason); };
    const timer = setTimeout(() => { context.signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) { context.signal.removeEventListener("abort", abort); abort(); }
  });
}

function videoUrl(base: string, outputs: ZealmanOutput[]) {
  const videos = outputs.filter(output => output.type === "video" && typeof output.url === "string" && output.url);
  if (videos.length !== 1) throw new Error("ZEALMAN-H3 任务未返回唯一视频，请保留原任务并核查面板输出");
  const url = new URL(videos[0].url!, `${base}/`);
  if (url.origin !== base || url.username || url.password || url.hash) throw new Error("ZEALMAN-H3 返回的视频地址不属于原面板，已保留原任务");
  return url.href;
}

async function poll(context: ProviderContext, snapshot: ZealmanSnapshot) {
  const task = context.videoTask!;
  const promptId = task.state.taskId!;
  const deadline = Date.now() + 30 * 60 * 1000;
  let failures = 0;
  let synced = false;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    if (task.state.retryAt && task.state.retryAt > Date.now()) await wait(context, Math.min(task.state.retryAt - Date.now(), 30000));
    let result: ZealmanResponse | undefined;
    let ledger: ZealmanResponse | undefined;
    let lookupError: unknown;
    const lookups = await Promise.allSettled([
      apiRequest(context, snapshot.base, `/api/workflow/result?prompt_id=${encodeURIComponent(promptId)}`),
      apiRequest(context, snapshot.base, `/api/tasks/${encodeURIComponent(promptId)}`),
    ]);
    if (lookups[0].status === "fulfilled") result = lookups[0].value; else lookupError = lookups[0].reason;
    if (lookups[1].status === "fulfilled") ledger = lookups[1].value; else lookupError = lookups[1].reason;
    context.signal?.throwIfAborted();
    if ((result?.prompt_id !== undefined && result.prompt_id !== promptId) || (ledger?.task?.id !== undefined && ledger.task.id !== promptId) || (ledger?.task?.prompt_id !== undefined && ledger.task.prompt_id !== promptId)) throw new Error("ZEALMAN-H3 返回的任务编号不匹配，已保留原任务");
    const status = ledger?.task?.status;
    const completed = ["done", "completed", "success"].includes(status ?? "");
    const failed = ["failed", "error", "cancelled", "canceled"].includes(status ?? "");
    if (failed || (!completed && result?.pending === false && result.success === false)) {
      const message = context.tool.errorMessage(failed ? ledger?.task?.error : result?.error) || "ZEALMAN-H3 视频生成失败";
      await task.update({ phase: "failed", error: message, retryAt: undefined });
      throw new Error(message);
    }
    const outputs = completed && Array.isArray(ledger?.task?.outputs) && ledger.task.outputs.length ? ledger.task.outputs
      : result?.pending === false && result.success === true && Array.isArray(result.results) && result.results.length ? result.results : undefined;
    if (outputs) {
      const url = videoUrl(snapshot.base, outputs);
      await task.update({ phase: "downloading", progress: 100, error: undefined, retryAt: undefined });
      return url;
    }
    if (completed && !synced) {
      const sync = await apiRequest(context, snapshot.base, "/api/tasks/sync-comfy-queue", { method: "POST" });
      if (sync.success === false) throw new Error(`ZEALMAN-H3 任务账本同步失败，原任务已保留。${context.tool.errorMessage(sync)}`);
      synced = true;
    }
    if (!(result?.success === true && result.pending === true) && !["queued", "running"].includes(status ?? "")) {
      if (++failures >= 3) throw new Error(`ZEALMAN-H3 暂时无法取得任务结果，请恢复原任务查询，不会重新生成。${context.tool.errorMessage(lookupError ?? ledger ?? result)}`);
    } else { failures = 0; }
    const progress = ledger?.task?.progress;
    await task.update({ phase: status === "running" ? "in_progress" : "queued", progress: typeof progress === "number" && Number.isFinite(progress) && progress >= 0 && progress <= 100 ? progress : undefined, error: undefined });
    await wait(context);
  }
  throw new Error("ZEALMAN-H3 本地等待已满 30 分钟，请恢复原任务继续查询，不会重新生成");
}

export default {
  id: "zealmanH3",
  label: "ZEALMAN-H3 自部署",
  version: "1.0.0",
  apiUrl: "",
  readme: "连接运行 ZEALMAN-H3 镜像的机器，填写面板 6008 端口对应的 HTTP(S) 访问地址，无需 Token；可先添加供应商，稍后填写地址。请先在面板启动 ComfyUI，并在「API 生成」页打开要用的工作流，确认已保存参数映射。预置 U08、U06-V5、U24、U32、U30，工作流 ID 可修改，但须保持对应参数协议。支持 1～15 秒、最多 9 张参考图；除 U32 外最多 3 段参考音频，不支持参考视频或首尾帧控制。本地素材从节点连接后直接上传，无需 OSS；合计最多 100 MiB，图片长边超过 2048 时等比缩小。分辨率选项为工作流像素数：U08 为一采，二采固定 1MP；U24 为一采，固定 1.5 倍放大。U06、U24、U30 可指定 1～2147483647 的 seed，留空随机并保存。提示词按英文六段式填写，中文对白可保留；`<Picture 1>`、`<Audio 1>` 分别对应第一张图、第一段音频。任务提交后保存编号并查询进度，面板账本用于重启恢复，完成后立即下载到工作区。停止等待只中断本地查询；提交回执丢失时须到面板核查，不自动重发。机器地址改变后须先核实旧任务所在机器。",
  rules,
  models: [
    { id: "u08", label: "H3 U08 · 两段采样", type: "video", mode: [["imageReference:9", "audioReference:3"]], taskRecovery: true, defaultDuration: 5, defaultResolution: "0.4MP", videoRatios: ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1", "21:9"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["0.2MP", "0.3MP", "0.4MP", "0.5MP", "0.6MP", "0.8MP", "1MP"] }] },
    { id: "u06", label: "H3 U06-V5 · 多参考", type: "video", mode: [["imageReference:9", "audioReference:3"]], taskRecovery: true, supportsSeed: true, defaultDuration: 5, defaultResolution: "1MP", videoRatios: ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1", "21:9"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["0.4MP", "0.5MP", "0.6MP", "0.8MP", "1MP", "1.2MP"] }] },
    { id: "u24", label: "H3 U24 · 文武双修 T8", type: "video", mode: [["imageReference:9", "audioReference:3"]], taskRecovery: true, supportsSeed: true, defaultDuration: 5, defaultResolution: "0.4MP", videoRatios: ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1", "21:9"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["0.2MP", "0.25MP", "0.3MP", "0.35MP", "0.4MP"] }] },
    { id: "u32", label: "H3 U32 · 图片参考", type: "video", mode: [["imageReference:9"]], taskRecovery: true, defaultDuration: 5, defaultResolution: "2MP", videoRatios: ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1", "21:9"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["0.5MP", "1MP", "1.5MP", "2MP", "2.5MP"] }] },
    { id: "u30", label: "H3 U30 · 多参考", type: "video", mode: [["imageReference:9", "audioReference:3"]], taskRecovery: true, supportsSeed: true, defaultDuration: 5, defaultResolution: "0.7MP", videoRatios: ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1", "21:9"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["0.3MP", "0.4MP", "0.5MP", "0.6MP", "0.7MP", "0.8MP", "1MP"] }] },
  ],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const task = this.videoTask;
    if (!task) throw new Error("ZEALMAN-H3 需要持久化任务支持，请从视频节点或媒体生成工具使用");
    const base = apiBase(this);
    if (task.state.phase === "failed") throw new Error(task.state.error || "ZEALMAN-H3 原任务已失败，请确认后重新生成");
    const snapshot: ZealmanSnapshot = task.requestSaved ? JSON.parse(await task.readRequest()) : await createSnapshot(this, request);
    if (snapshot.base !== base) throw new Error("请使用原 ZEALMAN-H3 面板地址恢复任务，不能切换机器后查询同一个任务");
    if (!task.requestSaved) await task.saveRequest(JSON.stringify(snapshot));
    if (!task.state.taskId) await submit(this, snapshot);
    return [await task.download(await poll(this, snapshot), {}, "publicHttpCdn")];
  },
} satisfies ProviderDefinition<typeof rules>;
