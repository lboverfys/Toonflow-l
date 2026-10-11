const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "apiUrl" as const, title: "API 地址", value: "http://vidgate.top:18080" },
];

const ratios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
type VidGateResponse = Record<string, any>;

function wait(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function apiBase(context: ProviderContext) {
  const apiKey = String(context.config.apiKey ?? "").trim().replace(/^Bearer\s+/i, "").trim();
  if (!apiKey) throw new Error("请在 VidGate 设置中填写 API Key");
  const base = new URL(String(context.config.apiUrl).trim());
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash || !["/", "/v1", "/v1/"].includes(base.pathname)) {
    throw new Error("VidGate API 地址须为 HTTP 或 HTTPS 站点根地址；端口写在域名后，例如 http://vidgate.top:18080");
  }
  return { base: base.origin, headers: { Authorization: `Bearer ${apiKey}` } };
}

function referenceUrl(input: MediaInput) {
  if (input.type !== "url") throw new Error("VidGate 只接受公网 HTTPS 图片直链；文档未提供本地图片上传接口，请在视频节点填写参考图链接");
  const url = new URL(input.url);
  if (input.url.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("VidGate 参考图须为不含账号密码或片段的公网 HTTPS 直链");
  return input.url;
}

async function readJson(response: Response): Promise<VidGateResponse> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) throw new Error("VidGate 回执超过大小限制，已保留原操作，请核查站点任务记录");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  try {
    const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* 非 JSON 正文不作为受理回执，不重放创建请求。 */ }
  return {};
}

function retryDelay(response: Response, failures: number) {
  const header = response.headers.get("retry-after");
  const delay = header ? /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now() : 0;
  return Math.max(20000 * 2 ** failures, Number.isFinite(delay) ? delay : 0);
}

function responseMessage(context: ProviderContext, response: Response, value: VidGateResponse) {
  const code = value.error?.code ?? value.code;
  const requestId = response.headers.get("x-oneapi-request-id");
  return context.tool.errorMessage([
    `VidGate HTTP ${response.status}${typeof code === "string" && code ? ` / ${code}` : ""}`,
    context.tool.errorMessage(value.error ?? value.message), requestId ? `请求编号：${requestId}` : "",
  ].filter(Boolean).join("；"));
}

function requestBody(request: VideoRequest) {
  const durations = request.model === "seedance_v2.5" ? [5, 10, 15, 30] : request.model === "seedance_v2.0_std" ? [5, 10, 15] : undefined;
  if (!durations) throw new Error("VidGate 模型 ID 不正确，请选择 seedance_v2.5 或 seedance_v2.0_std");
  if (!request.prompt.trim()) throw new Error("请输入视频提示词");
  const seconds = request.duration ?? 5;
  if (!durations.includes(seconds)) throw new Error(`此 VidGate 模型可选 ${durations.join("、")} 秒；2.0 不提供 30 秒选项，避免渠道自动切换到 2.5`);
  const ratio = request.ratio ?? "9:16";
  if (!ratios.includes(ratio)) throw new Error("VidGate 不支持所选比例，请按模型选项选择");
  if (request.videos?.length || request.audios?.length || request.firstFrame || request.lastFrame) throw new Error("VidGate 不支持音视频参考或首尾帧模式，请使用参考图链接");
  if (request.generateAudio !== undefined || request.watermark !== undefined) throw new Error("VidGate 文档未提供声音或水印开关，请使用渠道默认设置");
  if (request.resolution && !/^\d{3,4}p$/.test(request.resolution)) throw new Error("VidGate 分辨率请使用 720p 等格式");
  const images = request.images ?? [];
  if (images.length > 9) throw new Error("VidGate 最多使用 9 张参考图片");
  if (request.mode && request.mode !== "text" && !(Array.isArray(request.mode) && request.mode.length === 1 && request.mode[0] === "imageReference:9")) throw new Error("VidGate 仅支持文生视频和图片参考模式");
  return JSON.stringify({
    model: request.model, prompt: request.prompt, seconds, ratio,
    ...(request.resolution ? { resolution: request.resolution } : {}),
    ...(images.length ? { reference_images: images.map(referenceUrl) } : {}),
  });
}

