import { lstat, open, opendir, realpath, type Dir, type FileHandle, type Stats } from "@toonflow/file";
import type { Application, Request } from "express";
import type { ClientFileRequest, ClientFileResult } from "@toonflow/tools-scaffold/runtime";
import { getDesktopRuntime } from "@/utils/desktop";
import { resolveWorkspacePath } from "@/utils/workspace/files";
export { clientFileRequestSchema as requestSchema } from "@/types/clientFiles";

type FileRun = { id: string; controller: AbortController; queue: Promise<unknown>; listings: Map<string, { path: string; handle: Dir; revision: string }> };
type Grant = { id: string; root: string; identity: string; timer?: ReturnType<typeof setTimeout>; run?: FileRun };
type State = { grants: Map<string, Grant>; selecting: Set<string> };
const states = new WeakMap<Application, State>();

function stateFor(app: Application) {
  let state = states.get(app);
  if (!state) { state = { grants: new Map(), selecting: new Set() }; states.set(app, state); }
  return state;
}

function revision(info: Stats) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function closeRun(run?: FileRun) {
  if (!run) return;
  run.controller.abort();
  // 先释放空闲分页句柄的目录读锁，避免排队中的文件操作等待这些锁而无法结束。
  const listings = [...run.listings.values()];
  run.listings.clear();
  await Promise.all(listings.map(item => item.handle.close()));
  await run.queue;
}

export async function revoke(app: Application, scopeId: string) {
  const state = stateFor(app);
  state.selecting.delete(scopeId);
  const grant = state.grants.get(scopeId);
  if (!grant) return;
  state.grants.delete(scopeId);
  clearTimeout(grant.timer);
  await closeRun(grant.run);
}

export async function clearClientFileGrants(app: Application) {
  const state = stateFor(app);
  state.selecting.clear();
  await Promise.all([...state.grants.keys()].map(scopeId => revoke(app, scopeId)));
}

function renewLease(app: Application, scopeId: string, grant: Grant) {
  clearTimeout(grant.timer);
  // ACT: 页面每 30 秒续约；异常关闭未能回传撤销时，90 秒后释放授权和目录句柄。
  grant.timer = setTimeout(() => { void revoke(app, scopeId).catch(error => console.error("释放本机文件授权失败：", error)); }, 90000);
  grant.timer.unref();
}

function getGrant(app: Application, scopeId: string, id: string) {
  const grant = stateFor(app).grants.get(scopeId);
  if (!grant || grant.id !== id) throw Object.assign(new Error("本机目录授权已失效，请重新选择文件夹"), { status: 403 });
  return grant;
}

export async function grantDirectory(req: Request, scopeId: string) {
  const state = stateFor(req.app);
  if (state.selecting.has(scopeId) || state.grants.has(scopeId)) throw Object.assign(new Error("请先撤销当前目录授权"), { status: 409 });
  if (state.selecting.size + state.grants.size >= 32) throw Object.assign(new Error("本机目录授权过多，请关闭不用的聊天"), { status: 409 });
  state.selecting.add(scopeId);
  try {
    const selected = await getDesktopRuntime(req).selectDirectory();
    if (!selected) return null;
    const root = await realpath(selected);
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("请选择普通文件夹");
    if (!state.selecting.has(scopeId) || req.res?.destroyed) throw new Error("目录选择所属聊天或连接已关闭");
    const grant: Grant = { id: crypto.randomUUID(), root, identity: `${info.dev}:${info.ino}` };
    state.grants.set(scopeId, grant);
    renewLease(req.app, scopeId, grant);
    return { id: grant.id, name: root };
  } finally { state.selecting.delete(scopeId); }
}

export function renew(app: Application, scopeId: string, id: string) {
  renewLease(app, scopeId, getGrant(app, scopeId, id));
}

export async function changeRun(app: Application, scopeId: string, id: string, runId: string, active: boolean) {
  const grant = getGrant(app, scopeId, id);
  if (!active) {
    if (grant.run?.id !== runId) return;
    const run = grant.run;
    grant.run = undefined;
    await closeRun(run);
    return;
  }
  if (grant.run) throw Object.assign(new Error("请等待当前本机文件读取结束"), { status: 409 });
  grant.run = { id: runId, controller: new AbortController(), queue: Promise.resolve(), listings: new Map() };
}

async function readBytes(handle: FileHandle, offset: number, length: number, signal: AbortSignal) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, total, length - total, offset + total);
    if (!bytesRead) throw new Error("文件读取提前结束，请重新读取");
    total += bytesRead;
  }
  return buffer;
}

