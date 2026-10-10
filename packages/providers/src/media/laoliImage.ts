const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "apiUrl" as const, title: "API 地址", value: "https://video.laoliimage2.win" },
];
const modelIds = ["gpt-image-2.5", "gpt-image-2.5-sr-flare", "gpt-image-2.5-sr-sunburst", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "seedream-v5-pro", "nano-banana-2", "nano-banana-pro"];
const imageLimit = 25 * 1024 * 1024;
const resultLimit = 100 * 1024 * 1024;

function wait(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryDelay(response: Response, value: Record<string, any>) {
  const header = response.headers.get("retry-after");
  const milliseconds = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 0;
  return Math.max(5000, Number.isFinite(milliseconds) ? milliseconds : 0, typeof value.retry_after === "number" && Number.isFinite(value.retry_after) ? value.retry_after * 1000 : 0);
}

async function responseBytes(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("图片接口响应超过本地接收预算"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片接口响应为空");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("图片接口响应超过本地接收预算");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, length);
}

async function readJson(response: Response): Promise<Record<string, any>> {
  const bytes = await responseBytes(response, response.ok ? 140 * 1024 * 1024 : 16000);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* 无效响应不能当作任务失败或未提交。 */ }
  throw new Error(`图片接口返回了无效回执（HTTP ${response.status}），请恢复原任务`);
}

function imageMime(bytes: Uint8Array) {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  const text = header.toString("ascii");
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(text)) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (text.slice(4, 8) === "ftyp" && /avif|avis/.test(text.slice(8))) return "image/avif";
  if (text.startsWith("BM")) return "image/bmp";
  if (header.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || header.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))) return "image/tiff";
  throw new Error("内容不是支持的原始图片，未转换或保存为伪造格式");
}

function decodeImage(data: string, limit: number) {
  const raw = (data.match(/^data:[^;,]+;base64,([\s\S]+)$/)?.[1] ?? data).replace(/\s/g, "");
  if (raw.length > Math.ceil(limit / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 === 1) throw new Error("图片 Base64 无效或超过传输预算");
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length || bytes.length > limit) throw new Error("图片为空或超过传输预算");
  return bytes;
}

function imageUrl(value: string) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) || url.username || url.password) throw new Error("图片地址须为 HTTPS；本机模拟接口可使用 HTTP");
  return url;
}

async function referenceImage(context: ProviderContext, input: MediaInput) {
  let bytes: Uint8Array;
  if (input.type === "base64") bytes = decodeImage(input.data, imageLimit);
  else if (input.type === "binary") bytes = input.data;
  else {
    const response = await context.tool.fetch(imageUrl(input.url), { signal: AbortSignal.timeout(30000), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`读取参考图失败（HTTP ${response.status}）`); }
    bytes = await responseBytes(response, imageLimit);
  }
  if (!bytes.byteLength || bytes.byteLength > imageLimit) throw new Error("参考图为空或超过当前 25 MiB 单图传输预算");
  return { bytes, data: `data:${imageMime(bytes)};base64,${Buffer.from(bytes).toString("base64")}` };
}

function responseMessage(context: ProviderContext, response: Response, value: Record<string, any>) {
  const code = value.error?.code ?? value.error?.type ?? value.code;
  const trace = ["x-request-id", "x-trace-id", "request-id"].flatMap(name => response.headers.has(name) ? [`${name}: ${response.headers.get(name)}`] : []);
  return context.tool.errorMessage([`HTTP ${response.status}${code ? ` / ${String(code)}` : ""}`, context.tool.errorMessage(value), ...trace].filter(Boolean).join("；"));
}

async function completedAssets(context: ProviderContext, assets: ImageTaskAsset[], apiUrl: string, headers: Record<string, string>): Promise<MediaAsset[]> {
  const results: MediaAsset[] = [];
  const cached: ImageTaskAsset[] = [];
  for (const asset of assets) {
    let bytes: Uint8Array;
    if (asset.type === "base64") bytes = decodeImage(asset.data, resultLimit);
    else {
      const url = imageUrl(asset.url);
      const response = await context.tool.fetch(url, { headers: url.origin === apiUrl ? headers : undefined, signal: AbortSignal.timeout(120000), redirect: "error" });
      if (!response.ok) {
        const value = await readJson(response);
        if (response.headers.has("retry-after")) await context.imageTask!.update({ retryAt: Date.now() + retryDelay(response, value) });
        throw new Error(`原图下载中断，请恢复原任务。${responseMessage(context, response, value)}`);
      }
      bytes = await responseBytes(response, resultLimit);
    }
    const mimeType = imageMime(bytes);
    results.push({ type: "binary", data: bytes, mimeType, mediaType: "image" });
    if (asset.type === "url") cached.push({ type: "base64", data: Buffer.from(bytes).toString("base64"), mimeType, mediaType: "image" });
  }
  if (cached.length) await context.imageTask!.saveResult(cached);
  return results;
}