async function submit(context: ProviderContext, body: string) {
  const task = context.videoTask!;
  if (task.state.phase !== "prepared") throw new Error("VidGate 原提交回执尚未确认，未保存任务编号。渠道文档未提供幂等或回执找回接口，请凭本地操作编号及错误中的请求编号核查站点记录；此操作不会补发生成");
  const { base, headers } = apiBase(context);
  await task.update({ phase: "submitting", error: undefined, retryAt: undefined });
  let response: Response;
  let value: VidGateResponse;
  let requestId: string | null = null;
  try {
    // VidGate 未声明幂等协议。创建任务只发送一次；请求中断不代表渠道没有受理。
    response = await context.tool.fetch(`${base}/v1/videos`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(60000), redirect: "error",
    });
    requestId = response.headers.get("x-oneapi-request-id");
    value = await readJson(response);
  } catch (error) {
    context.signal?.throwIfAborted();
    throw new Error(context.tool.errorMessage(`VidGate 提交回执中断，已保留原操作且不会自动重发，请核查站点记录。${context.tool.errorMessage(error)}${requestId ? `；请求编号：${requestId}` : ""}`));
  }
  const ids = [value.id, value.task_id].filter((id): id is string => typeof id === "string" && !!id.trim() && id.length <= 2048);
  if (response.ok && ids.length && ids.every(id => id === ids[0])) {
    await task.update({ taskId: ids[0], phase: "queued", error: undefined });
    return;
  }
  const message = responseMessage(context, response, value);
  const code = value.error?.code ?? value.code;
  const rejected = response.status === 401 || response.status === 403
    || (response.status === 400 && ["invalid_request", "unsupported_model"].includes(code))
    || (response.status === 503 && code === "model_not_found");
  if (rejected) await task.update({ phase: "failed", error: message });
  else await task.update({ error: `受理结果未确认，请核查站点记录，不要再次生成。${message}` });
  throw new Error(rejected ? message : `VidGate 受理结果未确认，原操作已保留，不会自动重发。${message}`);
}

async function poll(context: ProviderContext) {
  const task = context.videoTask!;
  const { base, headers } = apiBase(context);
  const deadline = Date.now() + 30 * 60 * 1000;
  let failures = 0;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    let response: Response;
    let value: VidGateResponse;
    try {
      response = await context.tool.fetch(`${base}/v1/videos/${encodeURIComponent(task.state.taskId!)}`, { headers, signal: AbortSignal.timeout(30000), redirect: "error" });
      value = await readJson(response);
    } catch (error) {
      context.signal?.throwIfAborted();
      if (++failures >= 3) throw new Error(`VidGate 查询中断，请恢复原任务继续查询。${context.tool.errorMessage(error)}`);
      await wait(20000 * failures, context.signal);
      continue;
    }
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        const delay = retryDelay(response, failures++);
        await task.update({ retryAt: Date.now() + delay });
        if (failures < 3 && delay <= 60000) { await wait(delay, context.signal); continue; }
      }
      throw new Error(`原视频任务已保留，请稍后恢复查询。${responseMessage(context, response, value)}`);
    }
    failures = 0;
    if (![value.id, value.task_id].some(id => id === task.state.taskId)
      || [value.id, value.task_id].some(id => id !== undefined && id !== task.state.taskId)) throw new Error("VidGate 查询返回的任务编号不匹配，已保留原任务");
    if (value.status === "failed") {
      const message = responseMessage(context, response, value);
      await task.update({ phase: "failed", error: message, retryAt: undefined });
      throw new Error(message);
    }
    if (value.status === "completed") {
      await task.update({ phase: "downloading", progress: 100, error: undefined, retryAt: undefined });
      return value;
    }
    if (!["queued", "in_progress"].includes(value.status)) throw new Error("VidGate 返回未知任务状态，已保留原任务，请稍后恢复查询");
    const progress = typeof value.progress === "number" && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100 ? value.progress : undefined;
    await task.update({ phase: value.status, progress, error: undefined, retryAt: undefined });
    await wait(Math.min(20000, Math.max(1, deadline - Date.now())), context.signal);
  }
  throw new Error("VidGate 本地已等待 30 分钟，原任务已保留；恢复后继续查询同一任务，不会重新生成");
}

