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
let receipts: Headers[] = [];
let downloads: Headers[] = [];
let downloadTimes: number[] = [];
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
    if (path === "/v1/video-submissions/current") {
      receipts.push(new Headers(request.headers));
      const operationId = request.headers.get("idempotency-key")!;
      const idHash = digest(Buffer.from(operationId));
      if (mode === "unknownReceipt") return Response.json({ receipt: "pending" }, { status: 202 });
      if (mode === "receiptLookupMissing") return Response.json({ receipt: "not_found" }, { status: 404 });
      if (mode === "receiptLookupUnavailable") return Response.json({ error: { message: "回执存储暂不可用" } }, { status: 503 });
      if (mode === "receiptLookupUnauthorized") return Response.json({ error: { message: "原令牌无权读取" } }, { status: 401 });
      if (mode === "receiptLookupRejected" || mode === "receiptLookupRejectedMismatch") return Response.json({ receipt: "rejected", idempotency_key_hash: mode === "receiptLookupRejected" ? idHash : "0".repeat(64), http_status: 424, response: { error: { code: "REFERENCE_PREPARATION_FAILED", message: "原图准备失败", submitted: false } } });
      const task = submitted.get(operationId);
      return Response.json({ receipt: "accepted", idempotency_key_hash: mode === "receiptLookupMismatch" ? "0".repeat(64) : mode === "receiptLookupNoHash" ? undefined : idHash, task: mode === "receiptLookupNoId" ? {} : { task_id: task?.id } });
    }
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
      if (mode === "idempotencyPending" && posts.length === 1) return Response.json({ error: { code: "idempotency_in_progress" } }, { status: 409 });
      if (mode === "submitRetryAfter") return Response.json({ error: { message: "网关暂不可用" } }, { status: 503, headers: { "retry-after": "180" } });
      if (mode === "unknownReceipt" || mode.startsWith("receiptLookup")) return Response.json({ error: { message: "网关暂不可用" } }, { status: 503 });
      if (mode === "receiptTaskId") return Response.json({ id: "", task_id: task.id, status: "queued" });
      return Response.json({ id: task.id, status: "queued" }, { status: 202 });
    }
    if (path.endsWith("/download")) {
      downloads.push(new Headers(request.headers));
      downloadTimes.push(Date.now());
      if (mode === "redirectDownload") return new Response(null, { status: 302, headers: { location: `http://localhost:${port}/leak` } });
      if (mode === "downloadFailure") return Response.json({ error: { message: "暂时不能取片" } }, { status: 503 });
      if (mode === "transientDownload" && downloads.length < 3) return Response.json({ error: { code: "temporarily_unavailable", message: "原片正在转存" } }, { status: downloads.length === 1 ? 503 : 429 });
      if (mode === "downloadRetryAfter") return Response.json({ error: { code: "rate_limited", message: `请稍后取片 ${key}` } }, { status: 429, headers: { "retry-after": "180", "x-request-id": "request-download-123" } });
      if (mode === "downloadForbidden") return Response.json({ code: "permission_denied", message: `原密钥没有权限 ${key}` }, { status: 403, headers: { "x-trace-id": "trace-download-456" } });
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
      if (mode === "queryRetryAfter") return Response.json({ error: { code: "rate_limited", message: "查询稍后再试" } }, { status: 429, headers: { "retry-after": new Date(Date.now() + 180000).toUTCString(), "x-request-id": "request-query-789" } });
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
  if (incoming.url === "/v1/video-submissions/current" && mode === "receiptLookupNetwork") {
    receipts.push(new Headers(incoming.headers as Record<string, string>));
    outgoing.writeHead(200, { "Content-Type": "application/json", "Content-Length": "200" });
    outgoing.write('{"receipt":');
    setTimeout(() => outgoing.destroy(), 30);
    return;
  }
  if (incoming.url?.endsWith("/download") && mode === "largeVideo") {
    downloads.push(new Headers(incoming.headers as Record<string, string>));
    const total = 101 * 1024 * 1024;
    outgoing.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(total), "X-Video-Quality": "original", ETag: '"large"' });
    outgoing.write(video);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(total - video.length); header.write("free", 4);
    outgoing.write(header);
    const chunk = Buffer.alloc(1024 * 1024);
    for (let remaining = total - video.length - header.length; remaining > 0;) {
      const length = Math.min(chunk.length, remaining);
      if (!outgoing.write(chunk.subarray(0, length))) await new Promise<void>(resolve => outgoing.once("drain", resolve));
      remaining -= length;
    }
    outgoing.end();
    return;
  }
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
  if (incoming.method === "POST" && mode === "brokenReceipt") {
    outgoing.writeHead(202, { "Content-Type": "application/json", "Content-Length": "200" });
    outgoing.write('{"id":');
    setTimeout(() => outgoing.destroy(), 30);
    return;
  }
  const responseBytes = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(responseBytes);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
console.log(`本机模拟接口：PID ${process.pid}，端口 ${port}`);

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

