const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "apiUrl" as const, title: "API 地址", value: "https://ai.fanke2026.xyz" },
];

const modelLimits: Record<string, { minDuration: number; maxDuration: number; resolutions: string[]; ratios: string[]; images: number; audios: number }> = {
  "ft-video-v1-77e8ee7a636f15dac27b2ce6d6fcd746": { minDuration: 1, maxDuration: 15, resolutions: ["768p"], ratios: ["16:9", "4:3", "1:1", "3:4", "9:16"], images: 9, audios: 3 },
  "ft-video-v1-17c3294027e987b8f50f78a8c525d650": { minDuration: 4, maxDuration: 15, resolutions: ["768p", "2k"], ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"], images: 9, audios: 0 },
  "ft-video-v1-69ef4c70291248a25c8198cd1c7c9c1f": { minDuration: 4, maxDuration: 30, resolutions: ["720p"], ratios: ["9:16", "16:9", "1:1", "4:3", "3:4"], images: 9, audios: 0 },
  "ft-video-v1-fe82aee0b8ce5ee1d790a56291dc5563": { minDuration: 4, maxDuration: 30, resolutions: ["720p"], ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], images: 30, audios: 10 },
};
// ACT: 原始素材合计限制为 90 MiB，使 Base64 快照低于宿主的 128 MiB 上限；更大素材需先支持流式快照。
const referenceLimit = 90 * 1024 * 1024;
type FankeSnapshot = {
  fields: { model: string; prompt: string; duration: number; resolution: string; ratio: string };
  files: { field: "images" | "audios"; data: string; mimeType: string; name: string }[];
};
type FankeResponse = {
  success?: boolean; jobId?: string; status?: string; videoUrl?: string; contentUrl?: string;
  pollAfterSeconds?: number; progress?: number; error?: unknown; errorMessage?: string;
};

function secureUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Foke Video 地址须使用 HTTPS，且不能包含账号密码或片段");
  return url;
}

function apiConfig(context: ProviderContext) {
  const apiKey = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "").trim();
  if (!apiKey) throw new Error("请在 Foke Video 设置中填写 API Key");
  const url = secureUrl(String(context.config.apiUrl).trim());
  if (url.search || !["/", "/api/open/v1", "/api/open/v1/"].includes(url.pathname)) throw new Error("Foke Video API 地址须为站点根地址或以 /api/open/v1 结尾的地址");
  return { base: `${url.origin}/api/open/v1`, headers: { Authorization: `Bearer ${apiKey}`, "X-Public-Model-Ids": "1" } };
}

async function responseBytes(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Foke Video 响应超过本地接收上限"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Foke Video 响应正文为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Foke Video 响应超过本地接收上限");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, size);
}

async function readJson(response: Response): Promise<FankeResponse> {
  if (!response.body) return {};
  const bytes = await responseBytes(response, 128 * 1024);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* 非 JSON 响应不作为受理回执，不重发生成。 */ }
  return {};
}

function responseMessage(context: ProviderContext, response: Response, value: FankeResponse) {
  return context.tool.errorMessage(`Foke Video HTTP ${response.status}：${context.tool.errorMessage(value.errorMessage ?? value.error) || "接口未提供具体原因"}`);
}

function pollDelay(response?: Response, value?: FankeResponse) {
  const header = response?.headers.get("retry-after");
  const retryAfter = header ? /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now() : 0;
  const pollAfter = typeof value?.pollAfterSeconds === "number" && Number.isFinite(value.pollAfterSeconds) ? value.pollAfterSeconds * 1000 : 0;
  return Math.max(30000, Number.isFinite(retryAfter) ? retryAfter : 0, pollAfter);
}

async function waitForPoll(context: ProviderContext, milliseconds: number) {
  context.signal?.throwIfAborted();
  await context.videoTask!.update({ retryAt: Date.now() + milliseconds });
  if (milliseconds > 60000) throw new Error(`Foke Video 要求等待 ${Math.ceil(milliseconds / 1000)} 秒，已保留原任务，请稍后恢复查询`);
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(context.signal?.reason); };
    const timer = setTimeout(() => { context.signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) { context.signal.removeEventListener("abort", abort); abort(); }
  });
}

