import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { errorFromCause, success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), paths: z.array(z.string().min(1).max(4096)).min(1).max(50) }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const items = [];
  const paths = [...new Set<string>(req.body.paths)];
  for (let offset = 0; offset < paths.length; offset += 4) {
    items.push(...await Promise.all(paths.slice(offset, offset + 4).map(async path => {
      try { return await u.mediaAccess.issueMediaAccess(req, directory, path); }
      catch (error) { return { path, error: errorFromCause(error).message }; }
    })));
  }
  res.set("Cache-Control", "no-store").json(success(items));
});
