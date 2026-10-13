import { Router } from "express";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", localOnly("请在桌面端或服务器本机管理供应商"), validateFields({ source: u.providerDebug.providerDebugSchema.source }), async (req, res) => {
  res.json(success(await u.providerDebug.inspectProviderSource(req.body.source)));
});