async function createSnapshot(context: ProviderContext, request: VideoRequest): Promise<FankeSnapshot> {
  const limits = Object.hasOwn(modelLimits, request.model) ? modelLimits[request.model]! : undefined;
  if (!limits) throw new Error("请选择 Foke Video 当前接入的 4 个特价视频模型");
  if (!request.prompt.trim()) throw new Error("请输入视频提示词");
  const duration = request.duration ?? limits.minDuration;
  const resolution = request.resolution ?? limits.resolutions[0]!;
  const ratio = request.ratio ?? "9:16";
  if (!Number.isInteger(duration) || duration < limits.minDuration || duration > limits.maxDuration) throw new Error(`此 Foke Video 模型支持 ${limits.minDuration}～${limits.maxDuration} 秒整数时长`);
  if (!limits.resolutions.includes(resolution) || !limits.ratios.includes(ratio)) throw new Error("Foke Video 不支持所选分辨率或画面比例，请按当前模型的选项选择");
  if (request.videos?.length || request.firstFrame || request.lastFrame) throw new Error("这 4 个 Foke Video 模型不支持参考视频或首尾帧模式");
  if (request.generateAudio !== undefined || request.watermark !== undefined) throw new Error("Foke Video 文档未提供声音或水印开关，请使用渠道默认设置");
  if ((request.images?.length ?? 0) > limits.images || (request.audios?.length ?? 0) > limits.audios) throw new Error(`此 Foke Video 模型最多支持 ${limits.images} 张图片、${limits.audios} 个音频参考`);
  const snapshot: FankeSnapshot = { fields: { model: request.model, prompt: request.prompt, duration, resolution, ratio }, files: [] };
  let total = 0;
  for (const [field, type, inputs] of [["images", "image", request.images], ["audios", "audio", request.audios]] as const) {
    for (const [index, input] of (inputs ?? []).entries()) {
      context.signal?.throwIfAborted();
      let bytes: Uint8Array;
      let mimeType = input.mimeType ?? "";
      if (input.type === "binary") bytes = input.data;
      else if (input.type === "base64") {
        const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(input.data);
        const data = (match?.[2] ?? input.data).replace(/\s/g, "");
        if (data.length > Math.ceil((referenceLimit - total) / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("参考素材 Base64 无效或合计超过本地 90 MiB 传输上限");
        bytes = Buffer.from(data, "base64");
        mimeType = match?.[1] ?? mimeType;
      } else {
        const response = await context.tool.fetch(secureUrl(input.url), { signal: AbortSignal.timeout(30000), redirect: "error" });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`读取参考素材失败（HTTP ${response.status}）`); }
        bytes = await responseBytes(response, referenceLimit - total);
        mimeType = response.headers.get("content-type")?.split(";")[0].trim() || mimeType;
      }
      total += bytes.byteLength;
      if (!bytes.byteLength || total > referenceLimit) throw new Error("参考素材为空或合计超过本地 90 MiB 传输上限");
      if (!new RegExp(`^${type}/[a-z0-9.+-]+$`, "i").test(mimeType)) throw new Error(`参考素材类型须为 ${type}`);
      const extension = ({ "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-wav": "wav" } as Record<string, string>)[mimeType] ?? mimeType.split("/")[1]!;
      snapshot.files.push({ field, data: Buffer.from(bytes).toString("base64"), mimeType, name: `${type}${index + 1}.${extension}` });
    }
  }
  return snapshot;
}

