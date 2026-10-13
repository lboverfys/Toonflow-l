import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", localOnly("请在桌面端或服务器本机管理团队"), validateFields({ name: z.string().regex(u.teams.teamNamePattern), enabled: z.boolean() }), async (req, res) => {
  await u.teams.setEnabled(req.body.name, req.body.enabled);
  res.json(success({ name: req.body.name, enabled: req.body.enabled }));
});
