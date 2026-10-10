import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, open, readFile, readdir, unlink, writeAtomic } from "@toonflow/file";

if (!process.env.TOONFLOW_TEST_DIR) throw new Error("请设置 D 盘 TOONFLOW_TEST_DIR，测试不调用付费接口");
await mkdir(process.env.TOONFLOW_TEST_DIR, { recursive: true });
const root = await mkdtemp(join(process.env.TOONFLOW_TEST_DIR, "laoliImage"));
process.env.TOONFLOW_DATA_DIR = join(root, "data");
const png = await readFile(resolve(import.meta.dirname, "../../../docs/images/logo.png"));
const otherPng = await readFile(resolve(import.meta.dirname, "../../../docs/images/qr.png"));
const modelIds = ["gpt-image-2.5", "gpt-image-2.5-sr-flare", "gpt-image-2.5-sr-sunburst", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "seedream-v5-pro", "nano-banana-2", "nano-banana-pro"];
const key = "laoli-image-mock-key";
let mode = "completedReceipt";
let posts: { key: string; endpoint: string; body: string }[] = [];
let queries = 0;
let downloads: Headers[] = [];
let redirected = 0;
let suppliedImage = png;
let suppliedMime = "image/png";
const submitted = new Map<string, { id: string; body: string; endpoint: string }>();
const controllers: AbortController[] = [];
const pending: Promise<unknown>[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

function result(id: string) {
  const image = mode.startsWith("download") || mode === "externalUrl" || mode === "redirect"
    ? { url: mode === "externalUrl" ? `${externalUrl}/original` : `${apiUrl}/original` }
    : { b64_json: suppliedImage.toString("base64"), mime_type: suppliedMime };
  return { request_id: id, state: "completed", result: { data: [image] } };
}

async function handleRequest(request: Request) {
  const endpoint = new URL(request.url).pathname;
  if (endpoint === "/leak") { redirected++; return new Response(png); }
  if (request.headers.get("authorization") !== `Bearer ${key}`) return Response.json({ error: { message: "认证失败" } }, { status: 401 });
  if (endpoint === "/original") {
    downloads.push(new Headers(request.headers));
    if (mode === "downloadFailure") return Response.json({ error: { code: "temporarily_unavailable", message: "原图暂不可用" } }, { status: 503 });
    if (mode === "downloadLimit") return new Response("x", { headers: { "content-length": String(101 * 1024 * 1024) } });
    if (mode === "downloadHtml") return new Response("<html>not an image</html>", { headers: { "content-type": "image/png" } });
    if (mode === "redirect") return new Response(null, { status: 302, headers: { location: `${apiUrl}/leak` } });
    return new Response(suppliedImage, { headers: { "content-type": suppliedMime } });
  }
  if (request.method === "POST" && ["/v1/images/generations/async", "/v1/images/edits/async"].includes(endpoint)) {
    const operationId = request.headers.get("idempotency-key")!;
    const body = await request.text();
    posts.push({ key: operationId, endpoint, body });
    if (mode.startsWith("reject")) return Response.json({ error: { code: "rejected", message: `明确拒绝 ${key}` } }, { status: Number(mode.slice(6)) });
    const existing = submitted.get(operationId);
    if (existing && (existing.body !== body || existing.endpoint !== endpoint)) return Response.json({ error: { code: "idempotency_conflict" } }, { status: 409 });
    const id = existing?.id ?? `image-${submitted.size + 1}`;
    submitted.set(operationId, { id, body, endpoint });
    if (mode === "lostReceipt") return Response.json({ error: { message: "回执暂不可用" } }, { status: 503 });
    if (mode === "missingId") return Response.json({ state: "accepted" }, { status: 202 });
    if (mode === "retryAfter") return Response.json({ error: { message: "稍后核查" } }, { status: 429, headers: { "retry-after": "180" } });
    if (mode === "conflict") return Response.json({ error: { code: "idempotency_conflict" } }, { status: 409 });
    if (mode === "badPoll") return Response.json({ request_id: id, state: "accepted", poll_url: `${externalUrl}/leak` }, { status: 202 });
    if (mode === "completedReceipt" || mode.startsWith("download") || mode === "externalUrl" || mode === "redirect" || existing) return Response.json(result(id));
    return Response.json({ request_id: id, state: "accepted", poll_url: `/v1/images/tasks/${id}`, retry_after: 0 }, { status: 202 });
  }
  if (endpoint.startsWith("/v1/images/tasks/")) {
    queries++;
    const id = endpoint.split("/").at(-1)!;
    if (mode === "query404") return Response.json({ error: { message: "回执不存在或非当前 Key" } }, { status: 404 });
    if (mode === "expired") return Response.json({ state: "expired" }, { status: 410 });
    if (mode === "failed") return Response.json({ request_id: id, state: "failed", error: { message: `审核失败 ${key}`, code: "moderation_rejected" } });
    if (["processing", "reconciling", "settling", "unknownState"].includes(mode)) return Response.json({ request_id: id, state: mode, result: { data: [{ b64_json: png.toString("base64") }] } });
    if (mode === "mismatchedId") return Response.json({ ...result("other-task") });
    return Response.json(result(id));
  }
  return new Response("unexpected endpoint", { status: 404 });
}

const external = createServer((incoming, outgoing) => {
  downloads.push(new Headers(incoming.headers as Record<string, string>));
  outgoing.writeHead(200, { "content-type": "image/png" });
  outgoing.end(png);
});
await new Promise<void>(resolve => external.listen(0, "127.0.0.1", resolve));
const externalPort = (external.address() as { port: number }).port;
const externalUrl = `http://127.0.0.1:${externalPort}`;
const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const request = new Request(`${apiUrl}${incoming.url}`, {
    method: incoming.method, headers: incoming.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
  const response = await handleRequest(request);
  if (incoming.method === "POST" && mode === "brokenReceipt") {
    outgoing.writeHead(202, { "content-type": "application/json", "content-length": "200" });
    outgoing.write('{"request_id":');
    setTimeout(() => outgoing.destroy(), 30);
    return;
  }
  const bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(bytes);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const apiUrl = `http://127.0.0.1:${port}`;
console.log(`图片模拟接口 PID ${process.pid}，端口 ${port}、${externalPort}`);
const { default: conf } = await import("../src/utils/conf");
const { generateMedia, getImageTask, getImageTaskRequest, listMediaModels } = await import("../src/utils/media/generation");
const { imageGenerationSchema } = await import("@toonflow/tool-media-generation/runtime");
await mkdir(join(process.env.TOONFLOW_DATA_DIR!, "providers"), { recursive: true });
await writeAtomic(join(process.env.TOONFLOW_DATA_DIR!, "providers/laoliImage.ts"), await readFile(resolve(import.meta.dirname, "../../../packages/providers/src/media/laoliImage.ts")));
const config = { apiKey: key, apiUrl };
function configure(value = config) { conf.set("settings", { mediaProviderConfigs: { laoliImage: value } }); }
async function workspace() {
  const cwd = await mkdtemp(join(root, "workspace"));
  await writeAtomic(join(cwd, "one.png"), png);
  await writeAtomic(join(cwd, "two.png"), otherPng);
  return cwd;
}
function request(overrides: Record<string, any> = {}) {
  return { providerId: "laoliImage", modelId: modelIds[0]!, prompt: "  单角色，单场景。\n保留原文  ", size: "4K", ratio: "3:4", outputDirectory: "assets/shotOne", operationId: crypto.randomUUID(), ...overrides };
}
async function recordPath(cwd: string, operationId: string) {
  const directories = await readdir(join(cwd, ".toonflow/imageTasks"));
  expect(directories.length).toBe(1);
  return join(cwd, ".toonflow/imageTasks", directories[0]!, `${operationId}.json`);
}
async function due(cwd: string, operationId: string) {
  const path = await recordPath(cwd, operationId);
  const record = JSON.parse(await readFile(path, "utf8"));
  const deadline = record.state.retryAt;
  record.state.retryAt = Date.now() - 1;
  await writeAtomic(path, JSON.stringify(record));
  return deadline;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 12000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("等待模拟事件超时"); await Bun.sleep(20); }
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeEach(() => { mode = "completedReceipt"; posts = []; queries = 0; downloads = []; redirected = 0; suppliedImage = png; suppliedMime = "image/png"; submitted.clear(); configure(); });
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort());
  await Promise.allSettled(pending.splice(0));
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill(); await child.exited; }
});
afterAll(async () => {
  for (const instance of [server, external]) await new Promise<void>((resolve, reject) => { instance.close(error => error ? reject(error) : resolve()); instance.closeAllConnections(); });
  console.log(`图片模拟接口已关闭：${port}、${externalPort}；数据：${root}`);
});

