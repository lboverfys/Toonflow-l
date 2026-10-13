import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.put("/", localOnly("请在桌面端或服务器本机管理工具"), validateFields({ name: u.plugins.toolNameSchema, config: z.record(z.string(), z.json()) }), async (req, res) => {
  const { name, config } = req.body;
  const release = u.workspaceFile.lockWorkspaceFiles([resolve(u.plugins.toolsDirectory, `${name}.tool.js`)]);
  try {
    const { plugin } = await u.plugins.loadTool(name);
    const parsed = u.plugins.validateToolConfig(plugin, config);
    u.conf.set("toolConfigs", { ...u.conf.get("toolConfigs", {}), [name]: parsed });
    res.json(success(parsed, "工具配置已保存"));
  } finally { release(); }
});
