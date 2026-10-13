import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().delete("/", localOnly("请在桌面端或服务器本机卸载团队"), validateFields({ name: z.string().regex(u.teams.teamNamePattern) }), async (req, res) => {
  await u.teams.uninstall(req.body.name);
  res.json(success(null, "团队已卸载"));
});
