import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  res.set({ "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  let waiting = false;
  const pending = new Set<string>();
  const send = (value: { path?: string; [key: string]: unknown }) => {
    if (res.destroyed || res.writableEnded) return;
    if (waiting) {
      if (value.path) pending.add(value.path);
      if (pending.size > 256) res.end();
      return;
    }
    waiting = !res.write(`${JSON.stringify(value)}\n`);
  };
  res.on("drain", () => {
    waiting = false;
    const paths = [...pending];
    pending.clear();
    // 慢连接只保留文件失效通知，恢复后读取最新快照，不在内存堆积整段提示词和媒体状态。
    for (const path of paths) send({ path });
  });
  const release = u.canvasSync.subscribe(directory, send);
  send({ ready: true });
  const timer = setInterval(() => send({ heartbeat: true }), 15000);
  timer.unref();
  res.once("close", () => { clearInterval(timer); release(); });
});
