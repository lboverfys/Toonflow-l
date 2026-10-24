const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" }, validate: [{ required: true, message: "请填写逸仙 API Key" }] },
  { type: "input", field: "apiUrl" as const, title: "API 地址", value: "https://yixian.lol" },
];

const ratios = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
const mediaLimits = { image: 20 * 1024 * 1024, audio: 64 * 1024 * 1024, video: 100 * 1024 * 1024 };
const extensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/flac": "flac", "audio/ogg": "ogg",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};

type YixianResponse = {
  success?: boolean;
  id?: string;
  status?: string;
  progress?: number;
  error?: unknown;
  message?: string;
  data?: { asset?: { id?: string; media_type?: string } };
};
type YixianSnapshot = { base: string; body: { model: string; parameters: Record<string, unknown> } };

async function readBytes(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`逸仙接口返回空正文（HTTP ${response.status}）`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("逸仙接口响应超过接收上限");
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("逸仙接口响应超过接收上限");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, size);
}

async function apiRequest(context: ProviderContext, url: string, headers: Record<string, string>, init: RequestInit = {}) {
  const response = await context.tool.fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(init.method === "POST" ? 300000 : 30000), redirect: "error", cache: "no-store" });
  const bytes = await readBytes(response, 1024 * 1024);
  let value: YixianResponse;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`逸仙接口未返回有效 JSON（HTTP ${response.status}），请保留原任务核查`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("逸仙接口返回的数据格式无效");
  return { response, value };
}

function responseMessage(context: ProviderContext, response: Response, value: YixianResponse) {
  return context.tool.errorMessage(`逸仙 HTTP ${response.status}：${context.tool.errorMessage(value) || "接口未返回有效结果"}`);
}

