import { createHash, createHmac } from "node:crypto";
import conf from "@/utils/conf";
import { ossStorageSchema, type OssStorageSettings } from "@/types/mediaStorage";
import { createReferenceCache } from "@/utils/media/referenceCache";
import { detectMimeType } from "@/utils/media/mimeType";

export function getOssStorageSettings() {
  const parsed = ossStorageSchema.safeParse(conf.get("settings.mediaStorage"));
  if (!parsed.success || !parsed.data.enabled) throw Object.assign(new Error("本地参考素材需要上传：请先在「设置 → 素材存储」填写并启用阿里云 OSS；仅使用图片参考时也可填写 HTTPS 图片链接"), { status: 400 });
  return parsed.data;
}

function encode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hash(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }

// OSS V4 的资源路径包含 Bucket；签名与上传均由本地后端完成。
function signedUrl(config: OssStorageSettings, method: "GET" | "PUT" | "HEAD", key: string, expires: number, headers: Record<string, string> = {}) {
  const endpoint = config.endpoint ? new URL(config.endpoint).hostname : `oss-${config.region}.aliyuncs.com`;
  const host = `${config.bucket}.${endpoint}`;
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const scope = `${date}/${config.region}/oss/aliyun_v4_request`;
  const query = Object.entries({
    "x-oss-signature-version": "OSS4-HMAC-SHA256", "x-oss-credential": `${config.accessKeyId}/${scope}`,
    "x-oss-date": timestamp, "x-oss-expires": String(expires), "x-oss-additional-headers": "host",
  }).map(([name, value]) => [encode(name), encode(value)]).sort(([left], [right]) => left! < right! ? -1 : left! > right! ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`).join("&");
  const canonicalHeaders = Object.entries({ ...headers, host }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}:${value.trim()}\n`).join("");
  const path = key.split("/").map(encode).join("/");
  const canonical = [method, `/${config.bucket}/${path}`, query, canonicalHeaders, "host", "UNSIGNED-PAYLOAD"].join("\n");
  let signingKey: Uint8Array = Buffer.from(`aliyun_v4${config.accessKeySecret}`);
  for (const part of [date, config.region, "oss", "aliyun_v4_request"]) signingKey = createHmac("sha256", signingKey).update(part).digest();
  const signature = createHmac("sha256", signingKey).update(`OSS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).digest("hex");
  return `https://${host}/${path}?${query}&x-oss-signature=${signature}`;
}

async function ossRequest(config: OssStorageSettings, method: "PUT" | "HEAD", key: string, bytes?: Buffer, mimeType?: string, signal?: AbortSignal) {
  const headers: Record<string, string> = bytes ? {
    "content-type": mimeType!, "content-md5": createHash("md5").update(bytes).digest("base64"),
  } : {};
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(method === "PUT" ? 120000 : 30000);
    response = await fetch(signedUrl(config, method, key, 300, headers), {
      method, headers, body: bytes ? new Uint8Array(bytes) : undefined, redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    signal?.throwIfAborted();
    throw new Error("OSS 连接失败或超时，尚未提交视频任务；请检查网络、地域和 Endpoint 后重新生成");
  }
  if (response.ok || (method === "HEAD" && response.status === 404)) {
    await response.body?.cancel();
    return response.ok;
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (reader && size < 8192) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, 8192 - size);
      chunks.push(chunk); size += chunk.byteLength;
    }
  } catch { /* 错误正文不完整时仍报告 HTTP 状态，绝不输出带签名的请求地址。 */ }
  finally { await reader?.cancel().catch(() => {}); }
  const code = /<Code>([A-Za-z0-9]{1,80})<\/Code>/.exec(Buffer.concat(chunks).toString("utf8"))?.[1];
  const messages: Record<string, string> = {
    AccessDenied: "请检查专用密钥是否具有素材目录的 oss:PutObject 和 oss:GetObject 权限",
    InvalidAccessKeyId: "请检查 AccessKey ID", SignatureDoesNotMatch: "请检查 AccessKey Secret、地域和 Endpoint",
    RequestTimeTooSkewed: "请校准电脑时间", NoSuchBucket: "请检查 Bucket 名称和地域",
    PermanentRedirect: "请使用该 Bucket 所在地域的公网 Endpoint",
  };
  const requestId = response.headers.get("x-oss-request-id");
  throw new Error(`OSS 请求失败（HTTP ${response.status}${code ? ` / ${code}` : ""}），尚未提交视频任务。${messages[code ?? ""] ?? "请检查存储配置和访问权限"}${requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ? `；请求编号：${requestId}` : ""}`);
}