async function setRetryDeadline(cwd: string, operationId: string, retryAt = Date.now() - 1) {
  const path = (await files(join(cwd, ".toonflow"))).find(path => path.endsWith(`${operationId}.json`))!;
  const record = JSON.parse(await readFile(path, "utf8"));
  const previous = record.state.retryAt;
  record.state.retryAt = retryAt;
  await writeAtomic(path, JSON.stringify(record));
  return previous as number | undefined;
}

beforeEach(() => { mode = "success"; posts = []; queries = 0; receipts = []; downloads = []; downloadTimes = []; redirected = 0; submitted.clear(); configure(); });
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
for (const behavior of ["lostReceipt", "missingId", "idempotencyPending", "brokenReceipt"]) test(`回执异常通过只读接口找回原任务，不重放 POST：${behavior}`, async () => {
  mode = behavior;
  const input = request();
  await generateMedia(await workspace(), "video", input);
  expect(posts).toHaveLength(1);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.get("idempotency-key")).toBe(input.operationId);
  expect(receipts[0]!.get("authorization")).toBe(`Bearer ${key}`);
  expect(submitted.size).toBe(1);
}, 20000);
test("202 回执待确认保留原操作，900 秒内不再次查询或补发", async () => {
  const cwd = await workspace(), input = request();
  mode = "unknownReceipt";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("900 秒");
  expect(posts.length).toBe(1);
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("接口要求等待");
  expect(receipts).toHaveLength(1);
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("submitting");
  mode = "success";
  expect((await setRetryDeadline(cwd, input.operationId))! - Date.now()).toBeGreaterThan(899000);
  await generateMedia(cwd, "video", input);
  expect(posts).toHaveLength(1);
  expect(receipts).toHaveLength(2);
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
for (const behavior of ["receiptLookupMissing", "receiptLookupUnavailable", "receiptLookupUnauthorized", "receiptLookupMismatch", "receiptLookupNoHash", "receiptLookupNoId", "receiptLookupRejectedMismatch", "receiptLookupNetwork"]) test(`不明确或不匹配的回执不能补发生成：${behavior}`, async () => {
  const cwd = await workspace(), input = request();
  mode = behavior;
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("submitting");
  await expect(generateMedia(cwd, "video", request())).rejects.toThrow("未完成");
  expect(posts).toHaveLength(1);
  expect(receipts).toHaveLength(1);
  await setRetryDeadline(cwd, input.operationId);
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(posts).toHaveLength(1);
  expect(receipts).toHaveLength(2);
});
test("哈希核对通过的拒绝回执保存终态与原始原因", async () => {
  const cwd = await workspace(), input = request();
  mode = "receiptLookupRejected";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("原图准备失败");
  const task = await getVideoTask(cwd, input.outputDirectory);
  expect(task?.phase).toBe("failed");
  expect(task?.error).toContain("424");
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow();
  expect(posts).toHaveLength(1);
  expect(receipts).toHaveLength(1);
});
test("提交要求的长 Retry-After 不被截短，恢复只查原回执", async () => {
  const cwd = await workspace(), input = request();
  mode = "submitRetryAfter";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("180 秒");
  expect(receipts).toHaveLength(0);
  expect((await setRetryDeadline(cwd, input.operationId, Date.now() + 90000))! - Date.now()).toBeGreaterThan(179000);
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("接口要求等待");
  await setRetryDeadline(cwd, input.operationId);
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(posts).toHaveLength(1);
  expect(receipts).toHaveLength(1);
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
  expect(downloads).toHaveLength(4);
  expect(downloads.at(-1)!.get("range")).toBe(`bytes=${partialSize}-`);
  expect(downloads.at(-1)!.get("if-range")).toBe('"sample"');
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
  expect(downloads).toHaveLength(5);
  expect(downloads.at(-1)!.get("range")).toBeNull();
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

test("下载 503 和 429 有限退避后成功，只创建一个视频任务", async () => {
  const cwd = await workspace(), input = request();
  mode = "transientDownload";
  const result = await generateMedia(cwd, "video", input);
  expect(downloads).toHaveLength(3);
  expect(downloadTimes[1]! - downloadTimes[0]!).toBeGreaterThanOrEqual(4900);
  expect(downloadTimes[2]! - downloadTimes[1]!).toBeGreaterThanOrEqual(9900);
  expect(posts).toHaveLength(1);
  expect(digest(await readFile(join(cwd, result[0]!.path)))).toBe(digest(video));
}, 30000);

test("持续下载故障只尝试三次，保留原任务", async () => {
  const cwd = await workspace(), input = request();
  mode = "downloadFailure";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("暂时不能取片");
  expect(downloads).toHaveLength(3);
  expect(posts).toHaveLength(1);
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("downloading");
}, 30000);

test("下载长 Retry-After 跨恢复保留，错误正文与追踪编号脱敏保存", async () => {
  const cwd = await workspace(), input = request();
  mode = "downloadRetryAfter";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("自动下载已停止");
  const status = await getVideoTask(cwd, input.outputDirectory);
  expect(status?.error).toContain("HTTP 429");
  expect(status?.error).toContain("rate_limited");
  expect(status?.error).toContain("request-download-123");
  expect(status?.error).not.toContain(key);
  expect((await setRetryDeadline(cwd, input.operationId, Date.now() + 90000))! - Date.now()).toBeGreaterThan(179000);
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("接口要求等待");
  expect(downloads).toHaveLength(1);
  await setRetryDeadline(cwd, input.operationId);
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(downloads).toHaveLength(2);
  expect(posts).toHaveLength(1);
});

test("下载权限错误不自动重试，保留顶层原因与追踪编号", async () => {
  const cwd = await workspace(), input = request();
  mode = "downloadForbidden";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("原密钥没有权限");
  const status = await getVideoTask(cwd, input.outputDirectory);
  expect(status?.error).toContain("HTTP 403 / permission_denied");
  expect(status?.error).toContain("trace-download-456");
  expect(status?.error).not.toContain(key);
  expect(downloads).toHaveLength(1);
  expect(posts).toHaveLength(1);
});

test("下载退避等待可取消，恢复保留原任务与等待期限", async () => {
  const cwd = await workspace(), input = request();
  const controller = new AbortController();
  controllers.push(controller);
  mode = "downloadFailure";
  const outcome = generateMedia(cwd, "video", input, controller.signal).then(() => undefined, error => error);
  pending.push(outcome);
  await until(() => downloads.length === 1);
  await Bun.sleep(100);
  controller.abort();
  expect(await outcome).toBeDefined();
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("downloading");
  expect(downloads).toHaveLength(1);
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("接口要求等待");
  await setRetryDeadline(cwd, input.operationId);
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(posts).toHaveLength(1);
  expect(downloads).toHaveLength(2);
});

test("任务查询限流遵守 HTTP 日期形式的长等待，恢复不重新提交", async () => {
  const cwd = await workspace(), input = request();
  mode = "queryRetryAfter";
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("request-query-789");
  expect((await getVideoTask(cwd, input.outputDirectory))?.taskId).toBeDefined();
  await expect(generateMedia(cwd, "video", input)).rejects.toThrow("接口要求等待");
  expect(queries).toBe(1);
  expect((await setRetryDeadline(cwd, input.operationId))! - Date.now()).toBeGreaterThan(178000);
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(queries).toBe(2);
  expect(posts).toHaveLength(1);
  expect(receipts).toHaveLength(0);
});

test("101 MiB 原片流式保存并回填，完成后恢复不下载或重新生成", async () => {
  const cwd = await workspace(), input = request();
  mode = "largeVideo";
  const result = await generateMedia(cwd, "video", input);
  const output = join(cwd, result[0]!.path);
  expect((await stat(output)).size).toBe(101 * 1024 * 1024);
  const handle = await open(output, "r");
  const prefix = Buffer.alloc(video.length);
  try { await handle.read(prefix, 0, prefix.length, 0); } finally { await handle.close(); }
  expect(digest(prefix)).toBe(digest(video));
  expect((await getVideoTask(cwd, input.outputDirectory))?.phase).toBe("completed");
  expect(await generateMedia(cwd, "video", input)).toEqual(result);
  expect(downloads).toHaveLength(1);
  expect(posts).toHaveLength(1);
}, 30000);

for (const changed of [false, true]) test(`结果已落盘但记录未保存时安全恢复，文件被修改：${changed}`, async () => {
  const cwd = await workspace(), input = request();
  const result = await generateMedia(cwd, "video", input);
  const recordPath = (await files(join(cwd, ".toonflow"))).find(path => path.endsWith(`${input.operationId}.json`))!;
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  delete record.result;
  await writeAtomic(recordPath, JSON.stringify(record));
  if (changed) {
    await writeAtomic(join(cwd, result[0]!.path), "用户更改的视频");
    await expect(generateMedia(cwd, "video", input)).rejects.toThrow("未覆盖");
    expect(await readFile(join(cwd, result[0]!.path), "utf8")).toBe("用户更改的视频");
  } else expect(await generateMedia(cwd, "video", input)).toEqual(result);
  expect(downloads).toHaveLength(1);
  expect(posts).toHaveLength(1);
});

test("提交已发出但进程未收到回执，重启仅查询原回执", async () => {
  const cwd = await workspace(), input = request();
  mode = "holdCreate";
  const script = `const {generateMedia}=await import(${JSON.stringify(resolve(import.meta.dirname, "../src/utils/media/generation.ts").replaceAll("\\", "/"))}); await generateMedia(${JSON.stringify(cwd)},"video",${JSON.stringify(input)});`;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: resolve(import.meta.dirname, ".."), env: process.env, stdout: "pipe", stderr: "pipe" });
  processes.push(child);
  await until(() => posts.length === 1);
  child.kill(); await child.exited;
  releaseCreate?.();
  mode = "success";
  await generateMedia(cwd, "video", input);
  expect(posts).toHaveLength(1);
  expect(receipts).toHaveLength(1);
});
