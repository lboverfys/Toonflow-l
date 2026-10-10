const rules = [
  { type: "input", field: "apiUrl" as const, title: "API 地址", value: "https://yuzapi.fun", props: { placeholder: "站点根地址或以 /v1 结尾的地址" } },
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "select", field: "quality" as const, title: "生成品质", value: "max", options: [
    { label: "auto · 自动", value: "auto" }, { label: "low · 草稿", value: "low" },
    { label: "medium · 中等", value: "medium" }, { label: "high · 高", value: "high" },
    { label: "xhigh · 更高", value: "xhigh" }, { label: "max · 最高", value: "max" },
  ] },
  { type: "select", field: "outputFormat" as const, title: "图片格式", value: "png", options: [
    { label: "PNG", value: "png" }, { label: "JPEG", value: "jpeg" }, { label: "WebP", value: "webp" },
  ] },
  { type: "input", field: "customSize" as const, title: "自定义像素尺寸（留空跟随画布）", value: "", props: { placeholder: "例如 1024x1024、2048x1152 或 auto；填写后优先于画布尺寸与比例" } },
  { type: "inputNumber", field: "timeoutSeconds" as const, title: "单次请求超时（秒）", value: 300, props: { min: 1, max: 3600, precision: 0 } },
];

const sizePresets: Record<string, Record<string, string>> = {
  "1K": { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "16:9": "1536x864", "9:16": "864x1536" },
  "2K": { "1:1": "2048x2048", "3:2": "2304x1536", "2:3": "1536x2304", "16:9": "2048x1152", "9:16": "1152x2048" },
  "4K": { "16:9": "3840x2160", "9:16": "2160x3840" },
};
const uploadLimit = 20 * 1024 * 1024;
const imageLimit = 50 * 1024 * 1024;

function secureUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("图片地址须使用 HTTPS，且不能在地址中嵌入账号或密码");
  return url;
}

function resolveSize(value: string, ratio: string) {
  const preset = sizePresets[value.toUpperCase()];
  const size = preset ? preset[ratio] : value.toLowerCase();
  if (!size) throw new Error(`当前 ${value} 档位不支持 ${ratio}；4K 仅支持 16:9、9:16，也可在供应商设置中填写有效的像素尺寸`);
  if (size === "auto") return size;
  const dimensions = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  if (!dimensions) throw new Error("图片尺寸须为画布支持的档位、宽x高像素值或 auto");
  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  if (width % 16 || height % 16 || Math.max(width, height) > 3840 || Math.max(width, height) > Math.min(width, height) * 3 || width * height < 655360 || width * height > 8294400) {
    throw new Error("GPT Image 2/2.5 尺寸须为 16 的倍数，单边不超过 3840，比例在 1:3～3:1，总像素在 655360～8294400 之间");
  }
  return size;
}

