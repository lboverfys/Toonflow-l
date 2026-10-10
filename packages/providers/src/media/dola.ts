const rules = [
  { type: "input", field: "apiKey" as const, title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "apiUrl" as const, title: "API 地址", value: "https://dola-api.aa01.cn" },
];

const imageLimit = 20 * 1024 * 1024;
const bodyLimit = 64 * 1024 * 1024;
const ratios = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"];
type DolaValue = Record<string, any>;
type DolaError = Error & { status?: number; code?: string; retryable?: boolean; retryAfter?: number; uncertain?: boolean };
type DolaSnapshot = { payload: DolaValue; imageHashes: string[] };
type ReferenceImage = { hash: string; input: MediaInput; bytes?: Uint8Array; mimeType?: string; url?: string };

function wait(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function apiBase(context: ProviderContext) {
  if (!String(context.config.apiKey ?? "").trim()) throw new Error("请在 Dola 供应商设置中填写 API Key");
  const url = new URL(String(context.config.apiUrl).trim());
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("Dola API 地址须为 HTTPS 站点根地址；本机接口可使用 HTTP");
  }
  return url.origin;
}

function publicUrl(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Dola 未返回有效的成品链接，已保留原任务");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Dola 媒体链接须为不含账号密码的 HTTPS 地址");
  return value;
}

async function responseBytes(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Dola 响应超过本地接收大小限制"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Dola 返回了空响应");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Dola 响应超过本地接收大小限制");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, size);
}

function retryDelay(response: Response, value: DolaValue) {
  const header = response.headers.get("retry-after");
  const delay = header ? /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now() : Number(value.detail?.retry_after ?? 0) * 1000;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

function shortText(context: ProviderContext, value: unknown) {
  return typeof value === "string" ? context.tool.errorMessage(value.replace(/data:[^;\s]+;base64,[a-zA-Z0-9+/=]+/g, "[图片内容已省略]")).slice(0, 1000) : "";
}

async function apiRequest(context: ProviderContext, path: string, body?: string | Uint8Array, mimeType = "application/json", attempts = 3): Promise<DolaValue> {
  const base = apiBase(context);
  let uncertain = false;
  for (let attempt = 0; ; attempt++) {
    let failure: DolaError;
    try {
      const response = await context.tool.fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "X-API-Key": String(context.config.apiKey).trim(), Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": mimeType }) },
        body: typeof body === "string" || body === undefined ? body : Buffer.from(body),
        signal: AbortSignal.timeout(body === undefined ? 30000 : 120000), redirect: "error",
      });
      let value: DolaValue = {};
      try {
        const decoded = JSON.parse((await responseBytes(response, 1024 * 1024)).toString("utf8"));
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) value = decoded;
      } catch (error) {
        context.signal?.throwIfAborted();
        if (response.ok) throw Object.assign(new Error("Dola 回执无效，已保留原操作，请恢复查询"), { retryable: true });
      }
      if (response.ok) return value;
      const code = shortText(context, value.detail?.error);
      // 422 的 input 可能回显整批图片；只取短错误码，不拼接原始响应。
      const description = response.status === 422 ? "请检查提示词、模型和参考素材" : shortText(context, value.detail?.note);
      const requestId = shortText(context, value.request_id ?? response.headers.get("x-request-id"));
      failure = Object.assign(new Error([`Dola 请求失败（HTTP ${response.status}${code ? ` / ${code}` : ""}）`, description, requestId ? `请求编号：${requestId}` : ""].filter(Boolean).join("；")), {
        status: response.status, code, retryAfter: retryDelay(response, value),
        retryable: response.status >= 500 || response.status === 408 || (response.status === 429 && ["rate_limited", "queue_full"].includes(code)),
      });
    } catch (error) {
      context.signal?.throwIfAborted();
      failure = Object.assign(new Error(`Dola 连接或回执中断：${shortText(context, (error as Error)?.message)}`), { retryable: true });
    }
    const delay = Math.max(1500 * 2 ** attempt, failure.retryAfter ?? 0);
    uncertain ||= failure.retryable === true;
    failure.uncertain = uncertain;
    if (!failure.retryable || attempt + 1 >= attempts || delay > 60000) throw failure;
    await wait(delay, context.signal);
  }
}

