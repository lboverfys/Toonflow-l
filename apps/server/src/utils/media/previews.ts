import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { mkdir, stat, unlink, rename, withFileAccess } from "@toonflow/file";
import { cacheDirectory, cacheFile, readCache, scheduleCachePrune, touchCache, writeCache } from "@/utils/cache";
import { getStatus } from "@/utils/ffmpeg";
import conf from "@/utils/conf";

const execute = promisify(execFile);
type PreviewJob = { promise: Promise<string | undefined>; controller: AbortController; users: number };
const pending = new Map<string, PreviewJob>();
let queue = Promise.resolve();
let toolStatus: { key: string; expires: number; value: ReturnType<typeof getStatus> } | undefined;
type MediaInfo = { width?: number; height?: number; duration?: number };

export async function mediaPreview(source: string, revision: string, mimeType: string, size: 512 | 1024, signal: AbortSignal) {
  if (!/^(image\/(png|jpeg|webp|avif|bmp)|video\/)/.test(mimeType)) return source;
  const video = mimeType.startsWith("video/");
  const identity = JSON.stringify([source, revision, video ? 640 : size, 1]);
  const output = cacheFile("mediaPreviews", identity, video ? "jpg" : "png");
  if (await stat(output).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })) { touchCache(output); return output; }
  let job = pending.get(output);
  if (!job) {
    const controller = new AbortController();
    const signal = controller.signal;
    const operation = queue.then(async () => {
      signal.throwIfAborted();
      const key = JSON.stringify(conf.get("settings", {}).ffmpeg ?? {});
      if (!toolStatus || toolStatus.key !== key || toolStatus.expires < Date.now()) toolStatus = { key, expires: Date.now() + 30000, value: getStatus() };
      const { tools } = await toolStatus.value;
      if (!tools.ffmpeg.path || tools.ffmpeg.error || !tools.ffprobe.path || tools.ffprobe.error) return video ? undefined : source;
      const temporaryDirectory = join(dirname(cacheDirectory), "temp", "mediaPreviews");
      await mkdir(temporaryDirectory, { recursive: true });
      await mkdir(dirname(output), { recursive: true });
      const temporary = join(temporaryDirectory, `${crypto.randomUUID()}.${video ? "jpg" : "png"}`);
      try {
        const limit = video ? 640 : size;
        await withFileAccess([source], "read", async () => {
          await execute(tools.ffmpeg.path!, ["-nostdin", "-v", "error", "-threads", "1", "-protocol_whitelist", "file,pipe", "-i", source,
            "-frames:v", "1", "-vf", `scale=w='min(${limit},iw)':h='min(${limit},ih)':force_original_aspect_ratio=decrease`, "-threads", "1", "-y", temporary],
          { windowsHide: true, signal, timeout: 30000, maxBuffer: 1024 * 1024 });
          const metadataPath = cacheFile("mediaPreviews", JSON.stringify([source, revision, "info"]));
          if (!await readCache<MediaInfo>(metadataPath)) {
            const { stdout } = await execute(tools.ffprobe.path!, ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration:stream=width,height,codec_type", "-of", "json", source],
              { windowsHide: true, signal, timeout: 15000, maxBuffer: 1024 * 1024 });
            const data = JSON.parse(stdout) as { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } };
            const stream = data.streams?.find(stream => stream.codec_type === "video");
            await writeCache(metadataPath, { width: stream?.width, height: stream?.height, duration: Number(data.format?.duration) || undefined });
          }
        }, signal);
        await rename(temporary, output);
        touchCache(output);
        scheduleCachePrune();
        return output;
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
    }).finally(() => { if (pending.get(output) === job) pending.delete(output); });
    queue = operation.then(() => {}, () => {});
    job = { promise: operation, controller, users: 0 };
    pending.set(output, job);
  }
  job.users++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--job.users === 0) {
      if (pending.get(output) === job) pending.delete(output);
      job.controller.abort();
    }
  };
  signal.addEventListener("abort", release, { once: true });
  if (signal.aborted) release();
  try {
    const result = await job.promise;
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener("abort", release); release(); }
}