async function responseBytes(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("图片响应超过本地接收大小限制"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片响应正文为空");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("图片响应超过本地接收大小限制");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, length);
}

function decodeImage(value: string, limit: number) {
  const raw = value.replace(/^data:image\/[^;,]+;base64,/, "").replace(/\s/g, "");
  if (raw.length > Math.ceil(limit / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 === 1) throw new Error("图片 Base64 无效或超过大小限制");
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length || bytes.length > limit || bytes.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) throw new Error("图片 Base64 无效或超过大小限制");
  return bytes;
}

async function imageBytes(context: ProviderContext, input: MediaInput, signal: AbortSignal, limit: number) {
  let bytes: Uint8Array;
  if (input.type === "binary") bytes = input.data;
  else if (input.type === "base64") bytes = decodeImage(input.data, limit);
  else {
    const response = await context.tool.fetch(secureUrl(input.url), { signal, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`读取原图失败（HTTP ${response.status}）`); }
    bytes = await responseBytes(response, limit);
  }
  if (!bytes.length || bytes.length > limit) throw new Error(`图片为空或超过 ${limit / 1024 / 1024} MiB`);
  const info = await context.tool.media.inspectImage({ type: "binary", data: bytes, mimeType: input.mimeType ?? "application/octet-stream" });
  const format = info.format.toLowerCase().replace("jpg", "jpeg");
  if (!["png", "jpeg", "webp"].includes(format) || !info.width || !info.height) throw new Error("图片须为有效的 PNG、JPEG 或 WebP");
  return { bytes, mimeType: `image/${format}`, width: info.width, height: info.height };
}

export default {
  id: "sub2apiImage",
  label: "Sub2API 生图",
  version: "1.0.0",
  apiUrl: "https://yuzapi.fun",
  readme: "同步文生图和参考图编辑，每次生成一张。地址、密钥、品质、格式、超时与自定义尺寸可在此调整；模型 ID 可在下方编辑。品质初始为 max，格式初始为 PNG。自定义尺寸留空时按画布档位与比例换算；填写像素尺寸或 auto 后优先使用该值。4K 档位仅支持 16:9、9:16；方图最大 2880x2880。原图按实际格式保存，不缩放或转码。同步请求没有可恢复的任务编号，超时后请先核对站点生成记录；扩展不自动重试。",
  rules,
  models: [
    { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "3:2", "2:3", "16:9", "9:16"] },
    { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare", type: "image", mode: ["text", "singleImage", "multiReference"], imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "3:2", "2:3", "16:9", "9:16"] },
  ],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const apiKey = String(this.config.apiKey).trim().replace(/^Bearer\s+/i, "").trim();
    if (!apiKey) throw new Error("请在 Sub2API 供应商设置中填写 API Key");
    const base = secureUrl(String(this.config.apiUrl).trim());
    if (base.search || base.hash) throw new Error("API 地址不能带查询参数或片段");
    const path = base.pathname.replace(/\/+$/, "");
    base.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
    if (!request.model.trim() || !request.prompt.trim()) throw new Error("请填写模型 ID 和图片提示词");
    if (request.n !== undefined && request.n !== 1) throw new Error("此扩展每次生成一张图片");
    const quality = String(request.quality ?? this.config.quality).trim().toLowerCase();
    const outputFormat = String(request.outputFormat ?? this.config.outputFormat).trim().toLowerCase();
    if (!["auto", "low", "medium", "high", "xhigh", "max"].includes(quality)) throw new Error("请选择有效的生成品质");
    if (!["png", "jpeg", "webp"].includes(outputFormat)) throw new Error("图片格式须为 PNG、JPEG 或 WebP");
    const timeoutSeconds = Number(this.config.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error("超时须为 1～3600 的整数秒");
    const customSize = String(this.config.customSize).trim();
    const size = resolveSize(customSize || request.size?.trim() || "1K", request.ratio || "1:1");
    const images = request.images ?? [];
    if (request.mask && !images.length) throw new Error("蒙版须配合参考图使用");
    const payload = { model: request.model, prompt: request.prompt, size, quality, output_format: outputFormat, n: 1, stream: false };
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
    let body: string | Buffer<ArrayBuffer>;
    if (images.length) {
      const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
      const parts: Uint8Array[] = [];
      for (const [name, value] of Object.entries(payload)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      const readSignal = AbortSignal.timeout(timeoutSeconds * 1000);
      let total = 0;
      let first: Awaited<ReturnType<typeof imageBytes>> | undefined;
      const inputs = images.map(input => ({ name: "image[]", input }));
      if (request.mask) inputs.push({ name: "mask", input: request.mask });
      for (let index = 0; index < inputs.length; index++) {
        const { name, input } = inputs[index]!;
        const image = await imageBytes(this, input, readSignal, uploadLimit);
        first ??= image;
        if (name === "mask" && (image.mimeType !== "image/png" || image.width !== first.width || image.height !== first.height)) throw new Error("蒙版须为与第一张参考图同尺寸的 PNG");
        total += image.bytes.length;
        if (total > imageLimit) throw new Error("参考图与蒙版合计不能超过 50 MiB");
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="reference${index}.${image.mimeType.slice(6)}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`), image.bytes, Buffer.from("\r\n"));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      body = Buffer.concat(parts);
      headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    } else {
      body = JSON.stringify(payload);
      headers["Content-Type"] = "application/json";
    }
    let response: Response;
    try {
      response = await this.tool.fetch(`${base.href}/images/${images.length ? "edits" : "generations"}`, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutSeconds * 1000), redirect: "error" });
    } catch (error) {
      this.signal?.throwIfAborted();
      throw new Error(`图片请求中断，结果尚未确认；请先核对站点记录，避免重复生成。${this.tool.errorMessage(error instanceof Error ? error.message : error)}`);
    }
    const bytes = await responseBytes(response, response.ok ? 70 * 1024 * 1024 : 16000);
    let result: { data?: { b64_json?: string; image_base64?: string; url?: string }[]; error?: unknown };
    try { result = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error(`图片接口返回非 JSON 正文（HTTP ${response.status}）；请先核对站点记录，扩展不会自动重试`); }
    if (!response.ok || result?.error) throw new Error(`生图失败（HTTP ${response.status}）：${this.tool.errorMessage(result) || "接口未提供错误详情"}`);
    if (!Array.isArray(result?.data) || result.data.length !== 1 || !result.data[0] || typeof result.data[0] !== "object") throw new Error("图片接口未返回一张有效图片，请核对站点记录");
    const item = result.data[0];
    const encoded = item.b64_json ?? item.image_base64;
    let input: MediaInput;
    if (typeof encoded === "string" && encoded) input = { type: "base64", data: encoded, mimeType: `image/${outputFormat}` };
    else if (typeof item.url === "string" && item.url) input = { type: "url", url: item.url };
    else throw new Error("图片结果缺少 Base64 或下载地址");
    const image = await imageBytes(this, input, AbortSignal.timeout(timeoutSeconds * 1000), imageLimit);
    if (image.width * image.height > 8294400) throw new Error("返回图片超过 GPT Image 2/2.5 的像素上限");
    return [{ type: "binary", data: image.bytes, mimeType: image.mimeType, mediaType: "image" }];
  },
} satisfies ProviderDefinition<typeof rules>;
