import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  await u.workspaceFile.resolveWorkspacePath(directory, req.query.path as string, true);
  res.set("Cache-Control", "no-store").json(success(await u.canvasSync.readRecovery(directory, req.query.path as string, u.mobileLink.getMobileLinkDevice(req)?.id ?? "host")));
});