async function readText(path: string, request: ClientFileRequest, signal: AbortSignal): Promise<ClientFileResult> {
  const handle = await open(path, "r");
  try {
    signal.throwIfAborted();
    const info = await handle.stat();
    const actual = await lstat(path);
    if (!info.isFile() || actual.isSymbolicLink() || info.dev !== actual.dev || info.ino !== actual.ino) throw new Error("只能读取授权目录内的普通文件");
    const currentRevision = revision(info);
    if (request.revision !== undefined && request.revision !== currentRevision) throw new Error("文件已修改，请从头重新读取");
    const offset = request.offset ?? 0;
    if (offset > 0 && !request.revision) throw new Error("分段读取必须带上首次返回的 revision");
    if (offset > info.size) throw new Error("读取位置超出文件长度");
    const header = await readBytes(handle, 0, Math.min(3, info.size), signal);
    const encoding = header[0] === 0xff && header[1] === 0xfe ? "utf-16le" : header[0] === 0xfe && header[1] === 0xff ? "utf-16be" : "utf-8";
    if (encoding !== "utf-8" && offset % 2) throw new Error("UTF-16 文本读取位置必须对齐字符边界");
    const buffer = await readBytes(handle, offset, Math.min(32768, info.size - offset), signal);
    const bytesRead = buffer.length;
    let length = bytesRead;
    let text: string | undefined;
    // 保留跨分段的 UTF-8 多字节字符和 UTF-16 代理对，下次从完整字符开始。
    for (let trim = 0; trim <= (offset + bytesRead < info.size ? 3 : 0); trim++) {
      try { text = new TextDecoder(encoding, { fatal: true, ignoreBOM: offset > 0 }).decode(buffer.subarray(0, bytesRead - trim)); length = bytesRead - trim; break; }
      catch (error) { if (!(error instanceof TypeError)) throw error; }
    }
    if (text === undefined || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error("仅支持 UTF-8 或带 BOM 的 UTF-16 纯文本，请先转换文件编码");
    if (revision(await handle.stat()) !== currentRevision) throw new Error("文件在读取期间被修改，请重新读取");
    return { action: "read", path: request.path, text, offset, nextOffset: offset + length < info.size ? offset + length : null, size: info.size, revision: currentRevision, encoding };
  } finally { await handle.close(); }
}

async function perform(grant: Grant, run: FileRun, request: ClientFileRequest): Promise<ClientFileResult> {
  run.controller.signal.throwIfAborted();
  const rootInfo = await lstat(grant.root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || `${rootInfo.dev}:${rootInfo.ino}` !== grant.identity) throw new Error("授权目录已被替换，请重新授权");
  const { path } = await resolveWorkspacePath(grant.root, request.path);
  run.controller.signal.throwIfAborted();
  if (request.action === "read") return readText(path, request, run.controller.signal);
  const currentRevision = revision(await lstat(path));
  let listing = request.cursor ? run.listings.get(request.cursor) : undefined;
  if (request.cursor && (!listing || listing.path !== path)) throw new Error("目录分页已失效，请重新列出目录");
  if (listing && listing.revision !== currentRevision) {
    run.listings.delete(request.cursor!);
    await listing.handle.close();
    throw new Error("目录已修改，请重新列出目录");
  }
  if (!listing) {
    if (run.listings.size >= 8) throw new Error("未完成的目录分页过多，请先读完已有分页");
    listing = { path, handle: await opendir(path), revision: currentRevision };
  }
  if (request.cursor) run.listings.delete(request.cursor);
  let retained = false;
  try {
    const entries: { name: string; type: "file" | "directory" }[] = [];
    let ended = false;
    for (let scanned = 0; scanned < 200; scanned++) {
      run.controller.signal.throwIfAborted();
      const entry = await listing.handle.read();
      if (!entry) { ended = true; break; }
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      entries.push({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
    }
    if (revision(await lstat(path)) !== currentRevision) throw new Error("目录在读取期间被修改，请重新列出");
    const cursor = ended ? undefined : crypto.randomUUID();
    if (cursor) { run.listings.set(cursor, listing); retained = true; }
    return { action: "list", path: request.path, entries, cursor };
  } finally { if (!retained) await listing.handle.close(); }
}

export async function execute(app: Application, scopeId: string, id: string, runId: string, request: ClientFileRequest) {
  const grant = getGrant(app, scopeId, id);
  const run = grant.run;
  if (!run || run.id !== runId) throw Object.assign(new Error("本机文件调用所属执行已结束"), { status: 403 });
  const pending = run.queue.then(async () => {
    const result = await perform(grant, run, request);
    run.controller.signal.throwIfAborted();
    if (getGrant(app, scopeId, id).run !== run) throw new Error("本机文件授权已撤销");
    const current = await resolveWorkspacePath(grant.root, request.path);
    if (result.action === "read" && revision(await lstat(current.path)) !== result.revision) throw new Error("文件在读取期间被替换，请重新读取");
    return result;
  });
  run.queue = pending.then(() => {}, () => {});
  return pending;
}
