import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", localOnly("请在 Toonflow 所在电脑登录"), validateFields({ screen: z.enum(["signin", "signup"]) }), (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  res.json(success(u.account.startLogin(req.socket.localPort!, req.body.screen)));
});
