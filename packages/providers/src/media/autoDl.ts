const rules = [
  { type: "input", field: "apiKey" as const, title: "Token", value: "", props: { type: "password", showPassword: true, autocomplete: "off" }, validate: [{ required: true, message: "请填写 AutoDL ComfyUI Token" }] },
  { type: "input", field: "workflowId" as const, title: "图生视频工作流 ID", value: "minimax_h3_zm_u08", validate: [{ required: true, message: "请填写图生视频工作流 ID" }] },
  { type: "input", field: "firstLastWorkflowId" as const, title: "首尾帧工作流 ID", value: "minimax_h3_lightx2v", validate: [{ required: true, message: "请填写首尾帧工作流 ID" }] },
  { type: "input", field: "seed" as const, title: "默认 seed（选填）", value: "", props: { placeholder: "节点 seed 优先；两处留空则由平台决定" } },
];

const endpoint = "https://autodl.art/api/v1/comfyui/comfyui_workflow";
type AutoDlResponse = {
  code?: string; msg?: string; request_id?: string;
  data?: { task_id?: string; status?: string; message?: string; results?: { url?: string; type?: string; file_type?: string; output_type?: string }[] };
};
type AutoDlSnapshot = { workflowId: string; body: Record<string, string | number> };

function headers(context: ProviderContext) {
  const token = typeof context.config.apiKey === "string" ? context.config.apiKey.trim().replace(/^Bearer\s+/i, "") : "";
  if (!token) throw new Error("请在 AutoDL 供应商设置中填写 ComfyUI Token");
  return { Authorization: token, "Content-Type": "application/json" };
}

function secureUrl(value: string) {
  const url = new URL(value);
  if (value.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("AutoDL 素材须使用不含账号密码或片段的公网 HTTPS 地址");
  return value;
}

function createSnapshot(context: ProviderContext, request: VideoRequest): AutoDlSnapshot {
  const frameMode = request.model === "minimaxH3FirstLastFrame";
  const configuredWorkflowId = frameMode ? context.config.firstLastWorkflowId : context.config.workflowId;
  const workflowId = typeof configuredWorkflowId === "string" ? configuredWorkflowId.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(workflowId)) throw new Error("请填写有效的 AutoDL 工作流 ID");
  if (!request.prompt.trim() || request.prompt.length > 20000) throw new Error("AutoDL 提示词须为 1～20000 个字符，且不能全为空白");
  const duration = request.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error("AutoDL 视频时长须为 1～15 秒的整数");
  const resolution = request.resolution?.toLowerCase() ?? "768p";
  const ratio = request.ratio ?? "9:16";
  if (!["480p", "768p"].includes(resolution) || !["9:16", "16:9", "1:1"].includes(ratio)) throw new Error("AutoDL 仅支持 480p、768p，以及 9:16、16:9、1:1 比例");
  const images = request.images ?? [];
  const audios = request.audios ?? [];
  if (frameMode) {
    if (!request.firstFrame || !request.lastFrame) throw new Error("AutoDL 首尾帧视频需要同时提供首帧和尾帧图片");
    if (images.length || audios.length || request.videos?.length) throw new Error("AutoDL 首尾帧模式只接受两张帧图片，不支持额外参考图片、音频或视频");
    if (request.mode && request.mode !== "startEndRequired") throw new Error("请选择 AutoDL 的首尾帧必填模式");
  } else {
    if (!images.length || images.length > 9 || audios.length > 3) throw new Error("AutoDL 图生视频需要 1～9 张参考图片，最多 3 段参考音频");
    if (request.videos?.length || request.firstFrame || request.lastFrame) throw new Error("此 AutoDL 工作流不支持参考视频或首尾帧模式");
    if (request.mode && (!Array.isArray(request.mode) || request.mode.length !== 2 || !request.mode.includes("imageReference:9") || !request.mode.includes("audioReference:3"))) throw new Error("请选择 AutoDL 的图片与音频混合参考模式");
  }
  if (request.generateAudio !== undefined || request.watermark !== undefined) throw new Error("此 AutoDL 工作流未提供声音或水印开关");
  const body: AutoDlSnapshot["body"] = { prompt: request.prompt, duration, resolution: `${resolution}${ratio === "9:16" ? "竖" : ratio === "16:9" ? "横" : "(1:1)"}` };
  const rawSeed = request.seed ?? (typeof context.config.seed === "string" ? context.config.seed.trim() : context.config.seed);
  if (rawSeed !== undefined && rawSeed !== null && rawSeed !== "") {
    if (typeof rawSeed !== "number" && (typeof rawSeed !== "string" || !/^-?\d+$/.test(rawSeed.trim()))) throw new Error("seed 须为安全整数，留空使用平台默认值");
    const seed = Number(rawSeed);
    if (!Number.isSafeInteger(seed)) throw new Error("seed 须为 JavaScript 安全整数");
    body.seed = seed;
  }
  const references: [string, MediaInput][] = frameMode
    ? [["first_frame", request.firstFrame!], ["last_frame", request.lastFrame!]]
    : [...images.map((input, index): [string, MediaInput] => [`ref_image_${index}`, input]), ...audios.map((input, index): [string, MediaInput] => [`ref_audio_${index}`, input])];
  for (const [field, input] of references) {
    if (input.type !== "url") throw new Error("AutoDL 参考素材需要公网链接，请在素材存储中启用 OSS 后使用本地图片和音频");
    body[field] = secureUrl(input.url);
  }
  return { workflowId, body };
}