export default {
  id: "vidGate",
  label: "VidGate",
  version: "1.0.0",
  apiUrl: "http://vidgate.top:18080",
  readme: "填写 API Key 即可使用 VidGate，API 地址可修改。当前入口为 HTTP，密钥与请求会以明文传输；如站点提供 HTTPS，请改用 HTTPS 地址。Seedance 2.5 支持 5/10/15/30 秒，Seedance 2.0 fast 支持 5/10/15 秒。文档标价均为 1.5/次，实际以站点账户计费为准。最多 9 张参考图，仅接受公网 HTTPS 图片直链，在视频节点逐行填写；文档未提供本地素材上传接口，不接受 Base64 或本机路径。异步提交后每 20 秒查询，任务编号持久保存，等待或下载中断可恢复原任务。渠道未声明幂等协议，提交回执丢失时不会自动补发生成，须到站点核查。优先认证下载成片，网关取片返回 502 时使用任务成片直链，密钥不会发送给 CDN。",
  rules,
  models: [
    { id: "seedance_v2.5", label: "Dreamina Seedance 2.5 · 最长 30 秒", type: "video", mode: ["text", ["imageReference:9"]], referenceImageInput: "url", taskRecovery: true, videoRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], durationResolutionMap: [{ duration: [5, 10, 15, 30], resolution: ["720p"] }] },
    { id: "seedance_v2.0_std", label: "Dreamina Seedance 2.0 fast · 最长 15 秒", type: "video", mode: ["text", ["imageReference:9"]], referenceImageInput: "url", taskRecovery: true, videoRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], durationResolutionMap: [{ duration: [5, 10, 15], resolution: ["720p"] }] },
  ],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const task = this.videoTask;
    if (!task) throw new Error("VidGate 需要持久化任务支持，请从视频节点或媒体生成工具使用");
    const { base, headers } = apiBase(this);
    if (task.state.phase === "failed") throw new Error(task.state.error || "VidGate 原任务已失败，请确认后再发起新生成");
    if (task.state.retryAt && task.state.retryAt > Date.now()) throw new Error(`VidGate 要求退避，请在 ${Math.ceil((task.state.retryAt - Date.now()) / 1000)} 秒后恢复原任务`);
    let body: string;
    if (task.requestSaved) body = await task.readRequest();
    else {
      body = requestBody(request);
      await task.saveRequest(body);
    }
    if (!task.state.taskId) await submit(this, body);
    await poll(this);
    try { return [await task.download(`${base}/v1/videos/${encodeURIComponent(task.state.taskId!)}/content`, headers, "gateway")]; }
    catch (error) {
      this.signal?.throwIfAborted();
      if (![301, 302, 303, 307, 308, 502].includes((error as { httpStatus?: number }).httpStatus ?? 0)) throw error;
      const completed = await poll(this);
      const link = completed.video?.url;
      if (typeof link !== "string" || !link) throw new Error("VidGate 网关取片失败且未返回成片直链，请恢复原任务重新查询");
      const url = new URL(link);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("VidGate 成片直链无效，已保留原任务");
      return [await task.download(link, {}, "publicHttpCdn")];
    }
  },
} satisfies ProviderDefinition<typeof rules>;
