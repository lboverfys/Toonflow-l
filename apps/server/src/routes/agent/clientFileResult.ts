import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1), runId: z.uuid(), directoryId: z.uuid(), callId: z.uuid(), response: u.clientFileBridge.responseSchema }), async (req, res) => {
  const device = u.mobileLink.getMobileLinkDevice(req);
  if (!device) throw Object.assign(new Error("本机文件结果必须由已配对的操作端返回"), { status: 403 });
  const { directory, runId, directoryId, callId, response } = req.body;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  u.clientFileBridge.finishClientFileCall(cwd, device.id, runId, directoryId, callId, response);
  res.json(success());
});