test("注册截图全部八个准确 ID 和恢复能力", async () => {
  const models = (await listMediaModels()).filter(model => model.providerId === "laoliImage");
  expect(models.map(model => model.modelId)).toEqual(modelIds);
  expect(models.every(model => model.taskRecovery && model.imageSizes?.join() === "1K,2K,4K" && model.imageRatios?.length === 11)).toBe(true);
  expect(await getImageTask(await workspace(), "assets/shotOne")).toBeNull();
});

for (const modelId of modelIds) {
  for (const edited of [false, true]) test(`${modelId} ${edited ? "参考图编辑" : "文生图"}：202、查询、原字节回填`, async () => {
    mode = "success";
    const cwd = await workspace();
    const input = request({ modelId, ...(edited ? { images: [{ path: "two.png", mimeType: "image/png" }, { path: "one.png", mimeType: "image/png" }, { path: "two.png", mimeType: "image/png" }] } : {}) });
    const [output] = await generateMedia(cwd, "image", input);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.key).toBe(input.operationId);
    expect(posts[0]!.endpoint).toBe(`/v1/images/${edited ? "edits" : "generations"}/async`);
    const body = JSON.parse(posts[0]!.body);
    expect(body.model).toBe(modelId);
    expect(body.prompt).toBe(input.prompt);
    expect(body).toMatchObject({ resolution: "4K", aspect_ratio: "3:4", n: 1, response_format: "b64_json" });
    expect(body.size).toBeUndefined();
    expect(body.output_format).toBeUndefined();
    if (edited) expect(body.images).toEqual([otherPng, png, otherPng].map(bytes => `data:image/png;base64,${bytes.toString("base64")}`));
    expect(queries).toBe(1);
    expect(output!.path).toBe(`assets/shotOne/image${input.operationId}.png`);
    expect(digest(await readFile(join(cwd, output!.path)))).toBe(digest(png));
    expect((await getImageTask(cwd, input.outputDirectory))?.phase).toBe("completed");
    expect(await generateMedia(cwd, "image", input)).toEqual([output!]);
    expect(posts).toHaveLength(1);
  });
}