export async function uploadOssReferences(inputs: MediaInput[], config: OssStorageSettings, signal?: AbortSignal): Promise<MediaInput[]> {
  const prepared: (Extract<MediaInput, { type: "url" }> | { type: "upload"; bytes: Buffer; mimeType: string; format: string })[] = [];
  let total = 0;
  // ACT: 先完成同批素材的格式和体积校验，再开始上传；总计 300 MiB 限制同时约束内存占用。
  for (const input of inputs) {
    signal?.throwIfAborted();
    if (input.type === "url") { prepared.push(input); continue; }
    const bytes = input.type === "binary" ? Buffer.from(input.data) : Buffer.from(input.data.replace(/^data:[^;]+;base64,/, ""), "base64");
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("OSS 本地参考素材为空或超过单个 20 MiB 的传输限制，尚未提交视频任务");
    total += bytes.length;
    if (total > 300 * 1024 * 1024) throw new Error("OSS 本地参考素材合计超过 300 MiB 的传输限制，尚未提交视频任务");
    let mimeType: string;
    let format: string;
    if (input.mimeType.startsWith("audio/")) {
      mimeType = detectMimeType(bytes, "");
      if (mimeType === "video/mp4") mimeType = "audio/mp4";
      format = ({ "audio/mpeg": "mp3", "audio/wav": "wav", "audio/flac": "flac", "audio/mp4": "mp4" } as Record<string, string>)[mimeType] ?? "";
      if (!format) throw new Error("OSS 音频参考仅支持 MP3、WAV、FLAC 和 MP4 音频容器，请先转换格式");
    } else {
      const info = await new Bun.Image(bytes).metadata();
      format = info.format.toLowerCase().replace("jpg", "jpeg");
      if (!["png", "jpeg", "webp"].includes(format)) throw new Error("OSS 本地参考图目前支持 PNG、JPEG 和 WebP，请转换图片格式后生成");
      mimeType = `image/${format}`;
    }
    prepared.push({ type: "upload", bytes, mimeType, format });
  }
  const endpoint = config.endpoint ? new URL(config.endpoint).hostname : `oss-${config.region}.aliyuncs.com`;
  const withCache = createReferenceCache("aliyunOss", {
    apiUrl: `https://${config.bucket}.${endpoint}`,
    apiKey: JSON.stringify([config.accessKeyId, config.accessKeySecret, config.region, config.prefix, config.urlExpiryHours]),
  }, undefined, signal);
  return withCache(async cache => {
    const urls = new Map<string, string>();
    const result: MediaInput[] = [];
    for (const input of prepared) {
      signal?.throwIfAborted();
      if (input.type === "url") { result.push(input); continue; }
      const { bytes, format, mimeType } = input;
      const digest = hash(bytes);
      let url = urls.get(digest);
      if (!url) {
        const key = `${config.prefix}/${digest}.${format}`;
        const saved = await cache.get(digest);
        const cached = saved?.ref === key && saved.expiresAt > Date.now() && await ossRequest(config, "HEAD", key, undefined, undefined, signal);
        if (!cached) {
          await ossRequest(config, "PUT", key, bytes, mimeType, signal);
          // 复用窗口不超过链接有效期；云端清理期限需大于两者之和。
          await cache.set(digest, { ref: key, expiresAt: Date.now() + config.urlExpiryHours * 3600000 });
        }
        url = signedUrl(config, "GET", key, config.urlExpiryHours * 3600);
        urls.set(digest, url);
      }
      result.push({ type: "url", url, mimeType });
    }
    return result;
  });
}