function imageMime(bytes: Uint8Array) {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 12));
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(header.toString("ascii", 0, 6))) return "image/gif";
  if (header.toString("ascii", 0, 2) === "BM") return "image/bmp";
  throw new Error("Dola 图片须为 PNG、JPEG、WebP、GIF 或 BMP");
}

function referenceImage(context: ProviderContext, input: MediaInput): ReferenceImage {
  if (input.type === "url") {
    const url = publicUrl(input.url);
    return { input, url, hash: context.tool.sha256(url) };
  }
  let bytes: Uint8Array;
  if (input.type === "binary") bytes = input.data;
  else {
    const data = input.data.replace(/^data:image\/[^;,]+;base64,/, "").replace(/\s/g, "");
    if (data.length > Math.ceil(imageLimit / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("Dola 参考图 Base64 无效或超过 20 MiB");
    bytes = Buffer.from(data, "base64");
    if (Buffer.from(bytes).toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) throw new Error("Dola 参考图 Base64 无效");
  }
  if (!bytes.byteLength || bytes.byteLength > imageLimit) throw new Error("Dola 参考图为空或超过 20 MiB");
  return { input, bytes, mimeType: imageMime(bytes), hash: context.tool.sha256(bytes) };
}

async function inlineImage(context: ProviderContext, image: ReferenceImage) {
  const input: MediaInput = { type: "binary", data: image.bytes!, mimeType: image.mimeType! };
  const info = await context.tool.media.inspectImage(input);
  let output: MediaInput = input;
  if (Math.max(info.width, info.height) > 1536) {
    output = await context.tool.media.resizeImage(input, { ...(info.width >= info.height ? { width: 1536 } : { height: 1536 }), format: "jpeg", quality: 90 });
  }
  if (output.type === "url") throw new Error("参考图内联转换未返回图片内容");
  return `data:${output.mimeType};base64,${output.type === "base64" ? output.data : Buffer.from(output.data).toString("base64")}`;
}

function assetEntry(value: DolaValue, image: ReferenceImage): ProviderReferenceCacheEntry {
  const ref = typeof value.ref === "string" ? value.ref : typeof value.asset_id === "string" ? `asset://${value.asset_id}` : "";
  const expiresAt = Number(value.expires_at) * 1000;
  if (!/^asset:\/\/[a-zA-Z0-9_-]+$/.test(ref) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("Dola 素材回执缺少有效引用或到期时间");
  return { ref, expiresAt, source: image.input.name };
}

async function prepareReferences(context: ProviderContext, images: ReferenceImage[], assetsEnabled: boolean, invalidRefs: string[] = []) {
  return context.tool.withReferenceCache(async cache => {
    const refs = new Map<string, string>();
    const local = [...new Map(images.filter(image => !image.url).map(image => [image.hash, image])).values()];
    const missing: ReferenceImage[] = [];
    const fallback = async (image: ReferenceImage, reason: string) => {
      refs.set(image.hash, await inlineImage(context, image));
      await cache.set(image.hash, { expiresAt: Date.now() + 86400000, source: image.input.name, fallbackReason: reason.slice(0, 1000) });
    };
    for (const image of local) {
      const saved = await cache.get(image.hash);
      if (assetsEnabled && saved?.ref && saved.expiresAt > Date.now() && !invalidRefs.includes(saved.ref)) refs.set(image.hash, saved.ref);
      else {
        if (saved?.ref && invalidRefs.includes(saved.ref)) await cache.remove(image.hash);
        missing.push(image);
      }
    }
    if (missing.length && !assetsEnabled) {
      for (const image of missing) await fallback(image, "素材功能关闭，按文档回退为内联参考图");
    } else if (missing.length) {
      let items: DolaValue[] | undefined;
      try {
        const result = await apiRequest(context, "/v1/assets/check", JSON.stringify({ items: missing.map(image => ({ sha256: image.hash, bytes: image.bytes!.byteLength })) }), "application/json", 2);
        if (!Array.isArray(result.items) || result.items.length !== missing.length || result.items.some((item, index) => item?.sha256 !== missing[index]!.hash || typeof item.hit !== "boolean")) throw new Error("Dola 批量素材查询回执不匹配");
        items = result.items;
      } catch (error) {
        context.signal?.throwIfAborted();
        const failure = error as DolaError;
        if (failure.status === 403 || failure.code === "blocked_bad_key") throw error;
        if (failure.status === 429) await wait(Math.max(1500, failure.retryAfter ?? 0), context.signal);
        for (const image of missing) await fallback(image, shortText(context, failure.message));
      }
      for (let index = 0; items && index < missing.length; index++) {
        const image = missing[index]!;
        let item = items[index]!;
        let entry: ProviderReferenceCacheEntry | undefined;
        for (let attempt = 0; ; attempt++) {
          try {
            if (item.hit) {
              const cached = assetEntry(item, image);
              if (!invalidRefs.includes(cached.ref!)) {
                entry = cached;
                break;
              }
            }
            // 同一账号的缓存锁覆盖整个查重/上传过程；串行上传符合并发不超过 2 的要求。
            entry = assetEntry(await apiRequest(context, "/v1/assets", image.bytes!, image.mimeType!, 1), image);
            break;
          } catch (error) {
            context.signal?.throwIfAborted();
            const failure = error as DolaError;
            if (failure.status === 403 || failure.code === "blocked_bad_key") throw error;
            if (attempt >= 1 || failure.retryable === false) {
              if (failure.status === 429) await wait(Math.max(1500, failure.retryAfter ?? 0), context.signal);
              await fallback(image, shortText(context, failure.message));
              break;
            }
            await wait(Math.max(1500 * 2 ** attempt, failure.retryAfter ?? 0), context.signal);
            // 上传回执丢失时先查库，避免已经成功的图片被再次上传。
            try {
              const checked = await apiRequest(context, "/v1/assets/check", JSON.stringify({ items: [{ sha256: image.hash, bytes: image.bytes!.byteLength }] }), "application/json", 1);
              if (!Array.isArray(checked.items) || checked.items.length !== 1 || checked.items[0]?.sha256 !== image.hash || typeof checked.items[0].hit !== "boolean") throw new Error("Dola 素材重查回执不匹配");
              item = checked.items[0];
            } catch (checkError) {
              context.signal?.throwIfAborted();
              const checkFailure = checkError as DolaError;
              if (checkFailure.status === 403 || checkFailure.code === "blocked_bad_key") throw checkError;
              if (checkFailure.status === 429) await wait(Math.max(1500, checkFailure.retryAfter ?? 0), context.signal);
              await fallback(image, shortText(context, checkFailure.message));
              break;
            }
          }
        }
        if (entry) {
          // 持久化失败必须中止，不能误作上传失败再次传图。
          await cache.set(image.hash, entry);
          refs.set(image.hash, entry.ref!);
        }
      }
    }
    return images.map(image => image.url ?? refs.get(image.hash)!);
  });
}

function configuredChoices(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const choices = value.map(item => typeof item === "string" ? item : item?.id ?? item?.value);
  return choices.every(item => typeof item === "string" && item) ? choices : undefined;
}

function configuredLimit(value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Dola 返回的生成参数上限无效，请核对渠道配置");
  return value;
}

async function createSnapshot(context: ProviderContext, kind: "image" | "video", request: ImageRequest | VideoRequest): Promise<DolaSnapshot> {
  const config = await apiRequest(context, "/v1/creation/config");
  const mode = config.modes?.[kind];
  const models = configuredChoices(mode?.models) ?? (kind === "image" ? ["Seedream 5.0 Pro", "Seedream 4.0"] : ["seedance_v2.5", "seedance_v2.0"]);
  if (!models.includes(request.model)) throw new Error("Dola 模型不在当前渠道配置中，请检查模型 ID");
  const maxPrompt = configuredLimit(mode?.max_prompt_chars, 10000);
  if (!request.prompt.trim() || [...request.prompt].length > maxPrompt) throw new Error(`Dola 提示词须为 1～${maxPrompt} 个字符，不会自动截断`);
  const ratio = request.ratio || (kind === "image" ? "1:1" : "9:16");
  if (!(configuredChoices(mode?.ratios) ?? ratios).includes(ratio)) throw new Error("Dola 不支持所选画面比例，请按渠道配置选择");
  const payload: DolaValue = { kind, model: request.model, prompt: request.prompt, ratio, client_task_id: (context.imageTask ?? context.videoTask)!.id };
  if (kind === "image") {
    const image = request as ImageRequest;
    if (image.images?.length || image.mask) throw new Error("Dola 图片模型仅支持文生图，不支持参考图和局部重绘");
    if (image.n !== undefined && image.n !== 4) throw new Error("Dola 每次固定生成 4 张图片");
    if ((image.size && !["auto", "自动"].includes(image.size)) || image.quality || image.outputFormat) throw new Error("Dola 图片尺寸、品质和编码由渠道决定，请选择自动尺寸");
  } else {
    const video = request as VideoRequest;
    if (video.videos?.length || video.audios?.length || video.firstFrame || video.lastFrame) throw new Error("Dola 视频仅支持图片参考，不支持音视频参考或首尾帧模式");
    if ((video.resolution && !["auto", "自动"].includes(video.resolution)) || video.generateAudio !== undefined || video.watermark !== undefined) throw new Error("Dola 未提供分辨率、音频和水印开关，请使用渠道默认设置");
    const duration = video.duration ?? (video.model === "seedance_v2.5" ? 30 : 15);
    const durations = video.model === "seedance_v2.0" ? [5, 10, 15] : [5, 10, 15, 30];
    if (!durations.includes(duration)) throw new Error(`此 Dola 模型可选时长：${durations.join("、")} 秒；Seedance 2.0 最长约 15 秒`);
    payload.duration = duration;
  }
  const inputs = request.images ?? [];
  const maxImages = Math.min(9, configuredLimit(config.limits?.max_ref_images ?? config.assets?.max_count, 9));
  if (inputs.length > maxImages) throw new Error(`Dola 视频最多使用 ${maxImages} 张参考图片`);
  const images = inputs.map(input => referenceImage(context, input));
  if (images.length) payload.ref_image_urls = await prepareReferences(context, images, config.assets?.enabled !== false);
  const maxBody = Math.min(bodyLimit, configuredLimit(config.limits?.max_body_bytes, bodyLimit));
  if (Buffer.byteLength(JSON.stringify(payload)) > maxBody) throw new Error("Dola 请求体超过传输预算，请减少参考图或换用较小图片");
  return { payload, imageHashes: images.map(image => image.hash) };
}

async function submitTask(context: ProviderContext, saved: DolaSnapshot) {
  const task = (context.imageTask ?? context.videoTask)!;
  let payload = saved.payload;
  let wasUncertain = task.state.phase === "submitting";
  await task.update({ phase: "submitting", error: undefined, retryAt: undefined });
  for (let renewal = 0; ; renewal++) {
    try {
      const value = await apiRequest(context, "/v1/task", JSON.stringify(payload));
      if (typeof value.task_id !== "string" || !value.task_id.trim() || value.task_id.length > 2048) throw new Error("Dola 受理回执缺少任务编号，请恢复原操作核实，不要重新生成");
      await task.update({ taskId: value.task_id, phase: "queued", error: undefined, retryAt: undefined });
      if (typeof value.ref_images_accepted === "number" && value.ref_images_accepted !== (payload.ref_image_urls?.length ?? 0)) throw new Error("Dola 已受理任务，但参考图接收数量不符；请核对渠道记录，已保留任务编号且不会补发生成");
      return;
    } catch (error) {
      context.signal?.throwIfAborted();
      const failure = error as DolaError;
      wasUncertain ||= failure.uncertain === true;
      const invalidRefs = Array.isArray(payload.ref_image_urls) ? payload.ref_image_urls.filter((ref: unknown): ref is string => typeof ref === "string" && ref.startsWith("asset://")) : [];
      if (failure.status === 422 && failure.code === "bad_ref_image" && renewal === 0 && invalidRefs.length && context.videoTask) {
        const images = (await context.videoTask.readReferenceImages()).map(input => referenceImage(context, input));
        if (JSON.stringify(images.map(image => image.hash)) !== JSON.stringify(saved.imageHashes)) throw new Error("原参考图片已变化，无法安全更新素材引用；请恢复原图后继续此任务");
        const refs = await prepareReferences(context, images, true, invalidRefs);
        payload = { ...payload, ref_image_urls: refs };
        if (Buffer.byteLength(JSON.stringify(payload)) > bodyLimit) throw new Error("Dola 恢复请求超过 64 MiB，请保留原任务并检查参考图");
        continue;
      }
      const message = shortText(context, failure.message);
      if (!wasUncertain && (failure.status === 422 || failure.status === 413 || failure.status === 400 || failure.code === "client_quota_exhausted")) {
        await task.update({ phase: "failed", error: message, retryAt: undefined });
      } else await task.update({ error: message, retryAt: Date.now() + Math.max(5000, failure.retryAfter ?? 0) });
      throw error;
    }
  }
}

async function waitTask(context: ProviderContext, kind: "image" | "video") {
  const task = (context.imageTask ?? context.videoTask)!;
  const startedAt = Date.now();
  let deadline = startedAt + 150 * 60 * 1000;
  let gap = 5000;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    let value: DolaValue;
    try { value = await apiRequest(context, `/v1/task/${encodeURIComponent(task.state.taskId!)}`); }
    catch (error) {
      context.signal?.throwIfAborted();
      await task.update({ retryAt: Date.now() + Math.max(5000, (error as DolaError).retryAfter ?? 0) });
      throw error;
    }
    if (value.task_id !== task.state.taskId || (value.kind !== undefined && value.kind !== kind)) throw new Error("Dola 查询回执与原任务不匹配，已保留原任务");
    if (typeof value.max_wait_s === "number" && Number.isFinite(value.max_wait_s) && value.max_wait_s > 0) deadline = Math.max(deadline, startedAt + (value.max_wait_s + 60) * 1000);
    if (value.status === "failed") {
      const message = `Dola 任务失败${value.error_code ? `（${shortText(context, value.error_code)}）` : ""}：${shortText(context, value.error) || "渠道未提供具体原因"}`;
      await task.update({ phase: "failed", error: message, retryAt: undefined });
      throw new Error(message);
    }
    if (value.status === "succeeded") {
      const urls = Array.isArray(value.urls) && value.urls.length ? value.urls : value.url ? [value.url] : [];
      if (urls.length !== (kind === "image" ? 4 : 1)) throw new Error("Dola 成功回执缺少预期数量的成品，已保留原任务，不会重新生成");
      const links = urls.map(publicUrl);
      await task.update({ phase: "downloading", error: undefined, retryAt: undefined });
      return links;
    }
    if (!["pending", "running"].includes(value.status)) throw new Error("Dola 返回未知任务状态，已保留原任务，请稍后恢复");
    if (context.imageTask) await context.imageTask.update({ phase: value.status === "running" ? "processing" : "queued", error: undefined, retryAt: undefined });
    else await context.videoTask!.update({ phase: value.status === "running" ? "in_progress" : "queued", error: undefined, retryAt: undefined });
    await wait(Math.min(gap, Math.max(1, deadline - Date.now())), context.signal);
    gap = Math.min(60000, gap * 1.5);
  }
  throw new Error("Dola 本地等待窗口已结束；渠道任务仍可能在运行，请恢复原任务继续查询，不会再次生成");
}

async function downloadImages(context: ProviderContext, urls: string[], previous?: ImageTaskAsset[]) {
  const task = context.imageTask!;
  const assets: ImageTaskAsset[] = urls.map((url, index) => previous?.[index]?.type === "base64" ? previous[index]! : { type: "url", url, mediaType: "image" });
  await task.saveResult(assets);
  for (let index = 0; index < assets.length; index++) {
    const asset = assets[index]!;
    if (asset.type === "base64") continue;
    let url = publicUrl(asset.url);
    let response: Response;
    const signal = AbortSignal.timeout(120000);
    for (let redirects = 0; ; redirects++) {
      response = await context.tool.fetch(publicUrl(url), { signal, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects >= 5) throw new Error("Dola 原图下载重定向无效，请恢复原任务");
      url = new URL(location, url).href;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Dola 原图下载失败（HTTP ${response.status}）；请恢复原任务，已下载图片会保留`); }
    const usedBytes = assets.reduce((total, item) => total + (item.type === "base64" ? Math.ceil(item.data.length * 3 / 4) : 0), 0);
    const bytes = await responseBytes(response, 100 * 1024 * 1024 - usedBytes);
    assets[index] = { type: "base64", data: bytes.toString("base64"), mimeType: imageMime(bytes), mediaType: "image" };
    await task.saveResult(assets);
  }
  return assets;
}

async function generate(context: ProviderContext, kind: "image" | "video", request: ImageRequest | VideoRequest): Promise<MediaAsset[]> {
  const task = kind === "image" ? context.imageTask : context.videoTask;
  if (!task) throw new Error("Dola 需要 Toonflow 的持久化任务支持，请从画布或媒体生成工具中使用");
  apiBase(context);
  if (["failed", "expired"].includes(task.state.phase)) throw new Error(task.state.error || "Dola 原任务已结束，请确认后再创建新任务");
  if (task.state.retryAt && task.state.retryAt > Date.now()) throw new Error(`请在 ${Math.ceil((task.state.retryAt - Date.now()) / 1000)} 秒后恢复 Dola 原任务`);
  let saved: DolaSnapshot;
  if (task.requestSaved) {
    const text = kind === "image" ? (await context.imageTask!.readRequest()).body : await context.videoTask!.readRequest();
    saved = JSON.parse(text);
    if (saved.payload?.client_task_id !== task.id || saved.payload?.kind !== kind || !Array.isArray(saved.imageHashes)) throw new Error("Dola 原请求记录与当前任务不符，不能重新提交");
  } else {
    saved = await createSnapshot(context, kind, request);
    if (kind === "image") await context.imageTask!.saveRequest({ endpoint: "/v1/task", body: JSON.stringify(saved) });
    else await context.videoTask!.saveRequest(JSON.stringify(saved));
  }
  const cached = kind === "image" ? await context.imageTask!.readResult() : undefined;
  if (cached?.length === 4 && cached.every(asset => asset.type === "base64")) return cached;
  if (!task.state.taskId) await submitTask(context, saved);
  const urls = await waitTask(context, kind);
  return kind === "image" ? downloadImages(context, urls, cached) : [await context.videoTask!.download(urls[0]!, {}, "publicCdn")];
}

export default {
  id: "dola",
  label: "Dola 图片与视频",
  version: "1.0.0",
  apiUrl: "https://dola-api.aa01.cn",
  readme: "内置 Dola 当前全部 4 个模型，填写 API Key 即可使用，API 地址可修改。Seedream 仅支持文生图，每单固定 4 张（在节点历史记录中切换），尺寸由渠道决定。Seedance 支持文生视频和最多 9 张图片参考，不支持视频、音频参考或首尾帧控制；2.0 最长约 15 秒，2.5 可选 5/10/15/30 秒。分辨率与声音由渠道决定。基础额度：生图 0.01/单，2.5 视频 2/单，2.0 视频 1/单，以接口结算为准。参考图按 SHA-256 查重，缓存按账号隔离，过期会重新取引用。异步生成，等待至少 150 分钟；中断后恢复原任务，不会换编号重新扣费。请及时下载成品。",
  rules,
  models: [
    { id: "Seedream 5.0 Pro", label: "Seedream 5.0 Pro · 每次 4 张", type: "image", mode: ["text"], taskRecovery: true, imageSizes: ["自动"], imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"] },
    { id: "Seedream 4.0", label: "Seedream 4.0 · 每次 4 张", type: "image", mode: ["text"], taskRecovery: true, imageSizes: ["自动"], imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"] },
    { id: "seedance_v2.5", label: "Seedance 2.5 · 最长 30 秒", type: "video", mode: ["text", ["imageReference:9"]], taskRecovery: true, durationResolutionMap: [{ duration: [5, 10, 15, 30], resolution: [] }], videoRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"] },
    { id: "seedance_v2.0", label: "Seedance 2.0 · 最长约 15 秒", type: "video", mode: ["text", ["imageReference:9"]], taskRecovery: true, durationResolutionMap: [{ duration: [5, 10, 15], resolution: [] }], videoRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"] },
  ],
  async generateImage(request: ImageRequest) { return generate(this, "image", request); },
  async generateVideo(request: VideoRequest) { return generate(this, "video", request); },
} satisfies ProviderDefinition<typeof rules>;