test("档位、显式尺寸和省略尺寸不被改写；提示词 Schema 保留空白", async () => {
  for (const size of ["1K", "2K", "4K", "3000x4000", undefined]) {
    const input = request({ size });
    expect(imageGenerationSchema.parse(input).prompt).toBe(input.prompt);
    await generateMedia(await workspace(), "image", input);
    const body = JSON.parse(posts.at(-1)!.body);
    expect(body.size).toBe(size === "3000x4000" ? size : undefined);
    expect(body.resolution).toBe(size?.endsWith("K") ? size : undefined);
  }
  await expect(generateMedia(await workspace(), "image", request({ size: "3000x4000", ratio: "16:9" }))).rejects.toThrow("比例冲突");
  expect(posts).toHaveLength(5);
});

for (const status of [400, 401, 402, 413, 422]) test(`明确拒绝 ${status} 保留原因且不泄露密钥`, async () => {
  mode = `reject${status}`;
  const cwd = await workspace(); const input = request();
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow(`HTTP ${status}`);
  const task = await getImageTask(cwd, input.outputDirectory);
  expect(task?.phase).toBe("failed"); expect(task?.error).not.toContain(key);
  expect(await readFile(await recordPath(cwd, input.operationId), "utf8")).not.toContain(key);
  expect(posts).toHaveLength(1);
});

for (const failure of ["lostReceipt", "brokenReceipt", "missingId"]) test(`${failure} 恢复使用相同入口、键和原始字节`, async () => {
  mode = failure;
  const cwd = await workspace(); const input = request({ images: [{ path: "one.png", mimeType: "image/png" }] });
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow();
  const first = { ...posts[0]! };
  await expect(generateMedia(cwd, "image", request())).rejects.toThrow("未完成");
  await expect(generateMedia(cwd, "image", { ...input, prompt: "改参数" })).rejects.toThrow("不能修改");
  await unlink(join(cwd, "one.png"));
  mode = "completedReceipt";
  await due(cwd, input.operationId);
  const restored = await getImageTaskRequest(cwd, input.outputDirectory, input.operationId);
  const [output] = await generateMedia(cwd, "image", restored);
  expect(output).toBeDefined(); expect(posts).toHaveLength(2); expect(posts[1]).toEqual(first);
  expect(submitted.size).toBe(1);
});

