import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, open, readFile, readdir, stat, writeAtomic } from "@toonflow/file";

if (!process.env.TOONFLOW_TEST_DIR || !process.env.TOONFLOW_TEST_VIDEO) throw new Error("请设置 D 盘的 TOONFLOW_TEST_DIR 和 TOONFLOW_TEST_VIDEO，测试不会自动下载素材");
await mkdir(process.env.TOONFLOW_TEST_DIR, { recursive: true });
const root = await mkdtemp(join(process.env.TOONFLOW_TEST_DIR, "laoli"));
process.env.TOONFLOW_DATA_DIR = join(root, "data");
const video = await readFile(process.env.TOONFLOW_TEST_VIDEO);
const png = await readFile(resolve(import.meta.dirname, "../../../docs/images/logo.png"));
const otherPng = await readFile(resolve(import.meta.dirname, "../../../docs/images/qr.png"));
const key = "laoli-mock-key";
let mode = "success";
let posts: { key: string; body: string }[] = [];
let queries = 0;
let downloads: Headers[] = [];
let redirected = 0;
const submitted = new Map<string, { body: string; id: string }>();
const processes: ReturnType<typeof Bun.spawn>[] = [];
const controllers: AbortController[] = [];
const pending: Promise<unknown>[] = [];
let releaseCreate: (() => void) | undefined;

async function handleRequest(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/leak") { redirected++; return new Response(video); }
    if (request.headers.get("authorization") !== `Bearer ${key}`) return Response.json({ error: { message: "认证失败" } }, { status: 401 });
    if (request.method === "POST" && path === "/v1/videos") {
      const body = await request.text();
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      posts.push({ key: idempotencyKey, body });
      if (mode === "explicitFailure") return Response.json({ code: "fail_to_fetch_task", message: JSON.stringify({ error: { code: "UPSTREAM_QUOTA_EXHAUSTED", message: "额度不足", submitted: false, retryable: false } }) }, { status: 402 });
      if (mode === "referenceFailure") return Response.json({ error: { code: "REFERENCE_PREPARATION_FAILED", message: "参考图准备失败", submitted: false, retryable: false } }, { status: 424 });
      if (mode === "conflict") return Response.json({ error: { type: "idempotency_conflict", message: "原提交冲突，请核查" } }, { status: 409 });
      const existing = submitted.get(idempotencyKey);
      if (existing && existing.body !== body) return Response.json({ error: { type: "idempotency_conflict" } }, { status: 409 });
      const task = existing ?? { body, id: `task_${crypto.randomUUID()}` };
      submitted.set(idempotencyKey, task);
      if (mode === "holdCreate") await new Promise<void>(resolve => { releaseCreate = resolve; });
      if (mode === "lostReceipt" && posts.length === 1) return Response.json({ error: { message: "响应丢失" } }, { status: 503 });
      if (mode === "missingId" && posts.length === 1) return Response.json({ status: "queued" }, { status: 202 });
      if (mode === "idempotencyPending" && posts.length === 1) return Response.json({ error: { code: "idempotency_in_progress" } }, { status: 409, headers: { "retry-after": "0" } });
      if (mode === "unknownReceipt") return Response.json({ error: { message: "网关暂不可用" } }, { status: 503 });
      if (mode === "receiptTaskId") return Response.json({ id: "", task_id: task.id, status: "queued" });
      return Response.json({ id: task.id, status: "queued" }, { status: 202 });
    }
    if (path.endsWith("/download")) {
      downloads.push(new Headers(request.headers));
      if (mode === "redirectDownload") return new Response(null, { status: 302, headers: { location: `http://localhost:${port}/leak` } });
      if (mode === "downloadFailure") return Response.json({ error: { message: "暂时不能取片" } }, { status: 503 });
      if (mode === "htmlDownload") return new Response("<html>failed</html>", { headers: { "content-type": "text/html", "x-video-quality": "original" } });
      if (mode === "fakeMp4") return new Response("not-a-video", { headers: { "content-type": "video/mp4", "x-video-quality": "original" } });
      const headers: Record<string, string> = { "content-type": "video/mp4", "x-video-quality": mode === "previewDownload" ? "preview" : "original", etag: '"sample"' };
      const range = request.headers.get("range");
      if (range && mode === "rangeExpired") return new Response(null, { status: 416 });
      if (range && mode !== "ignoreRange") {
        const offset = Number(/^bytes=(\d+)-$/.exec(range)![1]);
        headers["content-range"] = `bytes ${mode === "badRange" ? offset + 1 : offset}-${video.length - 1}/${video.length}`;
        return new Response(video.subarray(offset), { status: 206, headers });
      }
      return new Response(video, { headers });
    }
    if (path.startsWith("/v1/videos/")) {
      queries++;
      if (mode === "failed") return Response.json({ status: "failed", error: { code: "video_generation_failed", message: "模拟审核失败" } });
      if (mode === "secretFailure") return Response.json({ status: "failed", error: { message: `上游错误 ${key}` } });
      if (mode === "processing") return Response.json({ status: "in_progress", progress: 37, seconds: "16" });
      if (mode === "unknownState") return Response.json({ status: "waiting_for_asset" });
      if (mode === "queryFailure") return Response.json({ code: "task_not_exist", message: "查询暂不可用" }, { status: 400 });
      return Response.json({ status: "completed", progress: 100, url: "https://untrusted.invalid/video.mp4", download_url: "https://untrusted.invalid/download" });
    }
    return new Response("not found", { status: 404 });
}

