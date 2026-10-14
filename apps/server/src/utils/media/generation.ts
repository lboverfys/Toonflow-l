import { t, translateMessage } from "@/lib/i18n";
import { mkdir, readFile, realpath, stat, unlink } from "@toonflow/file";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { mediaProviders, type Provider, type VideoTaskContext, type ImageTaskContext } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, MediaModel, MediaReference } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { getMediaProvider, listMediaProviders, loadMediaProviderSource } from "@/utils/media/provider";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { runVideoTask } from "@/utils/media/videoTasks";
export { getVideoTask, getVideoTaskRequest } from "@/utils/media/videoTasks";
import { runImageTask } from "@/utils/media/imageTasks";
import { getOssStorageSettings, uploadOssReferences } from "@/utils/media/oss";
import { detectMimeType } from "@/utils/media/mimeType";
export { getImageTask, getImageTaskRequest } from "@/utils/media/imageTasks";

const maxMediaSize = 100 * 1024 * 1024;
const mediaExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/opus": "opus", "audio/pcm": "pcm",
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageOptions(value: unknown, pattern: RegExp) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 64 && item === item.trim() && pattern.test(item)))] : undefined;
}

export async function listMediaModels(): Promise<MediaModel[]> {
  const installedProviders = await listMediaProviders();
  return installedProviders.flatMap(provider => provider.models.flatMap(model => {
    if (model.type !== "image" && model.type !== "video" && model.type !== "audio") return [];
    const builtIn = (mediaProviders as readonly Provider[]).find(item => item.id === provider.id)?.models.find(item => item.id === model.id);
    return [{
      providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label, type: model.type,
      mode: model.mode, durationResolutionMap: model.durationResolutionMap, audio: model.audio,
      ...(model.type === "video" ? {
        videoRatios: imageOptions(model.videoRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/),
        referenceImageInput: model.referenceImageInput === "url" ? "url" : undefined,
        referenceAudioInput: model.referenceAudioInput === "url" ? "url" : undefined,
        supportsSeed: model.supportsSeed === true,
        minReferenceImages: typeof model.minReferenceImages === "number" && Number.isInteger(model.minReferenceImages) && model.minReferenceImages > 0 && model.minReferenceImages <= 64 ? model.minReferenceImages : undefined,
        defaultDuration: typeof model.defaultDuration === "number" && Number.isFinite(model.defaultDuration) && model.defaultDuration > 0 ? model.defaultDuration : undefined,
        defaultResolution: typeof model.defaultResolution === "string" ? model.defaultResolution : undefined,
      } : {}),
      taskRecovery: model.taskRecovery === true,
      ...(model.type === "audio" ? { voices: model.voices } : {}),
      ...(model.type === "image" ? {
        imageSizes: imageOptions(Array.isArray(model.imageSizes) ? model.imageSizes : builtIn?.imageSizes, /^[^\u0000-\u001f\u007f]+$/),
        imageRatios: imageOptions(Array.isArray(model.imageRatios) ? model.imageRatios : builtIn?.imageRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/),
      } : {}),
    } as MediaModel];
  }));
}

export async function readReference(cwd: string, reference: MediaReference, mediaType: string, signal?: AbortSignal): Promise<Extract<MediaInput, { type: "base64" }>> {
  signal?.throwIfAborted();
  const { path } = await resolveWorkspacePath(cwd, reference.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxMediaSize) invalid("参考媒体须为不超过 100 MB 的文件");
  const bytes = await readFile(path, { signal });
  if (!bytes.length || bytes.length > maxMediaSize) invalid("参考媒体为空或超过 100 MB");
  const mimeType = detectMimeType(bytes, reference.mimeType);
  if (!mimeType.startsWith(`${mediaType}/`)) invalid(t`参考媒体类型须为 ${mediaType}`);
  return { type: "base64", data: bytes.toString("base64"), mimeType, name: reference.path };
}