test("缺失回执最多三次原样确认，不换键或接口", async () => {
  mode = "lostReceipt";
  const cwd = await workspace(); const input = request();
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(generateMedia(cwd, "image", input)).rejects.toThrow();
    await due(cwd, input.operationId);
  }
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow("已停止幂等确认");
  expect(posts).toHaveLength(3); expect(new Set(posts.map(post => post.key)).size).toBe(1);
});

test("Retry-After 跨恢复保持；更换密钥不能确认原提交", async () => {
  mode = "retryAfter";
  const cwd = await workspace(); const input = request(); const started = Date.now();
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow("HTTP 429");
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow("秒后恢复");
  expect(posts).toHaveLength(1);
  expect(await due(cwd, input.operationId)).toBeGreaterThanOrEqual(started + 180000);
  configure({ ...config, apiKey: "another-mock-key" });
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow("原 API 地址和密钥");
  expect(posts).toHaveLength(1);
});

test("409 冲突不标成失败、不自动创建新任务", async () => {
  mode = "conflict";
  const cwd = await workspace(); const input = request();
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow("409");
  expect((await getImageTask(cwd, input.outputDirectory))?.phase).toBe("submitting");
  await expect(generateMedia(cwd, "image", request())).rejects.toThrow("未完成");
  expect(posts).toHaveLength(1);
});

for (const state of ["processing", "reconciling", "settling"]) test(`${state} 不提前交付；中断后只查原编号`, async () => {
  mode = state;
  const cwd = await workspace(); const input = request(); const controller = new AbortController(); controllers.push(controller);
  const running = generateMedia(cwd, "image", input, controller.signal).catch(error => error); pending.push(running);
  await until(() => queries > 0);
  for (let attempt = 0; attempt < 100 && (await getImageTask(cwd, input.outputDirectory))?.phase !== state; attempt++) await Bun.sleep(10);
  const status = await getImageTask(cwd, input.outputDirectory);
  expect(status?.phase).toBe(state); expect(status?.result).toBeUndefined();
  await expect(generateMedia(cwd, "image", request())).rejects.toThrow("仍在运行");
  controller.abort(); await running;
  mode = "completedReceipt"; await due(cwd, input.operationId);
  await generateMedia(cwd, "image", await getImageTaskRequest(cwd, input.outputDirectory, input.operationId));
  expect(posts).toHaveLength(1); expect(queries).toBe(2);
});

for (const state of ["failed", "expired", "query404", "unknownState", "mismatchedId"]) test(`${state} 正确区分终态与未知状态`, async () => {
  mode = state;
  const cwd = await workspace(); const input = request();
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow();
  const status = await getImageTask(cwd, input.outputDirectory);
  expect(status?.phase).toBe(state === "failed" || state === "expired" ? state : "accepted");
  expect(status?.result).toBeUndefined(); expect(status?.error).not.toContain(key);
  if (!["failed", "expired"].includes(state)) {
    mode = "completedReceipt"; await due(cwd, input.operationId);
    await generateMedia(cwd, "image", input); expect(posts).toHaveLength(1);
  }
});

test("原图下载失败后使用本地已结算回执，不重新生成或查缓存", async () => {
  mode = "downloadFailure";
  const cwd = await workspace(); const input = request();
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow("503");
  expect((await getImageTask(cwd, input.outputDirectory))?.phase).toBe("downloading");
  mode = "downloadSuccess";
  const [output] = await generateMedia(cwd, "image", input);
  expect(digest(await readFile(join(cwd, output!.path)))).toBe(digest(png));
  expect(posts).toHaveLength(1); expect(queries).toBe(0);
  expect(downloads.every(headers => headers.get("authorization") === `Bearer ${key}`)).toBe(true);
});

test("URL 原图已下载但目标目录受阻，恢复从本地原字节保存", async () => {
  mode = "downloadSuccess";
  const cwd = await workspace(); const input = request();
  await mkdir(join(cwd, "assets"));
  await writeAtomic(join(cwd, input.outputDirectory), "模拟同名文件");
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow();
  expect(downloads).toHaveLength(1);
  await unlink(join(cwd, input.outputDirectory)); mode = "downloadFailure";
  const [output] = await generateMedia(cwd, "image", input);
  expect(digest(await readFile(join(cwd, output!.path)))).toBe(digest(png));
  expect(posts).toHaveLength(1); expect(downloads).toHaveLength(1);
});

