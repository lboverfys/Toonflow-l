import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", localOnly("请在桌面端或服务器本机管理文件扩展配置"), validateFields({ name: u.extPlugins.extNameSchema, config: z.record(z.string(), z.json()) }), async (req, res) => {
  const { name, config } = req.body;
  const release = u.workspaceFile.lockWorkspaceFiles([resolve(u.extPlugins.extDirectory, `${name}.umd.js`)]);
  try {
    const { configRules } = await u.extPlugins.readExt(name);
    const parsed = u.extPlugins.validateExtConfig(configRules, config);
    u.conf.set("extConfigs", { ...u.conf.get("extConfigs", {}), [name]: parsed });
    res.json(success(parsed, "文件扩展配置已保存"));
  } finally { release(); }
});
