import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", localOnly("请在桌面端或服务器本机管理技能"), validateFields({ name: z.string().min(1).max(1024), enabled: z.boolean() }), async (req, res) => {
  const { name, enabled } = req.body as { name: string; enabled: boolean };
  const release = u.workspaceFile.lockWorkspaceFiles([u.skillFile.directory()]);
  try {
    await u.skillFile.setEnabled(name, enabled);
    res.json(success({ name, enabled }));
  } finally { release(); }
});
