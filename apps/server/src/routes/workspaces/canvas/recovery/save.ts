import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { validateCanvas } from "@/utils/workspace/canvasMerge";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096), base: u.canvasSync.canvasSchema, local: u.canvasSync.canvasSchema }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  validateCanvas(req.body.base);
  validateCanvas(req.body.local);
  await u.workspaceFile.resolveWorkspacePath(directory, req.body.path, true);
  const path = await u.canvasSync.saveRecovery(directory, req.body.path, u.mobileLink.getMobileLinkDevice(req)?.id ?? "host", { base: req.body.base, local: req.body.local });
  res.json(success({ path }));
});