const server = createServer(async (incoming, outgoing) => {
  if (incoming.url?.endsWith("/download") && mode === "partialDownload") {
    downloads.push(new Headers(incoming.headers as Record<string, string>));
    outgoing.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(video.length), "X-Video-Quality": "original", ETag: '"sample"' });
    outgoing.write(video.subarray(0, 32768));
    setTimeout(() => outgoing.destroy(), 30);
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
    method: incoming.method, headers: incoming.headers as Record<string, string>,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
  const response = await handleRequest(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const { default: conf } = await import("../src/utils/conf");
const { generateMedia, getVideoTask, getVideoTaskRequest } = await import("../src/utils/media/generation");
await mkdir(join(process.env.TOONFLOW_DATA_DIR!, "providers"), { recursive: true });
await writeAtomic(join(process.env.TOONFLOW_DATA_DIR!, "providers/laoliVideo.ts"), await readFile(resolve(import.meta.dirname, "../../../packages/providers/src/media/laoliVideo.ts")));
const config = { apiKey: key, apiUrl: `http://127.0.0.1:${port}` };
function configure(value = config) { conf.set("settings", { mediaProviderConfigs: { laoliVideo: value } }); }
configure();

async function workspace() {
  const cwd = await mkdtemp(join(root, "workspace"));
  await writeAtomic(join(cwd, "one.png"), png);
  await writeAtomic(join(cwd, "two.png"), otherPng);
  return cwd;
}
function request(overrides: Record<string, any> = {}) {
  return { providerId: "laoliVideo", modelId: "特价2.5需要过人脸技术-可参考过人脸素材库", prompt: "单角色走入场景", duration: 16, resolution: "720p", ratio: "16:9", outputDirectory: "assets/shotOne", operationId: crypto.randomUUID(), ...overrides };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("等待模拟事件超时"); await Bun.sleep(20); }
}
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeEach(() => { mode = "success"; posts = []; queries = 0; downloads = []; redirected = 0; submitted.clear(); configure(); });
afterEach(async () => {
  releaseCreate?.();
  releaseCreate = undefined;
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(pending.splice(0));
  for (const child of processes) { if (child.exitCode === null) child.kill(); await child.exited; }
});
afterAll(async () => {
  releaseCreate?.();
  for (const child of processes) { if (child.exitCode === null) child.kill(); await child.exited; }
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  console.log(`模拟接口已关闭，端口 ${port}；测试数据：${root}`);
});

test("完整型号、原始参考图顺序、认证下载和节点结果保存", async () => {
  const cwd = await workspace();
  const input = request({ images: [{ path: "two.png", mimeType: "image/png" }, { path: "one.png", mimeType: "image/png" }] });
  const result = await generateMedia(cwd, "video", input);
  const body = JSON.parse(posts[0]!.body);
  expect(body).toEqual({ model: input.modelId, prompt: input.prompt, duration: 16, resolution: "720p", ratio: "16:9", images: [otherPng.toString("base64"), png.toString("base64")] });
  expect(posts[0]!.key).toBe(input.operationId);
  expect(submitted.size).toBe(1);
  expect(downloads[0]!.get("authorization")).toBe(`Bearer ${key}`);
  expect(result[0]!.path).toStartWith("assets/shotOne/");
  expect(digest(await readFile(join(cwd, result[0]!.path)))).toBe(digest(video));
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("completed");
  expect(await generateMedia(cwd, "video", input)).toEqual(result);
  expect(posts.length).toBe(1);
});

for (const duration of [16, 23, 30]) test(`支持整数时长 ${duration} 秒`, async () => {
  await generateMedia(await workspace(), "video", request({ duration }));
  expect(JSON.parse(posts[0]!.body).duration).toBe(duration);
});
for (const overrides of [{ duration: 15 }, { duration: 31 }, { duration: 16.5 }, { resolution: "1080p" }, { prompt: "字".repeat(15001) }, { images: Array(31).fill({ path: "one.png", mimeType: "image/png" }) }]) test(`无效参数在付费请求前拒绝：${Object.keys(overrides)[0]}`, async () => {
  await expect(generateMedia(await workspace(), "video", request(overrides))).rejects.toThrow();
  expect(posts.length).toBe(0);
});
test("允许三十张参考图并保留重复图", async () => {
  await generateMedia(await workspace(), "video", request({ images: Array(30).fill({ path: "one.png", mimeType: "image/png" }) }));
  expect(JSON.parse(posts[0]!.body).images).toHaveLength(30);
});
test("保留提示词原文和空白，接受 task_id 回执", async () => {
  mode = "receiptTaskId";
  const prompt = "  第一行\n第二行  ";
  await generateMedia(await workspace(), "video", request({ prompt }));
  expect(JSON.parse(posts[0]!.body).prompt).toBe(prompt);
  expect(posts.length).toBe(1);
});
for (const sizes of [[50 * 1024 * 1024 + 1], [36 * 1024 * 1024, 35 * 1024 * 1024]]) test(`在读取大图及提交前检查图片体积：${sizes.length} 张`, async () => {
  const cwd = await workspace();
  const images: { path: string; mimeType: string }[] = [];
  for (const [index, size] of sizes.entries()) {
    const path = `large${index}.png`;
    const handle = await open(join(cwd, path), "wx");
    try { await handle.truncate(size); } finally { await handle.close(); }
    images.push({ path, mimeType: "image/png" });
  }
  await expect(generateMedia(cwd, "video", request({ images }))).rejects.toThrow(sizes.length === 1 ? "50 MiB" : "70 MiB");
  expect(posts.length).toBe(0);
});
test("认证下载拒绝自动重定向，不向其他来源发送密钥", async () => {
  mode = "redirectDownload";
  const cwd = await workspace(), input = request();
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  expect(redirected).toBe(0);
  expect(posts.length).toBe(1);
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("downloading");
});
test("拒绝音视频参考和首尾帧", async () => {
  const cwd = await workspace();
  await writeAtomic(join(cwd, "reference.mp4"), video);
  for (const overrides of [{ videos: [{ path: "reference.mp4", mimeType: "video/mp4" }] }, { firstFrame: { path: "one.png", mimeType: "image/png" } }]) {
    await expect(generateMedia(cwd, "video", request(overrides))).rejects.toThrow("仅支持图片参考");
  }
  expect(posts.length).toBe(0);
});
test("原片下载失败可恢复，不重新 POST", async () => {
  const cwd = await workspace(), input = request();
  mode = "downloadFailure";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("下载");
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("downloading");
  mode = "success";
  await generateMedia(cwd, "video", await getVideoTaskRequest(cwd, input.outputDirectory, input.operationId));
  expect(posts.length).toBe(1);
  expect(queries).toBe(1);
});
test("查询失败保留任务编号，恢复只继续查询", async () => {
  const cwd = await workspace(), input = request();
  mode = "queryFailure";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("查询暂不可用");
  const saved = await getVideoTask(cwd, input.outputDirectory);
  expect(saved?.taskId).toBeDefined();
  expect(saved?.phase).not.toBe("failed");
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(posts.length).toBe(1);
});
test("幂等冲突保留待核查记录，不能换键补发", async () => {
  const cwd = await workspace(), input = request();
  mode = "conflict";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("冲突");
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("submitting");
  await expect(generateMedia(cwd, "video", request())).rejects.toThrow("未完成");
  expect(posts.length).toBe(1);
});
for (const behavior of ["lostReceipt", "missingId", "idempotencyPending"]) test(`回执异常复用同一键和原始字节：${behavior}`, async () => {
  mode = behavior;
  await generateMedia(await workspace(), "video", request());
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  expect(submitted.size).toBe(1);
}, 20000);
test("持续无回执停止自动确认，手动恢复仍使用原键", async () => {
  const cwd = await workspace(), input = request();
  mode = "unknownReceipt";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("尚未确认");
  expect(posts.length).toBe(3);
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("submitting");
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(posts.every(post => post.body === posts[0]!.body && post.key === posts[0]!.key)).toBe(true);
  expect(submitted.size).toBe(1);
}, 30000);
for (const behavior of ["failed", "explicitFailure", "referenceFailure"]) test(`确定失败保留终态，不自动重建：${behavior}`, async () => {
  const cwd = await workspace(), input = request();
  mode = behavior;
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("failed");
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  expect(posts.length).toBe(1);
  mode = "success";
  await generateMedia(cwd, "video", request());
  expect(posts.length).toBe(2);
  expect(posts[0]!.key).not.toBe(posts[1]!.key);
});
test("并发重复点击和更换键不能绕过进行中的任务", async () => {
  const cwd = await workspace(), input = request();
  mode = "holdCreate";
  const first = generateMedia(cwd, "video", input);
  try {
    await until(() => posts.length === 1);
    await expect(generateMedia(cwd, "video", input)).rejects.toThrow("仍在运行");
    await expect(generateMedia(cwd, "video", request())).rejects.toThrow("仍在运行");
  } finally { releaseCreate?.(); }
  await first;
  expect(posts.length).toBe(1);
});
for (const behavior of ["processing", "unknownState"]) test(`中断后恢复原任务及真实进度：${behavior}`, async () => {
  const cwd = await workspace(), input = request();
  const controller = new AbortController();
  controllers.push(controller);
  mode = behavior;
  const running = generateMedia(cwd, "video", input, controller.signal);
  const outcome = running.then(() => ({ error: undefined }), error => ({ error }));
  pending.push(outcome);
  await until(() => queries > 0);
  await Bun.sleep(50);
  const status = await getVideoTask(cwd, input.outputDirectory);
  expect(status?.progress).toBe(behavior === "processing" ? 37 : undefined);
  controller.abort();
  expect((await outcome).error).toBeDefined();
  await expect(generateMedia(cwd, "video", request())).rejects.toThrow("未完成");
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(posts.length).toBe(1);
});
test("真实进程退出后从磁盘恢复，忽略变化的参考图", async () => {
  const cwd = await workspace(), input = request({ images: [{ path: "one.png", mimeType: "image/png" }] });
  mode = "processing";
  const script = `const {generateMedia}=await import(${JSON.stringify(resolve(import.meta.dirname, "../src/utils/media/generation.ts").replaceAll("\\", "/"))}); await generateMedia(${JSON.stringify(cwd)},"video",${JSON.stringify(input)});`;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: resolve(import.meta.dirname, ".."), env: process.env, stdout: "pipe", stderr: "pipe" });
  processes.push(child);
  await until(() => queries > 0);
  child.kill();
  await child.exited;
  await writeAtomic(join(cwd, "one.png"), "changed");
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(posts.length).toBe(1);
  expect(JSON.parse(posts[0]!.body).images[0]).toBe(png.toString("base64"));
}, 20000);
test("同键修改参数及恢复时更换密钥被拒绝", async () => {
  const cwd = await workspace(), input = request();
  mode = "downloadFailure";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  await expect(generateMedia(cwd, "video", { ...input, prompt: "更改内容" })).rejects.toThrow("不能修改");
  configure({ ...config, apiKey: "different-key" });
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("原 API 地址和密钥");
  expect(posts.length).toBe(1);
});
for (const behavior of ["previewDownload", "htmlDownload", "fakeMp4"]) test(`拒绝假成功下载：${behavior}`, async () => {
  mode = behavior;
  const cwd = await workspace(), input = request();
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).not.toBe("completed");
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(posts.length).toBe(1);
});
for (const behavior of ["success", "ignoreRange"]) test(`下载断点恢复且不重复追加：${behavior}`, async () => {
  const cwd = await workspace(), input = request();
  mode = "partialDownload";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  const partial = (await files(join(cwd, ".toonflow"))).find(path => path.endsWith(".part"))!;
  const partialSize = (await stat(partial)).size;
  const checkpoint = JSON.parse(await readFile(partial.replace(/\.part$/, ".json"), "utf8"));
  expect(checkpoint.download?.validator).toBe('"sample"');
  expect(checkpoint.download?.total).toBe(video.length);
  expect(partialSize).toBeGreaterThan(0);
  expect(partialSize).toBeLessThan(video.length);
  mode = behavior;
  const result = await generateMedia(cwd, "video", input);
  expect(downloads[1]!.get("range")).toBe(`bytes=${partialSize}-`);
  expect(downloads[1]!.get("if-range")).toBe('"sample"');
  expect(digest(await readFile(join(cwd, result[0]!.path)))).toBe(digest(video));
  expect(posts.length).toBe(1);
});
test("拒绝错位的续传范围", async () => {
  const cwd = await workspace(), input = request();
  mode = "partialDownload";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  mode = "badRange";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("续传范围");
  expect(posts.length).toBe(1);
});
test("416 重置失效断点，继续下载原任务", async () => {
  const cwd = await workspace(), input = request();
  mode = "partialDownload";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  mode = "rangeExpired";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("断点已重置");
  mode = "success";
  const result = await generateMedia(cwd, "video", input);
  expect(downloads[2]!.get("range")).toBeNull();
  expect(digest(await readFile(join(cwd, result[0]!.path)))).toBe(digest(video));
  expect(posts.length).toBe(1);
});
test("任务状态和磁盘记录不暴露密钥", async () => {
  const cwd = await workspace(), input = request();
  mode = "secretFailure";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  expect(JSON.stringify(await getVideoTask(cwd, input.outputDirectory))).not.toContain(key);
  for (const file of await files(join(cwd, ".toonflow"))) expect(await readFile(file, "utf8")).not.toContain(key);
});
test("拒绝越界输出目录", async () => {
  await expect(generateMedia(await workspace(), "video", request({ outputDirectory: "../outside" }))).rejects.toThrow();
  expect(posts.length).toBe(0);
});