test("参考图单图及总量预算在读取和付费提交前检查", async () => {
  for (const sizes of [[26], [17, 17]]) {
    const cwd = await workspace(); const images: { path: string; mimeType: string }[] = [];
    for (const [index, size] of sizes.entries()) {
      const path = `large${index}.png`; const file = await open(join(cwd, path), "wx");
      try { await file.truncate(size * 1024 * 1024); } finally { await file.close(); }
      images.push({ path, mimeType: "image/png" });
    }
    await expect(generateMedia(cwd, "image", request({ images }))).rejects.toThrow("传输预算");
  }
  expect(posts).toHaveLength(0);
});

test("外部图片地址不接收 API Key，回执地址不允许跨域", async () => {
  mode = "externalUrl";
  await generateMedia(await workspace(), "image", request());
  expect(downloads[0]!.has("authorization")).toBe(false);
  mode = "badPoll";
  const cwd = await workspace(); const input = request();
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow("查询地址不可信");
  expect((await getImageTask(cwd, input.outputDirectory))?.taskId).toBeDefined();
  expect(downloads).toHaveLength(1);
  mode = "completedReceipt"; await due(cwd, input.operationId);
  await generateMedia(cwd, "image", input); expect(posts).toHaveLength(2);
});

for (const value of ["downloadHtml", "downloadLimit", "redirect"]) test(`${value} 不保存伪原图且不跟随认证重定向`, async () => {
  mode = value;
  const cwd = await workspace(); const input = request();
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow();
  expect((await getImageTask(cwd, input.outputDirectory))?.phase).toBe("downloading");
  expect(redirected).toBe(0); expect(posts).toHaveLength(1);
});

test("按真实文件头保存格式，不强制 PNG；不修改字节", async () => {
  suppliedImage = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==", "base64"); suppliedMime = "image/png";
  const cwd = await workspace(); const [output] = await generateMedia(cwd, "image", request());
  expect(output?.mimeType).toBe("image/jpeg"); expect(output?.path.endsWith(".jpg")).toBe(true);
  expect(digest(await readFile(join(cwd, output!.path)))).toBe(digest(suppliedImage));
});

test("已有图片不覆盖，落盘后崩溃从结果快照恢复", async () => {
  const cwd = await workspace(); const input = request();
  const [output] = await generateMedia(cwd, "image", input);
  const path = await recordPath(cwd, input.operationId); const record = JSON.parse(await readFile(path, "utf8"));
  delete record.result; await writeAtomic(path, JSON.stringify(record));
  expect(await generateMedia(cwd, "image", input)).toEqual([output!]);
  delete record.result; await writeAtomic(path, JSON.stringify(record));
  await writeAtomic(join(cwd, output!.path), otherPng);
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow("已发生变化");
  expect(digest(await readFile(join(cwd, output!.path)))).toBe(digest(otherPng)); expect(posts).toHaveLength(1);
});

test("原始请求被删除或修改时禁止重新提交", async () => {
  mode = "lostReceipt";
  const cwd = await workspace(); const input = request();
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow(); await due(cwd, input.operationId);
  const path = (await recordPath(cwd, input.operationId)).replace(/\.json$/, ".request.json");
  const saved = JSON.parse(await readFile(path, "utf8")); saved.body += " ";
  await writeAtomic(path, JSON.stringify(saved));
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow("请求已变化");
  await unlink(path);
  await expect(generateMedia(cwd, "image", input)).rejects.toThrow("快照缺失"); expect(posts).toHaveLength(1);
});

test("进程重启后恢复原任务，无新增 POST", async () => {
  mode = "processing";
  const cwd = await workspace(); const input = request(); const controller = new AbortController(); controllers.push(controller);
  const running = generateMedia(cwd, "image", input, controller.signal).catch(error => error); pending.push(running);
  await until(() => posts.length === 1);
  for (let attempt = 0; attempt < 100 && !(await getImageTask(cwd, input.outputDirectory))?.taskId; attempt++) await Bun.sleep(10);
  controller.abort(); await running; await due(cwd, input.operationId); mode = "completedReceipt";
  const script = `import { generateMedia, getImageTaskRequest } from './src/utils/media/generation'; const cwd = ${JSON.stringify(cwd)}; const request = await getImageTaskRequest(cwd, ${JSON.stringify(input.outputDirectory)}, ${JSON.stringify(input.operationId)}); console.log(JSON.stringify(await generateMedia(cwd, 'image', request)));`;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: resolve(import.meta.dirname, ".."), env: process.env, stdout: "pipe", stderr: "pipe" }); children.push(child);
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(errors).toBe(""); expect(code).toBe(0); expect(JSON.parse(output)[0].mediaType).toBe("image"); expect(posts).toHaveLength(1);
});