async function createSnapshot(context: ProviderContext, base: string, headers: Record<string, string>, request: VideoRequest): Promise<YixianSnapshot> {
  const isU06 = request.model === "yixian-h3-u06";
  if (!isU06 && request.model !== "yixian-h3-u08") throw new Error("请选择逸仙 H3 极速版 U08 或质量版 U06");
  if (!request.prompt.trim() || request.prompt.length > 20000) throw new Error("逸仙提示词须为 1～20000 个字符，且不能全为空白");
  const images = request.images ?? [];
  const videos = request.videos ?? [];
  const audios = request.audios ?? [];
  if (images.length > 9 || audios.length > 3 || videos.length > (isU06 ? 3 : 0)) throw new Error("逸仙 H3 最多支持 9 张图片、3 段音频，只有 U06 支持最多 3 段视频");
  if (audios.length && !images.length && !videos.length) throw new Error("使用音频参考时必须同时提供图片或视频参考");
  if (request.firstFrame || request.lastFrame) throw new Error("逸仙 H3 U08/U06 不支持首尾帧模式，请使用混合参考模式");
  if (request.mode && request.mode !== "text" && !Array.isArray(request.mode)) throw new Error("逸仙 H3 仅支持文生视频或混合参考模式");
  if (request.mode === "text" && images.length + videos.length + audios.length) throw new Error("文生视频模式不能携带参考素材，请选择混合参考模式");
  if (request.generateAudio !== undefined || request.watermark !== undefined || request.resolution || Object.keys(request.other ?? {}).length) throw new Error("逸仙 H3 的画质、声音和其他高级参数由服务端配置，请使用当前模型提供的选项");
  const duration = request.duration ?? 10;
  const ratio = request.ratio ?? "16:9";
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error("逸仙 H3 时长须为 1～15 秒的整数");
  if (!ratios.includes(ratio)) throw new Error("逸仙 H3 不支持此画面比例");
  if (request.seed !== undefined && (!isU06 || !Number.isSafeInteger(request.seed) || request.seed < 0 || request.seed > 2 ** 50)) throw new Error("只有逸仙 U06 支持 seed，范围为 0～1125899906842624 的整数");
  for (const match of request.prompt.matchAll(/<(Picture|Video|Audio)\s+(\d+)>/g)) {
    const count = match[1] === "Picture" ? images.length : match[1] === "Video" ? videos.length : audios.length;
    if (Number(match[2]) < 1 || Number(match[2]) > count) throw new Error(`提示词 ${match[0]} 没有对应的参考素材`);
  }
  const references: { field: string; mediaType: keyof typeof mediaLimits; input: MediaInput }[] = [
    ...images.map((input, index) => ({ field: `ref_image_${index}`, mediaType: "image" as const, input })),
    ...videos.map((input, index) => ({ field: `ref_video_${index}`, mediaType: "video" as const, input })),
    ...audios.map((input, index) => ({ field: `ref_audio_${index}`, mediaType: "audio" as const, input })),
  ];
  const uploads: { field: string; mediaType: string; bytes: Uint8Array; mimeType: string; extension: string }[] = [];
  let total = 0;
  for (const { field, mediaType, input } of references) {
    const limit = mediaLimits[mediaType];
    let bytes: Uint8Array;
    let mimeType = input.mimeType?.split(";")[0].toLowerCase() ?? "";
    if (input.type === "url") {
      const url = new URL(input.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("参考素材须使用不含账号密码或片段的 HTTPS 地址");
      const response = await context.tool.fetch(url, { signal: AbortSignal.timeout(60000), redirect: "error" });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`读取参考素材失败（HTTP ${response.status}）`); }
      mimeType ||= response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? "";
      bytes = await readBytes(response, limit);
    } else if (input.type === "binary") bytes = input.data;
    else {
      const data = input.data.replace(/^data:[^;,]+;base64,/, "").replace(/\s/g, "");
      if (data.length > Math.ceil(limit / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("参考素材 Base64 无效或超过大小限制");
      bytes = Buffer.from(data, "base64");
    }
    const extension = extensions[mimeType];
    if (!bytes.byteLength || bytes.byteLength > limit || !extension || !mimeType.startsWith(`${mediaType}/`)) throw new Error(`参考素材类型无效、为空或超过 ${limit / 1024 / 1024} MiB`);
    total += bytes.byteLength;
    if (total > 100 * 1024 * 1024) throw new Error("逸仙参考素材合计不能超过 Toonflow 的 100 MiB 传输上限");
    uploads.push({ field, mediaType, bytes, mimeType, extension });
  }
  const parameters: Record<string, unknown> = { prompt: request.prompt, duration, aspect_ratio: ratio };
  if (request.seed !== undefined) parameters.seed = request.seed;
  for (const { field, mediaType, bytes, mimeType, extension } of uploads) {
    const form = new FormData();
    form.append("media_type", mediaType);
    form.append("file", new Blob([Buffer.from(bytes)], { type: mimeType }), `${field}.${extension}`);
    const { response, value } = await apiRequest(context, `${base}/v1/media`, headers, { method: "POST", body: form });
    const asset = value.data?.asset;
    if (!response.ok || value.success !== true || typeof asset?.id !== "string" || !asset.id.trim() || asset.id.length > 2048 || asset.media_type !== mediaType) throw new Error(responseMessage(context, response, value));
    parameters[field] = { asset_id: asset.id };
  }
  return { base, body: { model: request.model, parameters } };
}

async function wait(context: ProviderContext, milliseconds: number) {
  context.signal?.throwIfAborted();
  await context.videoTask!.update({ retryAt: Date.now() + milliseconds });
  if (milliseconds > 60000) throw new Error(`逸仙接口要求等待 ${Math.ceil(milliseconds / 1000)} 秒，请稍后恢复原任务`);
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(context.signal?.reason); };
    const timer = setTimeout(() => { context.signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) { context.signal.removeEventListener("abort", abort); abort(); }
  });
}

