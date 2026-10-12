import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), offset: z.coerce.number().int().nonnegative().optional() }, "query"), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  res.set("Cache-Control", "no-store");
  try {
    const { path } = await u.workspaceFile.resolveWorkspacePath(cwd, ".agent/sessions");
    const items = await u.agent.listAgentSessions(cwd, path);
    const offset = Number(req.query.offset ?? 0);
    res.json(success(req.query.offset === undefined ? items : { items: items.slice(offset, offset + 30), nextOffset: offset + 30 < items.length ? offset + 30 : undefined }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    res.json(success(req.query.offset === undefined ? [] : { items: [] }));
  }
});