async function submit(context: ProviderContext, snapshot: FankeSnapshot) {
  const task = context.videoTask!;
  if (task.state.phase !== "prepared") throw new Error("Foke Video 原提交未取得 jobId，受理结果尚未确认；接口不保证重复提交去重，请到站点任务中心核查，此操作不会补发生成");
  const { base, headers } = apiConfig(context);
  let body: string | FormData;
  const requestHeaders: Record<string, string> = { ...headers };
  if (snapshot.files.length) {
    const form = new FormData();
    for (const [name, value] of Object.entries(snapshot.fields)) form.append(name, String(value));
    for (const file of snapshot.files) form.append(file.field, new Blob([Buffer.from(file.data, "base64")], { type: file.mimeType }), file.name);
    body = form;
  } else {
    body = JSON.stringify(snapshot.fields);
    requestHeaders["Content-Type"] = "application/json";
  }
  context.signal?.throwIfAborted();
  await task.update({ phase: "submitting", error: undefined, retryAt: undefined });
  let response: Response;
  let value: FankeResponse;
  try {
    response = await context.tool.fetch(`${base}/video/generate`, { method: "POST", headers: requestHeaders, body, signal: AbortSignal.timeout(120000), redirect: "error" });
    value = await readJson(response);
  } catch (error) {
    context.signal?.throwIfAborted();
    throw new Error(`Foke Video 提交回执中断，已保留原操作，请核查站点任务记录，不会自动重发。${context.tool.errorMessage(error)}`);
  }
  if (response.ok && value.success === true && typeof value.jobId === "string" && value.jobId.trim() && value.jobId.length <= 2048) {
    await task.update({ taskId: value.jobId, phase: "queued", error: undefined, retryAt: Date.now() + pollDelay(response, value) });
    return;
  }
  const message = responseMessage(context, response, value);
  const rejected = [400, 401, 402, 403, 413, 422].includes(response.status);
  await task.update({ ...(rejected ? { phase: "failed" as const } : {}), error: message });
  throw new Error(rejected ? message : `Foke Video 受理结果未确认，已保留原操作，不会自动重发。${message}`);
}

async function poll(context: ProviderContext) {
  const task = context.videoTask!;
  const { base, headers } = apiConfig(context);
  const deadline = Date.now() + 60 * 60 * 1000;
  let failures = 0;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    if (task.state.retryAt && task.state.retryAt > Date.now()) await waitForPoll(context, task.state.retryAt - Date.now());
    const url = new URL(`${base}/video/status`);
    url.searchParams.set("jobId", task.state.taskId!);
    url.searchParams.set("_t", String(Date.now()));
    let response: Response;
    let value: FankeResponse;
    try {
      response = await context.tool.fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(90000), redirect: "error" });
      value = await readJson(response);
    } catch (error) {
      context.signal?.throwIfAborted();
      await task.update({ retryAt: Date.now() + 30000 });
      if (++failures >= 3) throw new Error(`Foke Video 查询中断，请稍后恢复原任务。${context.tool.errorMessage(error)}`);
      continue;
    }
    if (!response.ok || value.success !== true) {
      await task.update({ retryAt: Date.now() + pollDelay(response, value) });
      if (([408, 429].includes(response.status) || response.status >= 500) && ++failures < 3) continue;
      throw new Error(`原视频任务已保留，请稍后恢复查询。${responseMessage(context, response, value)}`);
    }
    failures = 0;
    if (value.jobId !== task.state.taskId) throw new Error("Foke Video 查询回执的 jobId 与原任务不匹配，已保留原任务");
    if (value.status === "failed") {
      const message = responseMessage(context, response, value);
      await task.update({ phase: "failed", error: message, retryAt: undefined });
      throw new Error(message);
    }
    if (value.status === "success") {
      const link = value.videoUrl || value.contentUrl;
      if (typeof link !== "string" || !link) throw new Error("Foke Video 任务已完成但缺少成片地址，请保留 jobId 联系平台，不要重新生成");
      secureUrl(link);
      await task.update({ phase: "downloading", progress: 100, error: undefined, retryAt: undefined });
      return { link, delay: pollDelay(response, value) };
    }
    if (value.status !== "submitted") throw new Error("Foke Video 返回未知任务状态，请保留原任务核查");
    const progress = typeof value.progress === "number" && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100 ? value.progress : undefined;
    await task.update({ phase: "in_progress", progress, error: undefined, retryAt: Date.now() + pollDelay(response, value) });
  }
  throw new Error("Foke Video 本地等待已满 60 分钟，请恢复原任务继续查询，不会重新生成");
}

