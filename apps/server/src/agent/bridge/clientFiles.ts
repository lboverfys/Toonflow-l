import { z } from "zod";
import type { ClientFileContext, ClientFileDirectory, ClientFileResult } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { clientFileRequestSchema, clientFileResultSchema } from "@/types/clientFiles";

export const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: clientFileResultSchema }),
  z.strictObject({ ok: z.literal(false), error: z.string().min(1).max(8000) }),
]);
type Response = z.infer<typeof responseSchema>;
type PendingCall = { ownerId: string; runId: string; directoryId: string; cwd: string; finish(response: Response): void };
const pendingCalls = new Map<string, PendingCall>();
const activeRuns = new Map<string, { cwd: string; ownerId: string; directoryId: string; cancel(): void }>();

export function createClientFileContext(cwd: string, ownerId: string, runId: string, directory: ClientFileDirectory,
  send: (event: Extract<AgentEvent, { type: "clientFileCall" }>) => void, onCancel: () => void) {
  if (activeRuns.has(runId)) throw Object.assign(new Error("本机文件执行标识已使用，请重新发送"), { status: 409 });
  const activeCalls = new Set<string>();
  let disposed = false;
  let queue = Promise.resolve();
  const context: ClientFileContext = {
    ownerId, runId, directory,
    call(request, signal) {
      const pending = queue.then(() => {
        if (disposed) throw new Error("本机文件读取所属对话已结束");
        signal?.throwIfAborted();
        const args = clientFileRequestSchema.parse(request);
        const callId = crypto.randomUUID();
        return new Promise<ClientFileResult>((resolve, reject) => {
          const finish = (response: Response) => {
            if (!pendingCalls.delete(callId)) return;
            activeCalls.delete(callId);
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (!response.ok) return reject(new Error(response.error));
            if (response.result.action !== args.action || response.result.path !== args.path ||
              response.result.action === "read" && response.result.offset !== (args.action === "read" ? args.offset ?? 0 : 0)) {
              return reject(new Error("本机文件返回结果与请求不匹配"));
            }
            resolve(response.result);
          };
          const abort = () => finish({ ok: false, error: "本机文件读取已取消" });
          const timer = setTimeout(() => finish({ ok: false, error: "本机文件读取超时，请确认操作端仍在线" }), 30000);
          pendingCalls.set(callId, { cwd, ownerId, runId, directoryId: directory.id, finish });
          activeCalls.add(callId);
          signal?.addEventListener("abort", abort, { once: true });
          try { send({ type: "clientFileCall", runId, directoryId: directory.id, callId, request: args }); }
          catch (error) { finish({ ok: false, error: error instanceof Error ? error.message : "无法发送本机文件读取请求" }); }
        });
      });
      queue = pending.then(() => {}, () => {});
      return pending;
    },
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    activeRuns.delete(runId);
    for (const callId of activeCalls) pendingCalls.get(callId)?.finish({ ok: false, error: "本机文件读取所属对话已结束" });
  }
  activeRuns.set(runId, { cwd, ownerId, directoryId: directory.id, cancel() { dispose(); onCancel(); } });
  return { context, dispose };
}

export function cancelClientFileRun(cwd: string, ownerId: string, runId: string, directoryId: string) {
  const run = activeRuns.get(runId);
  if (!run) return;
  if (run.cwd !== cwd || run.ownerId !== ownerId || run.directoryId !== directoryId) {
    throw Object.assign(new Error("本机文件执行不属于当前设备"), { status: 403 });
  }
  run.cancel();
}

export function finishClientFileCall(cwd: string, ownerId: string, runId: string, directoryId: string, callId: string, response: Response) {
  const pending = pendingCalls.get(callId);
  if (!pending || pending.cwd !== cwd || pending.ownerId !== ownerId || pending.runId !== runId || pending.directoryId !== directoryId) {
    throw Object.assign(new Error("本机文件调用不存在、已结束或不属于当前设备"), { status: 403 });
  }
  pending.finish(response);
}
