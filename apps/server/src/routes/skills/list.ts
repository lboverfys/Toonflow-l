import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", localOnly("请在桌面端或服务器本机查看技能文件"), validateFields({ name: z.string().min(1).max(1024) }, "query"), async (req, res) => {
  const release = u.workspaceFile.lockWorkspaceFiles([u.skillFile.directory()]);
  try {
    const { mainPath, files } = await u.skillFile.list(req.query.name as string);
    res.set("Cache-Control", "no-store").json(success({ mainPath, files }));
  } finally { release(); }
});
