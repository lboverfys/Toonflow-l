import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), offset: z.coerce.number().int().nonnegative().optional() }, "query"), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  const entries = await u.canvasIndex.listCanvasIndex(directory);
  const offset = Number(req.query.offset ?? 0);
  res.set("Cache-Control", "no-store").json(success({ directory, entries: entries.slice(offset, offset + 200), nextOffset: offset + 200 < entries.length ? offset + 200 : undefined }));
});