export default {
  id: "fankeVideo",
  label: "Foke Video 视频",
  version: "1.0.0",
  apiUrl: "https://ai.fanke2026.xyz",
  readme: "接入指定的 4 个特价视频模型，填写本站 API Key 即可使用。MiniMax H3-768p：1～15 秒、最多 9 图及 3 个音频；MiniMax H3 768p-2k：4～15 秒、最多 9 图；Seedance 2.5：4～30 秒，9 图版不支持音频，30 图版最多 10 个音频。均支持文生视频，不支持参考视频或首尾帧模式，声音由渠道决定。本地图片、音频通过同一次 multipart 请求上传，按各自顺序对应 @image1、@audio1，无需 OSS；原始素材合计最多 90 MiB，以保证可保存任务快照，渠道仍会校验格式、大小和时长。使用标准 API 和公共模型编号，保存 jobId 后按至少 30 秒间隔查询并遵守服务端等待时间。等待或下载中断后恢复原任务；签名链接过期时重新查询，下载不附带 API Key。渠道不保证重复提交去重，提交回执丢失时须到站点任务中心核查，不会自动补发付费生成。实际价格与权限以本站账户为准。文档：https://ai.fanke2026.xyz/studio#api",
  rules,
  models: [
    { id: "ft-video-v1-77e8ee7a636f15dac27b2ce6d6fcd746", label: "特价渠道 MiniMax H3-768p", type: "video", mode: ["text", ["imageReference:9", "audioReference:3"]], taskRecovery: true, videoRatios: ["16:9", "4:3", "1:1", "3:4", "9:16"], durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768p"] }] },
    { id: "ft-video-v1-17c3294027e987b8f50f78a8c525d650", label: "特价渠道 MiniMax H3 768p-2k", type: "video", mode: ["text", ["imageReference:9"]], taskRecovery: true, videoRatios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"], durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768p", "2k"] }] },
    { id: "ft-video-v1-69ef4c70291248a25c8198cd1c7c9c1f", label: "特价渠道 Seedance 2.5 满血 720p (9图)", type: "video", mode: ["text", ["imageReference:9"]], taskRecovery: true, videoRatios: ["9:16", "16:9", "1:1", "4:3", "3:4"], durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["720p"] }] },
    { id: "ft-video-v1-fe82aee0b8ce5ee1d790a56291dc5563", label: "特价渠道 Seedance 2.5 满血 720p (30图)", type: "video", mode: ["text", ["imageReference:30", "audioReference:10"]], taskRecovery: true, videoRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["720p"] }] },
  ],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const task = this.videoTask;
    if (!task) throw new Error("Foke Video 需要持久化任务支持，请从视频节点或媒体生成工具使用");
    apiConfig(this);
    if (task.state.phase === "failed") throw new Error(task.state.error || "Foke Video 原任务已失败，请确认后发起新生成");
    if (task.state.retryAt && task.state.retryAt > Date.now()) throw new Error(`Foke Video 要求等待，请在 ${Math.ceil((task.state.retryAt - Date.now()) / 1000)} 秒后恢复原任务`);
    if (!task.state.taskId) {
      const snapshot: FankeSnapshot = task.requestSaved ? JSON.parse(await task.readRequest()) : await createSnapshot(this, request);
      if (!task.requestSaved) {
        const body = JSON.stringify(snapshot);
        if (Buffer.byteLength(body) > 128 * 1024 * 1024) throw new Error("Foke Video 请求快照超过本地 128 MiB 上限，请减少参考素材");
        await task.saveRequest(body);
      }
      await submit(this, snapshot);
    }
    for (let attempt = 0; ; attempt++) {
      const result = await poll(this);
      try { return [await task.download(result.link, {}, "publicCdn")]; }
      catch (error) {
        this.signal?.throwIfAborted();
        if (attempt >= 1 || ![401, 403, 404, 409].includes((error as { httpStatus?: number }).httpStatus ?? 0)) throw error;
        await waitForPoll(this, result.delay);
      }
    }
  },
} satisfies ProviderDefinition<typeof rules>;
