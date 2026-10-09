const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "apiUrl" as const, title: "API 地址", value: "https://video.laoliimage2.win" },
];

const modelId = "特价2.5需要过人脸技术-可参考过人脸素材库";
const imageLimit = 50 * 1024 * 1024;
const imageTotalLimit = 70 * 1024 * 1024;

function wait(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryDelay(response: Response, attempt: number) {
  const header = response.headers.get("retry-after");
  const seconds = header && /^\d+$/.test(header) ? Number(header) : header ? (Date.parse(header) - Date.now()) / 1000 : 0;
  return Math.min(60000, Math.max(5000 * (attempt + 1), Number.isFinite(seconds) ? seconds * 1000 : 0));
}

async function readJson(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* 非 JSON 错误页不作为任务回执。 */ }
  return { error: { message: `视频接口返回了无效响应（HTTP ${response.status}）` } };
}

function errorDetails(value: Record<string, any>) {
  // 普通特价的额度错误可能包装在 message 中的 JSON 字符串里。
  if (value.code === "fail_to_fetch_task" && typeof value.message === "string") {
    try { const parsed = JSON.parse(value.message); if (parsed?.error) return parsed.error; } catch { /* 保留外层错误。 */ }
  }
  return value.error && typeof value.error === "object" ? value.error : value;
}