async function downloadAsset(url: string, signal?: AbortSignal) {
  if (!/^https?:\/\//i.test(url)) invalid("生成结果必须使用 HTTP 或 HTTPS 地址");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(t`下载生成结果失败（HTTP ${response.status}）`);
  if (Number(response.headers.get("content-length")) > maxMediaSize) {
    await response.body?.cancel();
    invalid("生成文件不能超过 100 MB");
  }
  const reader = response.body?.getReader();
  if (!reader) invalid("生成结果为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxMediaSize) invalid("生成文件不能超过 100 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { bytes: Buffer.concat(chunks, size), mimeType: response.headers.get("content-type") ?? "" };
}

async function assetBytes(asset: MediaAsset, mediaType: "image" | "video" | "audio", signal?: AbortSignal) {
  if (!asset || asset.mediaType !== mediaType) invalid("供应商返回的媒体类型不正确");
  let bytes: Uint8Array;
  let mimeType = asset.mimeType ?? "";
  if (asset.type === "url") {
    const result = await downloadAsset(asset.url, signal);
    bytes = result.bytes;
    const responseMimeType = result.mimeType.split(";")[0].trim().toLowerCase();
    mimeType = responseMimeType && responseMimeType !== "application/octet-stream" ? result.mimeType : mimeType;
  } else if (asset.type === "base64") {
    const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(asset.data);
    const content = (data?.[2] ?? asset.data).replace(/\s/g, "");
    if (content.length > Math.ceil(maxMediaSize / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(content) || content.length % 4 === 1) invalid("生成结果的 base64 内容无效或超过 100 MB");
    bytes = Buffer.from(content, "base64");
    mimeType = data?.[1] ?? mimeType;
  } else if (asset.type === "binary" && ArrayBuffer.isView(asset.data) && asset.data.BYTES_PER_ELEMENT === 1) {
    bytes = asset.data;
  } else { return invalid("供应商返回了无效的媒体结果"); }
  if (!bytes.byteLength || bytes.byteLength > maxMediaSize) invalid("生成文件为空或超过 100 MB");
  mimeType = detectMimeType(bytes, mimeType);
  if (!mimeType.startsWith(`${mediaType}/`) || !mediaExtensions[mimeType]) invalid("生成结果不是支持的图片、视频或音频格式");
  return { bytes, mimeType };
}

const activeNodeGenerations = new Set<string>();

export async function generateMedia(
  cwd: string, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest,
  signal?: AbortSignal, videoTask?: VideoTaskContext, imageTask?: ImageTaskContext,
): Promise<GeneratedMedia[]> {
  const directory = await realpath(cwd);
  const outputDirectory = request.outputDirectory ?? "assets/generated";
  const output = await resolveWorkspacePath(directory, outputDirectory, true);
  const parts = relative(directory, output.path).replaceAll("\\", "/").split("/");
  const nodePath = parts[0] === "assets" && parts[1] !== "generated" && (parts.length === 2 || parts.length === 3 && parts[2] === "inpaint")
    ? join(directory, "assets", parts[1]!) : undefined;
  const key = !videoTask && !imageTask && nodePath ? process.platform === "win32" ? nodePath.toLowerCase() : nodePath : undefined;
  if (key && activeNodeGenerations.has(key)) throw Object.assign(new Error("此节点已有设备正在生成，请等待完成，未提交新的生成任务"), { status: 409 });
  if (key) activeNodeGenerations.add(key);
  try { return await generateMediaResult(directory, mediaType, request, signal, videoTask, imageTask); }
  finally { if (key) activeNodeGenerations.delete(key); }
}

async function generateMediaResult(
  directory: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
  videoTask?: VideoTaskContext,
  imageTask?: ImageTaskContext,
): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  if (!request.prompt.trim()) invalid("请输入生成提示词");
  const outputDirectory = request.outputDirectory ?? "assets/generated";
  const providerInfo = await getMediaProvider(request.providerId);
  const model = providerInfo.models.find(model => model.id === request.modelId && model.type === mediaType);
  if (!model) invalid("所选媒体模型不存在或类型不匹配，请重新选择");
  const configurations = record(conf.get("settings", {}).mediaProviderConfigs);
  const provider = await loadMediaProviderSource(providerInfo.source, record(configurations[providerInfo.id]), signal, undefined, directory, videoTask, imageTask);
  const generate = mediaType === "image" ? provider.generateImage : mediaType === "video" ? provider.generateVideo : provider.generateAudio;
  if (typeof generate !== "function") invalid(t`此供应商不支持${translateMessage({ image: "图片", video: "视频", audio: "音频" }[mediaType])}生成`);
  const rules = Array.isArray(provider.rules) ? provider.rules : [];
  if (rules.some(rule => rule.field === "apiKey") && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) invalid("请先在媒体模型设置中配置供应商 API Key");
  if (!videoTask?.requestSaved) {
    if (mediaType === "video" && typeof model.minReferenceImages === "number" && (request.images?.length ?? 0) + (request.referenceImageUrls?.length ?? 0) < model.minReferenceImages) invalid(`当前模型至少需要 ${model.minReferenceImages} 张参考图片`);
    if (request.referenceImageUrls?.length && (mediaType !== "video" || model.referenceImageInput !== "url")) invalid("当前模型不支持参考图链接输入");
    if ([request.firstFrame, request.lastFrame].some(frame => frame && "url" in frame) && (mediaType !== "video" || model.referenceImageInput !== "url")) invalid("当前模型不支持首尾帧链接输入");
    if (mediaType === "video" && (request.mode === "startEndRequired" || Array.isArray(model.mode) && model.mode.length === 1 && model.mode[0] === "startEndRequired")) {
      if (!request.firstFrame || !request.lastFrame) invalid("首尾帧模式需要同时提供首帧和尾帧图片");
      if (request.images?.length || request.referenceImageUrls?.length || request.audios?.length || request.videos?.length) invalid("首尾帧模式不支持额外参考图片、音频或视频");
    }
    if (mediaType === "video" && model.referenceImageInput === "url" && (request.images?.length ?? 0) + (request.referenceImageUrls?.length ?? 0) > 9) invalid("本地参考图与 HTTPS 链接合计最多 9 张");
    if (request.seed !== undefined && (mediaType !== "video" || model.supportsSeed !== true || !Number.isSafeInteger(request.seed))) invalid("当前模型不支持 seed 或 seed 不是安全整数");
    if (mediaType === "video" && model.referenceAudioInput === "url") {
      const modes = Array.isArray(model.mode) ? model.mode.filter(Array.isArray) : [];
      const limit = Math.max(0, ...modes.flat().filter((value): value is string => typeof value === "string" && /^audioReference:\d+$/.test(value)).map(value => Number(value.split(":")[1])));
      if ((request.audios?.length ?? 0) > limit) invalid(`当前模型最多支持 ${limit} 段参考音频`);
    }
  }
  if (mediaType === "video" && model.taskRecovery === true && !videoTask) {
    return runVideoTask(directory, request, provider.config,
      (saved, context) => generateMedia(directory, "video", saved, signal, context),
      () => Promise.all((request.images ?? []).map(image => readReference(directory, image, "image", signal))), provider.tool.errorMessage, signal);
  }
  if (mediaType === "image" && model.taskRecovery === true && !imageTask) {
    return runImageTask(directory, request, provider.config,
      (saved, context) => generateMedia(directory, "image", saved, signal, undefined, context), provider.tool.errorMessage, signal);
  }
  // 恢复使用首次保存的原始请求，不重新读取可能已修改或删除的参考素材。
  const restoring = videoTask?.requestSaved === true || imageTask?.requestSaved === true;
  const uploadImages = !restoring && mediaType === "video" && model.referenceImageInput === "url";
  const uploadAudios = !restoring && mediaType === "video" && model.referenceAudioInput === "url";
  const localFrames = [request.firstFrame, request.lastFrame].filter((frame): frame is MediaReference => !!frame && "path" in frame);
  const uploadReferences = [...(uploadImages ? [...(request.images ?? []), ...localFrames] : []), ...(uploadAudios ? request.audios ?? [] : [])];
  const ossConfig = uploadReferences.length ? getOssStorageSettings() : undefined;
  if (ossConfig) {
    let total = 0;
    for (const input of uploadReferences) {
      const { path } = await resolveWorkspacePath(directory, input.path);
      const info = await stat(path);
      if (!info.isFile() || !info.size || info.size > 20 * 1024 * 1024) invalid("OSS 本地参考素材为空或超过单个 20 MiB 的传输限制");
      total += info.size;
      if (total > 50 * 1024 * 1024) invalid("OSS 本地参考素材合计超过 50 MiB 的传输限制");
    }
  }
  if (!restoring && providerInfo.id === "dola") {
    if (mediaType === "image" && request.images?.length) invalid("Dola 图片模型仅支持文生图，不能使用参考图或局部重绘");
    if ((request.images?.length ?? 0) > 9) invalid("Dola 视频最多使用 9 张参考图片");
    for (const image of request.images ?? []) {
      const { path } = await resolveWorkspacePath(directory, image.path);
      const info = await stat(path);
      if (!info.isFile() || !info.size || info.size > 20 * 1024 * 1024) invalid("Dola 参考图片为空或超过 20 MiB");
    }
  }
  if (!restoring && providerInfo.id === "laoliVideo") {
    if ((request.images?.length ?? 0) > 30) invalid("特价 2.5 最多使用 30 张参考图片");
    let total = 0;
    for (const image of request.images ?? []) {
      const { path } = await resolveWorkspacePath(directory, image.path);
      const info = await stat(path);
      if (!info.isFile() || !info.size || info.size > 50 * 1024 * 1024) invalid("参考图片为空或超过 50 MiB");
      total += info.size;
      if (total > 70 * 1024 * 1024) invalid("参考图片合计不能超过 70 MiB");
    }
  }
  if (!restoring && providerInfo.id === "fankeVideo") {
    const limits = (Array.isArray(model.mode) ? model.mode : []).find(Array.isArray) ?? [];
    for (const [type, items] of [["image", request.images], ["audio", request.audios]] as const) {
      const limit = Number(limits.find(value => typeof value === "string" && value.startsWith(`${type}Reference:`))?.split(":")[1] ?? 0);
      if ((items?.length ?? 0) > limit) invalid(`此 Foke Video 模型最多支持 ${limit} 个 ${type === "image" ? "图片" : "音频"}参考`);
    }
    if (request.videos?.length || request.firstFrame || request.lastFrame) invalid("这 4 个 Foke Video 模型不支持参考视频或首尾帧模式");
    let total = 0;
    for (const input of [...(request.images ?? []), ...(request.audios ?? [])]) {
      const { path } = await resolveWorkspacePath(directory, input.path);
      const info = await stat(path);
      if (!info.isFile() || !info.size) invalid("Foke Video 参考素材必须为非空文件");
      total += info.size;
      if (total > 90 * 1024 * 1024) invalid("Foke Video 参考素材合计超过本地 90 MiB 传输上限");
    }
  }
  if (!restoring && providerInfo.id === "laoliImage") {
    let total = 0;
    for (const image of request.images ?? []) {
      const { path } = await resolveWorkspacePath(directory, image.path);
      const info = await stat(path);
      if (!info.isFile() || !info.size || info.size > 25 * 1024 * 1024) invalid("参考图为空或超过当前 25 MiB 单图传输预算");
      total += info.size;
      if (total > 32 * 1024 * 1024) invalid("参考图合计超过当前 32 MiB 传输预算");
    }
  }
  const references = async (items: MediaReference[] | undefined, type: string) => items ? Promise.all(items.map(item => readReference(directory, item, type, signal))) : undefined;
  let images: MediaInput[] | undefined = restoring ? undefined : await references(request.images, "image");
  let audios: MediaInput[] | undefined = restoring || mediaType === "image" ? undefined : await references(request.audios, "audio");
  let [firstFrame, lastFrame] = await Promise.all([request.firstFrame, request.lastFrame].map(async (frame): Promise<MediaInput | undefined> => {
    if (restoring || mediaType !== "video" || !frame) return undefined;
    return "url" in frame ? { type: "url", url: frame.url } : readReference(directory, frame, "image", signal);
  }));
  if (!restoring && request.referenceImageUrls?.length) images = [...(images ?? []), ...request.referenceImageUrls.map((url): MediaInput => ({ type: "url", url }))];
  if (ossConfig) {
    const imageInputs = uploadImages ? [...(images ?? []), ...(firstFrame ? [firstFrame] : []), ...(lastFrame ? [lastFrame] : [])] : [];
    const uploaded = await uploadOssReferences([...imageInputs, ...(uploadAudios ? audios ?? [] : [])], ossConfig, signal);
    if (uploadImages) {
      let frameIndex = images?.length ?? 0;
      if (images) images = uploaded.slice(0, frameIndex);
      if (firstFrame) firstFrame = uploaded[frameIndex++];
      if (lastFrame) lastFrame = uploaded[frameIndex];
    }
    if (uploadAudios && audios) audios = uploaded.slice(imageInputs.length);
  }
  signal?.throwIfAborted();
  const assets = mediaType === "audio"
    ? await provider.generateAudio!({
      model: request.modelId, text: request.prompt, images, audios,
      voice: request.voice, speed: request.speed, volume: request.volume, pitch: request.pitch, language: request.language, format: request.format, sampleRate: request.sampleRate,
    })
    : mediaType === "image"
    ? await provider.generateImage!({ model: request.modelId, prompt: request.prompt, images, ratio: request.ratio, size: request.size })
    : await provider.generateVideo!({
      model: request.modelId, prompt: request.prompt, images,
      videos: restoring ? undefined : await references(request.videos, "video"), audios,
      firstFrame, lastFrame,
      ratio: request.ratio, resolution: request.resolution, duration: request.duration,
      generateAudio: request.generateAudio, mode: request.mode, seed: request.seed,
    });
  if (!Array.isArray(assets) || !assets.length) invalid("供应商未返回生成结果");
  if (videoTask && assets.length !== 1) invalid("此任务应生成一条视频");
  if (imageTask && assets.length !== (providerInfo.id === "dola" ? 4 : 1)) invalid("图片任务返回的数量与渠道约定不符，已保留原任务");
  if (videoTask?.downloaded) {
    if (assets[0] !== videoTask.downloaded) invalid("供应商返回的文件不是本任务下载结果");
    signal?.throwIfAborted();
    const { path, mimeType, mediaType: resultType } = videoTask.downloaded;
    return [{ path, mimeType, mediaType: resultType }];
  }
  const written: string[] = [];
  const result: GeneratedMedia[] = [];
  try {
    for (const [index, asset] of assets.entries()) {
      signal?.throwIfAborted();
      const { bytes, mimeType } = await assetBytes(asset, mediaType, signal);
      signal?.throwIfAborted();
      const output = await resolveWorkspacePath(directory, outputDirectory, true);
      const release = lockWorkspaceFiles([output.path]);
      try {
        await mkdir(output.path, { recursive: true });
        const suffix = imageTask && assets.length > 1 ? `_${index + 1}` : "";
        const file = join(outputDirectory, `${mediaType}${videoTask?.id ?? imageTask?.id ?? crypto.randomUUID()}${suffix}.${mediaExtensions[mimeType]}`);
        const { path } = await resolveWorkspacePath(directory, file);
        signal?.throwIfAborted();
        try { await writeWorkspaceFile(path, bytes, true); written.push(path); }
        catch (error) {
          if ((!videoTask && !imageTask) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = await stat(path);
          if (!existing.isFile() || existing.size !== bytes.byteLength) throw new Error("原任务媒体文件已发生变化，请保留文件并检查");
          const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
          if (digest(await readFile(path)) !== digest(bytes)) throw new Error("原任务媒体文件内容不同，未覆盖已有文件");
        }
        result.push({ path: relative(directory, path).replace(/\\/g, "/"), mimeType, mediaType });
      } finally { release(); }
    }
    signal?.throwIfAborted();
    return result;
  } catch (err) {
    // ACT: 只回滚本次创建的文件，保留目录中已有的节点资源。
    if (!videoTask && !imageTask) await Promise.all(written.map(path => unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
    throw err;
  }
}
