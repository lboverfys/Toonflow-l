import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1), runId: z.uuid(), directoryId: z.uuid() }), async (req, res) => {
  const device = u.mobileLink.getMobileLinkDevice(req);
  if (!device) throw Object.assign(new Error("本机文件执行必须由已配对的操作端取消"), { status: 403 });
  const { directory, runId, directoryId } = req.body;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  u.clientFileBridge.cancelClientFileRun(cwd, device.id, runId, directoryId);
  res.json(success());
});