export default {
  id: "laoliImage",
  label: "老李生图",
  icon: "",
  version: "1.0.0",
  apiUrl: "https://video.laoliimage2.win",
  readme: "8 个图片模型，支持文生图和参考图编辑。1K/2K/4K 为请求档位，实际像素以上游原图为准；不强制 PNG、不放大或压缩。每次生成 1 张。超分型号基础价 0.02/0.03/0.04 元，原生 Flare/Sunburst 与 Seedream 0.12 元，Banana 2 为 0.18 元、Pro 为 0.23 元，再乘账户倍率。使用持久化异步接口，中断后恢复原任务；结果缓存完成后保留 3 小时，请尽快保存。密钥仅在此配置中填写。",
  rules,
  models: [
    { id: "gpt-image-2.5", label: "gpt-image-2.5 · Flare 超分兼容 ID", type: "image", mode: ["text", "singleImage", "multiReference"], taskRecovery: true, imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "9:21", "21:9"] },
    { id: "gpt-image-2.5-sr-flare", label: "gpt-image-2.5-sr-flare · Flare 超分", type: "image", mode: ["text", "singleImage", "multiReference"], taskRecovery: true, imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "9:21", "21:9"] },
    { id: "gpt-image-2.5-sr-sunburst", label: "gpt-image-2.5-sr-sunburst · Sunburst 超分", type: "image", mode: ["text", "singleImage", "multiReference"], taskRecovery: true, imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "9:21", "21:9"] },
    { id: "gpt-image-2.5-flare", label: "gpt-image-2.5-flare · Flare 原生", type: "image", mode: ["text", "singleImage", "multiReference"], taskRecovery: true, imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "9:21", "21:9"] },
    { id: "gpt-image-2.5-sunburst", label: "gpt-image-2.5-sunburst · Sunburst 原生", type: "image", mode: ["text", "singleImage", "multiReference"], taskRecovery: true, imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "9:21", "21:9"] },
    { id: "seedream-v5-pro", label: "seedream-v5-pro · Seedream v5 Pro", type: "image", mode: ["text", "singleImage", "multiReference"], taskRecovery: true, imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "9:21", "21:9"] },
    { id: "nano-banana-2", label: "nano-banana-2 · Nano Banana 2", type: "image", mode: ["text", "singleImage", "multiReference"], taskRecovery: true, imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "9:21", "21:9"] },
    { id: "nano-banana-pro", label: "nano-banana-pro · Nano Banana Pro", type: "image", mode: ["text", "singleImage", "multiReference"], taskRecovery: true, imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "9:21", "21:9"] },
  ],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const task = this.imageTask;
    if (!task) throw new Error("老李生图需要宿主持久化操作记录，请在图片节点中生成");
    const apiKey = String(this.config.apiKey).trim().replace(/^Bearer\s+/i, "").trim();
    if (!apiKey) throw new Error("请填写老李生图 API Key");
    const base = imageUrl(String(this.config.apiUrl).trim());
    if (base.search || base.hash || !["/", "/v1", "/v1/"].includes(base.pathname)) throw new Error("API 地址须为站点根地址或 /v1");
    const apiUrl = base.origin;
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (["failed", "expired"].includes(task.state.phase)) throw new Error(task.state.error || "原图片任务已结束");
    if (task.state.retryAt && task.state.retryAt > Date.now()) throw new Error(`请在 ${Math.ceil((task.state.retryAt - Date.now()) / 1000)} 秒后恢复原图片任务`);
    const cached = await task.readResult();
    if (cached) return completedAssets(this, cached, apiUrl, headers);
    let saved: { endpoint: string; body: string };
    if (task.requestSaved) saved = await task.readRequest();
    else {
      if (!modelIds.includes(request.model)) throw new Error("老李生图模型 ID 不匹配");
      if (!request.prompt.trim()) throw new Error("请输入图片提示词");
      if (request.n !== undefined && request.n !== 1) throw new Error("此图片节点每次生成 1 张");
      if (request.mask) throw new Error("请使用图片节点的局部重绘功能，保留本地蒙版合成");
      const images: string[] = [];
      let total = 0;
      for (const input of request.images ?? []) {
        const image = await referenceImage(this, input);
        total += image.bytes.byteLength;
        if (total > 32 * 1024 * 1024) throw new Error("参考图合计超过当前 32 MiB 传输预算");
        images.push(image.data);
      }
      const pixels = request.size?.match(/^(\d+)x(\d+)$/);
      if (pixels && request.ratio) {
        const [width, height] = request.ratio.split(":").map(Number);
        if (Number(pixels[1]) * height! !== Number(pixels[2]) * width!) throw new Error("自定义宽高与比例冲突，请修改后生成");
      }
      const body = JSON.stringify({
        model: request.model, prompt: request.prompt, n: 1, response_format: "b64_json",
        ...(request.size ? /^[124]K$/.test(request.size) ? { resolution: request.size } : { size: request.size } : {}),
        ...(request.ratio ? { aspect_ratio: request.ratio } : {}),
        ...(request.quality ? { quality: request.quality } : {}),
        ...(request.outputFormat ? { output_format: request.outputFormat } : {}),
        ...(images.length ? { images } : {}),
      });
      if (Buffer.byteLength(body) > 45 * 1024 * 1024) throw new Error("请求超过当前 45 MiB 异步接收预算");
      saved = { endpoint: images.length ? "/v1/images/edits/async" : "/v1/images/generations/async", body };
      await task.saveRequest(saved);
    }
    if (!task.state.taskId) {
      if ((task.state.submissions ?? 0) >= 3) throw new Error("原回执仍未确认，已停止幂等确认请求；请携原操作编号联系渠道核查，不要换编号重投");
      await task.update({ phase: "submitting", submissions: (task.state.submissions ?? 0) + 1, error: undefined, retryAt: undefined });
      let response: Response;
      let value: Record<string, any>;
      try {
        response = await this.tool.fetch(`${apiUrl}${saved.endpoint}`, {
          method: "POST", headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": task.id },
          body: saved.body, signal: AbortSignal.timeout(120000), redirect: "error",
        });
        value = await readJson(response);
      } catch (error) {
        await task.update({ retryAt: Date.now() + 5000 });
        this.signal?.throwIfAborted();
        throw new Error(`提交回执待核实；恢复只使用原入口、原幂等编号和原内容。${this.tool.errorMessage(error)}`);
      }
      const taskId = typeof value.request_id === "string" && value.request_id.trim() ? value.request_id : undefined;
      if (taskId) await task.update({ taskId, phase: "accepted" });
      if (!response.ok) {
        const message = responseMessage(this, response, value);
        if (!taskId && [400, 401, 402, 413, 422].includes(response.status)) await task.update({ phase: "failed", error: message });
        else await task.update({ retryAt: Date.now() + retryDelay(response, value) });
        throw new Error(`图片提交未完成。${message}`);
      }
      if (!taskId) { await task.update({ retryAt: Date.now() + retryDelay(response, value) }); throw new Error("受理响应缺少 request_id，已保留原请求，请恢复幂等确认"); }
      // 回放可能直接返回 completed，立即保存结果，避免跨过三小时缓存期限。
      if (value.state === "completed") {
        const assets = resultAssets(value);
        await task.saveResult(assets);
        return completedAssets(this, assets, apiUrl, headers);
      }
      await task.update({ retryAt: Date.now() + retryDelay(response, value) });
      if (value.poll_url) {
        const poll = new URL(value.poll_url, apiUrl);
        if (poll.origin !== apiUrl || poll.pathname !== `/v1/images/tasks/${encodeURIComponent(taskId)}` || poll.search || poll.hash || poll.username || poll.password) throw new Error("回执查询地址不可信；已保存任务编号，恢复将使用原站点查询");
        await task.update({ pollUrl: poll.href });
      }
    }
    while (true) {
      if (task.state.retryAt && task.state.retryAt > Date.now()) await wait(task.state.retryAt - Date.now(), this.signal);
      const response = await this.tool.fetch(`${apiUrl}/v1/images/tasks/${encodeURIComponent(task.state.taskId!)}`, { headers, signal: AbortSignal.timeout(120000), redirect: "error" });
      const value = await readJson(response);
      if (response.status === 410 || value.state === "expired") {
        const error = "原图结果缓存已过期，不代表生成失败或退款；请到渠道核查原订单";
        await task.update({ phase: "expired", error, retryAt: undefined }); throw new Error(error);
      }
      if (!response.ok) {
        await task.update({ retryAt: Date.now() + retryDelay(response, value) });
        throw new Error(`查询中断，保留原任务；404 也不代表未生成。${responseMessage(this, response, value)}`);
      }
      if (value.request_id && value.request_id !== task.state.taskId) throw new Error("图片查询回执编号不匹配，已保留原任务");
      if (["error", "failed"].includes(value.state)) {
        const error = responseMessage(this, response, value);
        await task.update({ phase: "failed", error, retryAt: undefined }); throw new Error(error);
      }
      if (value.state === "completed") {
        const assets = resultAssets(value);
        await task.saveResult(assets);
        return completedAssets(this, assets, apiUrl, headers);
      }
      if (!["accepted", "queued", "submitting", "processing", "reconciling", "settling"].includes(value.state)) throw new Error("渠道返回未知图片状态，已保留原任务，请稍后恢复核查");
      await task.update({ phase: value.state, retryAt: Date.now() + retryDelay(response, value), error: undefined });
    }
  },
} satisfies ProviderDefinition<typeof rules>;

function resultAssets(value: Record<string, any>): ImageTaskAsset[] {
  const data = value.result?.data;
  if (!Array.isArray(data) || data.length !== 1) throw new Error("已完成回执未包含预期的一张原图，保留原任务，未补发生成");
  return data.map(item => {
    if (typeof item?.b64_json === "string" && item.b64_json) return { type: "base64", data: item.b64_json, mimeType: item.mime_type ?? "", mediaType: "image" };
    if (typeof item?.url === "string" && item.url) return { type: "url", url: imageUrl(item.url).href, mimeType: item.mime_type ?? "", mediaType: "image" };
    throw new Error("图片回执缺少原图 Base64 或 URL，保留原任务");
  });
}
