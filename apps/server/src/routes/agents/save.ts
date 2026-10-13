import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", localOnly("请在桌面端或服务器本机编辑团队文件"), validateFields({ name: z.string().regex(u.teams.teamNamePattern), path: z.string().min(1).max(1024), content: z.string() }), async (req, res) => {
  await u.teams.saveTeamFile(req.body.name, req.body.path, req.body.content);
  res.json(success(null, "已保存"));
});
