import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData } from "@toonflow/ffmpeg/browser";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/runtime";
import { parseSrt, serializeSrt } from "@toonflow/node-shared/subtitleSrt";

function query<T>(command: BrowserFfmpegCommand, start: (callback: (error: Error | null, result: T) => void) => void, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const cancel = () => command.kill();
  signal?.addEventListener("abort", cancel, { once: true });
  return new Promise<T>((resolve, reject) => {
    start((error, result) => {
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve(result);
    });
  }).finally(() => signal?.removeEventListener("abort", cancel));
}

function probe(ffmpeg: BrowserFfmpegFactory, path: string, signal?: AbortSignal) {
  const command = ffmpeg(path);
  return query<FfprobeData>(command, callback => command.ffprobe(callback), signal);
}

function videoInfo(media: FfprobeData) {
  const stream = media.streams.find(item => item.codec_type === "video" && !item.disposition?.attached_pic);
  if (!stream) throw new Error("文件不包含视频画面");
  const streamDuration = Number(stream.duration);
  const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(media.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取有效的视频时长");
  return { stream, duration };
}

function execute(command: BrowserFfmpegCommand, signal?: AbortSignal, onProgress?: (percent: number) => void) {
  signal?.throwIfAborted();
  const cancel = () => command.kill();
  signal?.addEventListener("abort", cancel, { once: true });
  return new Promise<void>((resolve, reject) => {
    command.on("start", () => { if (signal?.aborted) command.kill(); });
    command.on("progress", progress => {
      if (Number.isFinite(progress.percent)) onProgress?.(Math.max(0, Math.min(99, progress.percent!)));
    });
    // kill 只请求停止；等宿主 end/error 后才允许调用方清理正在使用的文件。
    command.on("error", error => reject(signal?.aborted ? signal.reason : error));
    command.on("end", () => signal?.aborted ? reject(signal.reason) : resolve());
    command.run();
  }).finally(() => signal?.removeEventListener("abort", cancel));
}

/** 本函数创建素材、清理失败/取消目录；成功目录保留为输出历史，由宿主管理节点删除。 */
export async function burnVideo(
  ffmpeg: BrowserFfmpegFactory,
  files: WorkspaceFiles,
  nodeId: string,
  videoPath: string,
  srt: string,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void,
) {
  signal?.throwIfAborted();
  if (!/^[a-zA-Z0-9_-]+$/.test(nodeId)) throw new Error("节点 ID 不能作为安全素材文件夹名称");
  if (!videoPath || /[\\\x00-\x1f]/.test(videoPath) || /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(videoPath)
    || videoPath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("字幕烧录必须使用工作区相对视频路径");
  }
  const segments = parseSrt(srt);
  if (!segments.length) throw new Error("字幕输入没有有效分段");
  const subtitle = serializeSrt(segments);
  const media = await probe(ffmpeg, videoPath, signal);
  const { stream } = videoInfo(media);
  const filterCommand = ffmpeg();
  const filters = await query<Record<string, unknown>>(
    filterCommand, callback => filterCommand.availableFilters(callback), signal,
  );
  if (!filters.subtitles) throw new Error("本机 FFmpeg 缺少 subtitles 滤镜（需要 libass）");
  const encoderCommand = ffmpeg();
  const encoders = await query<Record<string, unknown>>(encoderCommand, callback => encoderCommand.availableEncoders(callback), signal);
  if (!encoders.libx264) throw new Error("本机 FFmpeg 缺少 libx264 视频编码器");
  const hasAudio = media.streams.some(item => item.codec_type === "audio");
  if (hasAudio && !encoders.aac) throw new Error("本机 FFmpeg 缺少 AAC 音频编码器");
  const directory = `assets/${nodeId}/burn${crypto.randomUUID().replaceAll("-", "")}`;
  const path = `${directory}/burned.mp4`;
  let created = false;
  try {
    for (const parent of ["assets", `assets/${nodeId}`]) {
      signal?.throwIfAborted();
      await files.mkdir(parent).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
        if (error.response?.data?.data?.code !== "EEXIST") throw error;
      });
    }
    signal?.throwIfAborted();
    await files.mkdir(directory);
    created = true;
    signal?.throwIfAborted();
    const subtitlePath = `${directory}/subtitle.srt`;
    await files.write(subtitlePath, subtitle, true);
    signal?.throwIfAborted();
    const command = ffmpeg(videoPath).output(path).videoCodec("libx264").format("mp4")
      .videoFilters([
        { filter: "subtitles", options: { filename: subtitlePath } },
        { filter: "pad", options: "ceil(iw/2)*2:ceil(ih/2)*2" },
      ])
      .outputOptions("-n", "-map", `0:${stream.index}`, "-map", "0:a:0?", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (hasAudio) command.audioCodec("aac");
    else command.noAudio();
    await execute(command, signal, onProgress);
    const result = videoInfo(await probe(ffmpeg, path, signal));
    signal?.throwIfAborted();
    onProgress?.(100);
    return { path, duration: result.duration, width: result.stream.width, height: result.stream.height };
  } catch (failure) {
    if (created) {
      try { await files.remove(directory, true); }
      catch (cleanupFailure) {
        const message = (cleanupFailure as { response?: { data?: { message?: string } } })?.response?.data?.message
          || (cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure));
        const original = failure instanceof Error ? failure.message : String(failure);
        throw new Error(`${original}\n本次素材清理失败，保留目录 ${directory}：${message}`, { cause: new AggregateError([failure, cleanupFailure]) });
      }
    }
    throw failure;
  }
}
