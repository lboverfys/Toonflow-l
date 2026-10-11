const rules = [
  { type: "input", field: "apiUrl" as const, title: "API 地址", value: "https://ailxp.top", props: { placeholder: "站点根地址，或以 /v1、/v1beta 结尾的地址" } },
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
];

const imageRatios = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const requestLimit = 64 * 1024 * 1024;

type InlineImage = { data?: string; mimeType?: string; mime_type?: string };
type ImagePart = { text?: string; thought?: boolean; inlineData?: InlineImage; inline_data?: InlineImage; fileData?: { fileUri?: string; mimeType?: string } };
type ImageResponse = {
  error?: unknown;
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: ImagePart[] } }[];
};

function secureUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("AILXP 地址须使用 HTTPS，且不能在地址中嵌入账号或密码");
  return url;
}

async function responseBytes(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("AILXP 响应超过本地接收大小限制"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("AILXP 返回了空响应");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("AILXP 响应超过本地接收大小限制");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, length);
}

async function referencePart(context: ProviderContext, input: MediaInput, signal: AbortSignal, limit: number) {
  let bytes: Uint8Array;
  if (input.type === "binary") bytes = input.data;
  else if (input.type === "base64") {
    const data = input.data.replace(/^data:image\/[^;,]+;base64,/, "").replace(/\s/g, "");
    if (data.length > Math.ceil(limit / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("AILXP 参考图 Base64 无效或超过本地请求大小限制");
    bytes = Buffer.from(data, "base64");
  } else {
    const response = await context.tool.fetch(secureUrl(input.url), { signal, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`读取 AILXP 参考图失败（HTTP ${response.status}）`); }
    bytes = await responseBytes(response, limit);
  }
  if (!bytes.byteLength || bytes.byteLength > limit) throw new Error("AILXP 参考图为空或超过本地请求大小限制");
  signal.throwIfAborted();
  const info = await context.tool.media.inspectImage({ type: "binary", data: bytes, mimeType: input.mimeType ?? "application/octet-stream" });
  return { inlineData: { mimeType: `image/${info.format.toLowerCase().replace(/^jpg$/, "jpeg")}`, data: Buffer.from(bytes).toString("base64") } };
}

export default {
  id: "ailxpImage",
  label: "AILXP Gemini 生图",
  version: "1.0.0",
  apiUrl: "https://ailxp.top",
  readme: "通过 [AILXP](https://ailxp.top/pricing) 的 Gemini 接口生成图片，内置 Gemini 3 Pro Image Preview 和 Gemini 3.1 Flash Image Preview。按本站模型详情及自家创作画布的调用方式接入，支持文生图、单图编辑、多图参考与 1K / 2K / 4K。填写本站 API Key，并在令牌设置中选择有这两个模型权限的分组。尺寸和比例在画布节点中选择，返回原图交由工作区保存。每次提交一条同步生成请求，最长等待 5 分钟，请求体上限为本地 64 MiB；没有可恢复的任务编号，超时或中断后请先核对站点记录，不会自动重试。计费以站点及令牌分组为准。",
  rules,
  models: [
    {
      id: "gemini-3-pro-image-preview", label: "Gemini 3 Pro Image Preview", type: "image", mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"],
    },
    {
      id: "gemini-3.1-flash-image-preview", label: "Gemini 3.1 Flash Image Preview", type: "image", mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"], imageRatios: ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"],
    },
  ],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const apiKey = String(this.config.apiKey).trim().replace(/^Bearer\s+/i, "").trim();
    if (!apiKey) throw new Error("请在 AILXP 供应商设置中填写 API Key");
    if (!["gemini-3-pro-image-preview", "gemini-3.1-flash-image-preview"].includes(request.model)) throw new Error("请选择已接入的 AILXP Gemini 图片模型");
    if (!request.prompt.trim()) throw new Error("请输入图片提示词");
    if (request.n !== undefined && request.n !== 1) throw new Error("AILXP Gemini 每次仅提交一条生图请求");
    if (request.mask || request.quality || request.outputFormat) throw new Error("AILXP Gemini 不提供独立蒙版、画质或输出编码参数，请使用参考图、提示词和尺寸设置");
    const size = request.size?.trim().toUpperCase() || "1K";
    const ratio = request.ratio?.trim();
    if (!["1K", "2K", "4K"].includes(size)) throw new Error("AILXP Gemini 图片尺寸支持 1K、2K、4K");
    if (ratio && !imageRatios.includes(ratio)) throw new Error("AILXP Gemini 不支持所选图片比例，请从节点设置中选择");
    const endpoint = secureUrl(String(this.config.apiUrl).trim());
    if (endpoint.search || endpoint.hash) throw new Error("AILXP API 地址不能带查询参数或片段");
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "").replace(/\/v1(?:beta)?$/, "")}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;
    const signal = AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const parts: ImagePart[] = [{ text: request.prompt }];
    let length = Buffer.byteLength(request.prompt);
    for (const image of request.images ?? []) {
      signal.throwIfAborted();
      if (length >= requestLimit) throw new Error("AILXP 请求体超过本地 64 MiB 上限，请减少参考图片");
      const part = await referencePart(this, image, signal, Math.floor((requestLimit - length) * 3 / 4));
      length += part.inlineData.data.length;
      parts.push(part);
    }
    const body = JSON.stringify({
      model: request.model,
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { imageSize: size, ...(ratio ? { aspectRatio: ratio } : {}) } },
    });
    if (Buffer.byteLength(body) > requestLimit) throw new Error("AILXP 请求体超过本地 64 MiB 上限，请减少参考图片或提示词");
    let response: Response;
    let bytes: Buffer;
    try {
      response = await this.tool.fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body, signal, redirect: "error" });
      bytes = await responseBytes(response, response.ok ? 140 * 1024 * 1024 : 16000);
    } catch (error) {
      this.signal?.throwIfAborted();
      throw new Error(`AILXP 图片请求中断，结果尚未确认；请先核对站点记录，避免重复生成。${this.tool.errorMessage(error)}`);
    }
    let result: ImageResponse;
    try { result = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error(`AILXP 返回非 JSON 正文（HTTP ${response.status}），请先核对站点记录`); }
    if (!response.ok || result?.error) throw new Error(`AILXP 生图失败（HTTP ${response.status}）：${this.tool.errorMessage(result) || "接口未提供错误详情"}`);
    if (result?.promptFeedback?.blockReason) throw new Error(`AILXP 拒绝生成：${this.tool.errorMessage(result.promptFeedback.blockReason)}`);
    const assets: MediaAsset[] = [];
    const details: string[] = [];
    for (const candidate of Array.isArray(result?.candidates) ? result.candidates : []) {
      if (candidate?.finishReason) details.push(candidate.finishReason);
      for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
        if (!part || part.thought === true) continue;
        if (typeof part.text === "string") details.push(part.text);
        const inline = part.inlineData ?? part.inline_data;
        if (typeof inline?.data === "string" && inline.data.trim()) {
          const mimeType = inline.mimeType ?? inline.mime_type ?? "image/png";
          if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) throw new Error("AILXP 返回的内容不是图片");
          assets.push({ type: "base64", data: inline.data, mimeType, mediaType: "image" });
        } else if (typeof part.fileData?.fileUri === "string" && part.fileData.fileUri) {
          assets.push({ type: "url", url: secureUrl(part.fileData.fileUri).href, mimeType: part.fileData.mimeType, mediaType: "image" });
        }
      }
    }
    if (!assets.length) throw new Error(`AILXP 未返回图片：${this.tool.errorMessage(details) || "接口未提供生成结果"}`);
    return assets;
  },
} satisfies ProviderDefinition<typeof rules>;
