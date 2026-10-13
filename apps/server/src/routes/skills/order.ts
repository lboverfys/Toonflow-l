import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.put("/", localOnly("请在桌面端或服务器本机调整技能文件顺序"), validateFields({
  name: z.string().min(1).max(1024),
  order: z.array(z.string().min(1).max(1024)).max(2000),
}), async (req, res) => {
  const { name, order } = req.body as { name: string; order: string[] };
  const release = u.workspaceFile.lockWorkspaceFiles([u.skillFile.directory()]);
  try {
    await u.skillFile.saveOrder(name, order);
    res.json(success(null, "顺序已保存"));
  } finally { release(); }
});
