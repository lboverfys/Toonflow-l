import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.delete("/", localOnly("请在桌面端或服务器本机卸载技能"), validateFields({ name: z.string().min(1).max(1024) }), async (req, res) => {
  const release = u.workspaceFile.lockWorkspaceFiles([u.skillFile.directory()]);
  try {
    await u.skillFile.uninstall(req.body.name);
    res.json(success(null, "技能已卸载"));
  } finally { release(); }
});