async function imageBytes(context: ProviderContext, input: MediaInput) {
  let bytes: Uint8Array;
  if (input.type === "binary") bytes = input.data;
  else if (input.type === "base64") {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(input.data);
    const data = (match?.[2] ?? input.data).replace(/\s/g, "");
    if (data.length > Math.ceil(imageLimit / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("参考图片 Base64 无效或超过 50 MiB");
    bytes = Buffer.from(data, "base64");
  } else {
    const url = new URL(input.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("参考图片地址无效");
    const response = await context.tool.fetch(url, { signal: AbortSignal.timeout(30000), redirect: "error" });
    if (!response.ok) throw new Error(`读取参考图片失败（HTTP ${response.status}）`);
    if (Number(response.headers.get("content-length")) > imageLimit) { await response.body?.cancel(); throw new Error("参考图片超过 50 MiB"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("参考图片为空");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > imageLimit) throw new Error("参考图片超过 50 MiB");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    bytes = Buffer.concat(chunks, size);
  }
  if (!bytes.byteLength || bytes.byteLength > imageLimit) throw new Error("参考图片为空或超过 50 MiB");
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 12));
  const png = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const webp = header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP";
  if (!png && !jpeg && !webp) throw new Error("老李特价 2.5 仅接受 PNG、JPEG 或 WebP 原图");
  return bytes;
}

export default {
  id: "laoliVideo",
  label: "老李视频",
  version: "1.0.0",
  apiUrl: "https://video.laoliimage2.win",
  readme: "特价 2.5：16～30 秒整数时长、720p，最多 30 张 PNG/JPEG/WebP 图片，不支持视频和音频参考。基础价 2 元/条，再乘账户或分组倍率。每次点击新生成都会产生独立任务；中断后请恢复原任务。此型号没有人脸开关。密钥仅在配置中填写。",
  rules,
  models: [{
    id: "特价2.5需要过人脸技术-可参考过人脸素材库",
    label: "特价 2.5 · 16～30 秒 · 720p",
    type: "video",
    mode: ["text", ["imageReference:30"]],
    taskRecovery: true,
    durationResolutionMap: [{ duration: [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["720p"] }],
  }],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const task = this.videoTask;
    if (!task) throw new Error("此模型需要支持任务恢复的 Toonflow，请在视频节点中生成，不能通过无持久化记录的调试入口创建任务");
    const apiKey = String(this.config.apiKey).trim().replace(/^Bearer\s+/i, "").trim();
    if (!apiKey) throw new Error("请填写老李视频 API Key");
    const base = new URL(String(this.config.apiUrl).trim());
    if ((base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) || base.username || base.password || base.search || base.hash || !["/", "/v1", "/v1/"].includes(base.pathname)) throw new Error("API 地址须为 HTTPS 站点根地址；本机模拟接口可使用 HTTP");
    const apiUrl = base.origin;
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (task.state.phase === "failed") throw new Error(task.state.error || "原任务已失败，请确认后发起新生成");
    let body: string;
    if (task.requestSaved) body = await task.readRequest();
    else {
      if (request.model !== modelId) throw new Error("老李视频模型 ID 不匹配");
      if (!request.prompt.trim() || [...request.prompt].length > 15000) throw new Error("提示词须为 1～15000 个字符");
      if (!Number.isInteger(request.duration) || request.duration! < 16 || request.duration! > 30) throw new Error("特价 2.5 时长须为 16～30 的整数秒");
      if (request.resolution !== "720p") throw new Error("特价 2.5 仅支持 720p");
      if (!request.ratio || request.ratio.length > 64) throw new Error("请填写画面比例");
      if (request.videos?.length || request.audios?.length || request.firstFrame || request.lastFrame) throw new Error("特价 2.5 仅支持图片参考，不支持音视频参考或首尾帧模式");
      if ((request.images?.length ?? 0) > 30) throw new Error("特价 2.5 最多使用 30 张参考图片");
      const images: string[] = [];
      let total = 0;
      for (const input of request.images ?? []) {
        const bytes = await imageBytes(this, input);
        total += bytes.byteLength;
        if (total > imageTotalLimit) throw new Error("参考图片合计不能超过 70 MiB");
        images.push(Buffer.from(bytes).toString("base64"));
      }
      body = JSON.stringify({ model: modelId, prompt: request.prompt, duration: request.duration, resolution: "720p", ratio: request.ratio, images });
      if (Buffer.byteLength(body) > 128 * 1024 * 1024) throw new Error("请求体不能超过 128 MiB");
      await task.saveRequest(body);
    }
    if (!task.state.taskId) {
      await task.update({ phase: "submitting", error: undefined });
      for (let attempt = 0; attempt < 3; attempt++) {
        let response: Response;
        try {
          response = await this.tool.fetch(`${apiUrl}/v1/videos`, {
            method: "POST", headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": task.id },
            body, signal: AbortSignal.timeout(120000), redirect: "error",
          });
        } catch (error) {
          this.signal?.throwIfAborted();
          if (attempt === 2) throw new Error("提交回执尚未确认，已保留原请求；请稍后恢复，不能重新生成");
          await wait(5000 * (attempt + 1), this.signal);
          continue;
        }
        const value = await readJson(response);
        const id = value.id ?? value.task_id;
        if (response.ok && typeof id === "string" && id.trim()) {
          await task.update({ taskId: id, phase: "queued" });
          break;
        }
        const details = errorDetails(value);
        const code = details.code ?? details.type;
        const message = this.tool.errorMessage(details) || `提交失败（HTTP ${response.status}）`;
        const uncertain = details.submitted !== false && (code === "idempotency_in_progress" || response.ok || [408, 429].includes(response.status) || response.status >= 500);
        if (!uncertain) {
          // 同键冲突不能当作明确未提交；仍保留原操作供核查。
          if (code !== "idempotency_conflict") await task.update({ phase: "failed", error: message });
          throw new Error(message);
        }
        if (attempt === 2) throw new Error(`提交回执尚未确认，已保留原操作：${message}`);
        await wait(retryDelay(response, attempt), this.signal);
      }
    }
    const taskUrl = `${apiUrl}/v1/videos/${encodeURIComponent(task.state.taskId!)}`;
    let failures = 0;
    while (task.state.phase !== "downloading") {
      let response: Response;
      try { response = await this.tool.fetch(taskUrl, { headers, signal: AbortSignal.timeout(30000), redirect: "error" }); }
      catch (error) {
        this.signal?.throwIfAborted();
        if (++failures >= 3) throw new Error("查询暂时不可用，原任务已保留，请稍后恢复");
        await wait(5000 * failures, this.signal);
        continue;
      }
      const value = await readJson(response);
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && ++failures < 3) { await wait(retryDelay(response, failures - 1), this.signal); continue; }
        throw new Error(this.tool.errorMessage(errorDetails(value)) || `查询失败（HTTP ${response.status}）`);
      }
      failures = 0;
      if (value.status === "failed") {
        const message = this.tool.errorMessage(value.error) || "视频生成失败，请核对原任务及账单";
        await task.update({ phase: "failed", error: message });
        throw new Error(message);
      }
      if (value.status === "completed") { await task.update({ phase: "downloading", progress: undefined }); break; }
      const progress = typeof value.progress === "number" && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100 ? value.progress : undefined;
      await task.update({ phase: value.status === "in_progress" ? "in_progress" : "queued", progress });
      await wait(5000, this.signal);
    }
    const bytes = await task.download(`${taskUrl}/download`, headers);
    return [{ mediaType: "video", type: "binary", data: bytes, mimeType: "video/mp4" }];
  },
} satisfies ProviderDefinition<typeof rules>;