async function readJson(response: Response): Promise<AutoDlResponse> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) throw new Error("AutoDL 回执超过接收上限，已保留原任务");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  try {
    const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* 非 JSON 回执不能证明任务未受理，不重发创建请求。 */ }
  return {};
}

function responseMessage(context: ProviderContext, response: Response, value: AutoDlResponse) {
  const requestId = typeof value.request_id === "string" ? value.request_id.slice(0, 200) : "";
  return context.tool.errorMessage([
    `AutoDL HTTP ${response.status}`, typeof value.code === "string" ? value.code : "",
    context.tool.errorMessage(value), requestId ? `请求编号：${requestId}` : "",
  ].filter(Boolean).join("；"));
}

async function wait(context: ProviderContext, milliseconds: number) {
  context.signal?.throwIfAborted();
  await context.videoTask!.update({ retryAt: Date.now() + milliseconds });
  if (milliseconds > 60000) throw new Error(`AutoDL 要求等待 ${Math.ceil(milliseconds / 1000)} 秒，请稍后恢复原任务`);
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(context.signal?.reason); };
    const timer = setTimeout(() => { context.signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) { context.signal.removeEventListener("abort", abort); abort(); }
  });
}

async function submit(context: ProviderContext, snapshot: AutoDlSnapshot) {
  const task = context.videoTask!;
  if (task.state.phase !== "prepared") throw new Error("AutoDL 提交受理状态尚未确认且没有任务编号，请到平台核查；此操作不会重新提交生成");
  for (const [field, value] of Object.entries(snapshot.body)) {
    if (!/^(ref_(image|audio)_\d+|first_frame|last_frame)$/.test(field) || typeof value !== "string") continue;
    const params = new URL(secureUrl(value)).searchParams;
    if (params.get("x-oss-signature-version") !== "OSS4-HMAC-SHA256") continue;
    const timestamp = params.get("x-oss-date")?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
    const expiresAt = Date.parse(timestamp ?? "") + Number(params.get("x-oss-expires")) * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 60000) {
      const error = "OSS 参考素材链接已过期或即将过期，尚未提交 AutoDL 任务；请重新生成以取得新链接，手填链接请先更新";
      await task.update({ phase: "failed", error, retryAt: undefined });
      throw new Error(error);
    }
  }
  // ACT: AutoDL 未公布幂等协议；先保存提交状态，回执丢失时停止，避免重复付费生成。
  const requestHeaders = headers(context);
  context.signal?.throwIfAborted();
  await task.update({ phase: "submitting", error: undefined, retryAt: undefined });
  let response: Response;
  let value: AutoDlResponse;
  try {
    response = await context.tool.fetch(`${endpoint}/${encodeURIComponent(snapshot.workflowId)}`, {
      method: "POST", headers: requestHeaders, body: JSON.stringify(snapshot.body), signal: AbortSignal.timeout(60000), redirect: "error",
    });
    value = await readJson(response);
  } catch (error) {
    context.signal?.throwIfAborted();
    throw new Error(`AutoDL 提交回执中断，已保留原操作，不会自动重发。${context.tool.errorMessage(error)}`);
  }
  const taskId = value.data?.task_id;
  if (response.ok && value.code === "Success" && typeof taskId === "string" && taskId.trim() && taskId.length <= 2048) {
    await task.update({ taskId, phase: "queued", error: undefined });
    return;
  }
  const message = responseMessage(context, response, value);
  const rejected = [400, 401, 402, 403, 404, 413, 422].includes(response.status) && !taskId;
  await task.update({ ...(rejected ? { phase: "failed" as const } : {}), error: message });
  throw new Error(rejected ? message : `AutoDL 受理状态未确认，已保留原操作，请到平台核查。${message}`);
}

