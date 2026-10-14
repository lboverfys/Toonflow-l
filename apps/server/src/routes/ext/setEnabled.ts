import { lstat, unlink, writeFile } from "@toonflow/file";
import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().put("/", localOnly("请在桌面端或服务器本机管理文件扩展"), validateFields({ name: u.extPlugins.extNameSchema, enabled: z.boolean() }), async (req, res) => {
  const { name, enabled } = req.body as { name: string; enabled: boolean };
  const path = resolve(u.extPlugins.extDirectory, `${name}.umd.js`);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try {
    const file = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (!file?.isFile()) return res.status(404).json(error("文件扩展不存在", null, 404));
    const markerPath = resolve(u.extPlugins.extDirectory, `${name}.disabled`);
    const marker = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (marker && !marker.isFile()) return res.status(409).json(error("文件扩展状态文件无效", null, 409));
    if (enabled) await unlink(markerPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    else if (!marker) await writeFile(markerPath, "", { flag: "wx" });
    res.json(success({ name, enabled }));
  } finally { release(); }
});
