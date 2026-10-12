import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const itemSchema = z.object({ type: z.enum(["image", "video"]), outputDirectory: z.string().min(1).max(2048) });
export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), items: z.array(itemSchema).min(1).max(50) }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const items = req.body.items as z.infer<typeof itemSchema>[];
  const results = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    results.push(...await Promise.all(items.slice(offset, offset + 4).map(async item => {
      try {
        const task = await (item.type === "image" ? u.mediaGeneration.getImageTask : u.mediaGeneration.getVideoTask)(directory, item.outputDirectory);
        return { ...item, task };
      } catch (error) { return { ...item, error: error instanceof Error ? error.message : "任务状态读取失败" }; }
    })));
  }
  res.set("Cache-Control", "no-store").json(success(results));
});