async function poll(context: ProviderContext): Promise<string> {
  const task = context.videoTask!;
  const requestHeaders = headers(context);
  const deadline = Date.now() + 30 * 60 * 1000;
  let failures = 0;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    if (task.state.retryAt && task.state.retryAt > Date.now()) await wait(context, task.state.retryAt - Date.now());
    let response: Response;
    let value: AutoDlResponse;
    try {
      response = await context.tool.fetch(`${endpoint}/result/${encodeURIComponent(task.state.taskId!)}`, { headers: requestHeaders, signal: AbortSignal.timeout(30000), redirect: "error", cache: "no-store" });
      value = await readJson(response);
    } catch (error) {
      context.signal?.throwIfAborted();
      if (++failures >= 3) throw new Error(`AutoDL 查询中断，请恢复原任务。${context.tool.errorMessage(error)}`);
      await wait(context, failures * 5000);
      continue;
    }
    if (!response.ok || value.code !== "Success") {
      if ([408, 429].includes(response.status) || response.status >= 500) {
        const header = response.headers.get("retry-after");
        const delay = header ? /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now() : 0;
        const milliseconds = Math.max(++failures * 5000, Number.isFinite(delay) ? delay : 0);
        await task.update({ retryAt: Date.now() + milliseconds });
        if (failures < 3) { await wait(context, milliseconds); continue; }
      }
      throw new Error(`AutoDL 原任务已保留，请稍后恢复查询。${responseMessage(context, response, value)}`);
    }
    failures = 0;
    if (!value.data || value.data.task_id !== task.state.taskId) throw new Error("AutoDL 返回的任务编号不匹配，已保留原任务");
    const status = typeof value.data.status === "string" ? value.data.status.toLowerCase() : "";
    if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) {
      const message = responseMessage(context, response, value);
      await task.update({ phase: "failed", error: message, retryAt: undefined });
      throw new Error(message);
    }
    if (["success", "completed"].includes(status)) {
      const results = Array.isArray(value.data.results) ? value.data.results.filter(result => result && result.type === "video" && (!result.output_type || result.output_type === "output") && (!result.file_type || typeof result.file_type === "string" && result.file_type.toLowerCase() === "mp4")) : [];
      if (results.length !== 1 || typeof results[0]?.url !== "string" || !results[0].url) throw new Error("AutoDL 任务已完成但未返回唯一的 MP4 视频输出，请保留原任务核查");
      const url = secureUrl(results[0].url);
      await task.update({ phase: "downloading", progress: 100, error: undefined, retryAt: undefined });
      return url;
    }
    if (!["queued", "running"].includes(status)) throw new Error("AutoDL 返回未知任务状态，已保留原任务，请稍后恢复查询");
    await task.update({ phase: status === "queued" ? "queued" : "in_progress", progress: undefined, error: undefined });
    await wait(context, 5000);
  }
  throw new Error("AutoDL 本地等待已满 30 分钟，请恢复原任务继续查询，不会重新生成");
}

export default {
  id: "autoDl",
  label: "AutoDL 图生视频",
  version: "1.1.0",
  apiUrl: "https://autodl.art",
  readme: "使用 ComfyUI 分组的 Token，两个模型共用 Token 和默认 seed，各自配置工作流 ID。图生视频默认 minimax_h3_zm_u08，支持 1～9 张图片、0～3 段音频；首尾帧视频默认 minimax_h3_lightx2v，首帧和尾帧均必填，不支持额外参考图、音频或视频。两者均支持 1～15 秒、480p/768p、9:16、16:9、1:1，仅适用于各自相同参数协议的工作流。图片可填 HTTPS 直链；本地图片和音频从画布节点连接，在「设置 → 素材存储」启用 OSS 后上传。首尾帧按图片节点在前、链接在后的顺序使用两张图片。图片支持 PNG/JPEG/WebP，音频支持 MP3/WAV/FLAC/MP4 音频容器，单个本地素材最多 20 MiB，合计 300 MiB。节点 seed 优先于此处默认值，0 有效，两处留空则不传。工作流、素材和 seed 按首次提交快照恢复；任务受理回执丢失时不会重复提交，请到平台核查。结果链接有效期较短，成功后立即下载保存。接口说明：https://autodl.art/docs/comfyui_api/",
  rules,
  models: [{
    id: "minimaxH3", label: "MiniMax H3 图生视频", type: "video",
    mode: [["imageReference:9", "audioReference:3"]], referenceImageInput: "url", referenceAudioInput: "url", supportsSeed: true, minReferenceImages: 1,
    taskRecovery: true, videoRatios: ["9:16", "16:9", "1:1"],
    durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768p", "480p"] }],
  }, {
    id: "minimaxH3FirstLastFrame", label: "MiniMax H3 首尾帧视频", type: "video",
    mode: ["startEndRequired"], referenceImageInput: "url", supportsSeed: true,
    defaultDuration: 5, defaultResolution: "768p",
    taskRecovery: true, videoRatios: ["9:16", "16:9", "1:1"],
    durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768p", "480p"] }],
  }],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const task = this.videoTask;
    if (!task) throw new Error("AutoDL 需要持久化任务支持，请从视频节点或媒体生成工具使用");
    headers(this);
    if (task.state.phase === "failed") throw new Error(task.state.error || "AutoDL 原任务已失败，请确认后发起新生成");
    if (!task.state.taskId) {
      const snapshot: AutoDlSnapshot = task.requestSaved ? JSON.parse(await task.readRequest()) : createSnapshot(this, request);
      if (!task.requestSaved) await task.saveRequest(JSON.stringify(snapshot));
      await submit(this, snapshot);
    }
    for (let attempt = 0; ; attempt++) {
      const url = await poll(this);
      try { return [await task.download(url, {}, "publicCdn")]; }
      catch (error) {
        this.signal?.throwIfAborted();
        if (attempt >= 1 || ![401, 403, 404, 410].includes((error as { httpStatus?: number }).httpStatus ?? 0)) throw error;
        await wait(this, 5000);
      }
    }
  },
} satisfies ProviderDefinition<typeof rules>;
