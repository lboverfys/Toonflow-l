import { Router } from "express";
import u from "@/utils";
import { localOnly } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", localOnly("请在桌面端或服务器本机读取 A2A 设置"), (req, res) => {
  const settings = u.a2aSettings.getA2aSettings();
  res.set("Cache-Control", "no-store").json(success({ ...settings, token: settings.token || undefined, url: u.a2aSettings.getA2aUrl(req) }));
});