export default {
  id: "yixianVideo",
  label: "逸仙视频",
  version: "1.0.0",
  apiUrl: "https://yixian.lol",
  readme: "逸仙 API 的 MINIMAX-H3 极速版 U08 / 质量版 U06，支持 1～15 秒，默认 10 秒。U08 支持最多 9 张参考图片、3 段参考音频；U06 额外支持最多 3 段参考视频及 seed（0 有效）。音频必须搭配图片或视频。连接画布素材节点或在 H3 编辑器上传，图片上限 20 MiB、音频 64 MiB、视频及全部素材合计 100 MiB。素材直接上传逸仙，无需 OSS；提示词使用 <Picture 1>、<Audio 1>、<Video 1> 引用。画质与高级参数使用服务端配置。中断后恢复原任务，不会重复提交；若提交回执丢失且无任务编号，请到逸仙视频专栏核查。",
  rules,
  models: [{
    id: "yixian-h3-u08", label: "MINIMAX-H3 极速版 U08", type: "video",
    mode: ["text", ["imageReference:9", "audioReference:3"]], taskRecovery: true, defaultDuration: 10,
    videoRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
    durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: [] }],
  }, {
    id: "yixian-h3-u06", label: "MINIMAX-H3 质量版 U06", type: "video",
    mode: ["text", ["imageReference:9", "videoReference:3", "audioReference:3"]], taskRecovery: true, supportsSeed: true, defaultDuration: 10,
    videoRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
    durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: [] }],
  }],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const task = this.videoTask;
    if (!task) throw new Error("逸仙视频需要持久化任务支持，请从视频节点或媒体生成工具使用");
    const apiKey = this.config.apiKey.trim().replace(/^Bearer\s+/i, "").trim();
    if (!apiKey) throw new Error("请填写逸仙 API Key");
    const url = new URL(this.config.apiUrl.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) throw new Error("逸仙 API 地址须为 HTTPS 站点根地址或 /v1 地址");
    const base = url.origin;
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (task.state.phase === "failed") throw new Error(task.state.error || "逸仙原任务已失败，请确认后发起新生成");
    if (task.state.retryAt && task.state.retryAt > Date.now()) await wait(this, task.state.retryAt - Date.now());
    if (!task.state.taskId) {
      if (task.state.phase !== "prepared") throw new Error("逸仙提交受理状态尚未确认且没有任务编号，请到视频专栏核查；恢复不会重新提交生成");
      const snapshot: YixianSnapshot = task.requestSaved ? JSON.parse(await task.readRequest()) : await createSnapshot(this, base, headers, request);
      if (snapshot.base !== base) throw new Error("恢复任务须使用原逸仙 API 地址");
      if (!task.requestSaved) await task.saveRequest(JSON.stringify(snapshot));
      // ACT: 逸仙未提供提交幂等查询；提交前持久化状态，回执丢失时停止，避免重复付费生成。
      this.signal?.throwIfAborted();
      await task.update({ phase: "submitting", retryAt: undefined, error: undefined });
      const { response, value } = await apiRequest(this, `${base}/v1/videos`, headers, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot.body) });
      if (!response.ok || typeof value.id !== "string" || !value.id.trim() || value.id.length > 2048) {
        const message = responseMessage(this, response, value);
        const rejected = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status) && !value.id;
        await task.update({ ...(rejected ? { phase: "failed" as const } : {}), error: message });
        throw new Error(message);
      }
      await task.update({ taskId: value.id, phase: "queued", error: undefined });
    }
    const taskUrl = `${base}/v1/videos/${encodeURIComponent(task.state.taskId!)}`;
    const deadline = Date.now() + 30 * 60 * 1000;
    let failures = 0;
    while (task.state.phase !== "downloading") {
      this.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("逸仙本地等待已满 30 分钟，请恢复原任务继续查询");
      let result: Awaited<ReturnType<typeof apiRequest>>;
      try { result = await apiRequest(this, taskUrl, headers); }
      catch (error) {
        this.signal?.throwIfAborted();
        if (++failures >= 3) throw error;
        await wait(this, failures * 5000);
        continue;
      }
      const { response, value } = result;
      if (!response.ok) {
        if ([408, 429].includes(response.status) || response.status >= 500) {
          const header = response.headers.get("retry-after");
          const delay = header ? /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now() : 0;
          const milliseconds = Math.max(++failures * 5000, Number.isFinite(delay) ? delay : 0);
          await task.update({ retryAt: Date.now() + milliseconds });
          if (failures < 3) { await wait(this, milliseconds); continue; }
        }
        throw new Error(responseMessage(this, response, value));
      }
      failures = 0;
      if (value.id !== task.state.taskId) throw new Error("逸仙返回的任务编号不匹配，已保留原任务");
      if (value.status === "failed") {
        const error = this.tool.errorMessage(value) || "逸仙视频生成失败";
        await task.update({ phase: "failed", error, retryAt: undefined });
        throw new Error(error);
      }
      if (value.status === "completed") { await task.update({ phase: "downloading", progress: 100, retryAt: undefined, error: undefined }); break; }
      if (!["queued", "in_progress"].includes(value.status ?? "")) throw new Error("逸仙返回未知任务状态，已保留原任务，请稍后恢复查询");
      const progress = typeof value.progress === "number" && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100 ? value.progress : undefined;
      await task.update({ phase: value.status === "queued" ? "queued" : "in_progress", progress, retryAt: undefined, error: undefined });
      await wait(this, 5000);
    }
    return [await task.download(`${taskUrl}/content`, headers, "gateway")];
  },
} satisfies ProviderDefinition<typeof rules>;
