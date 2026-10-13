import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", localOnly("请在桌面端或服务器本机管理供应商"), validateFields({
  fileName: u.mediaProvider.mediaProviderFileSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}), async (req, res) => {
  res.json(success(await u.mediaProvider.refreshMediaProviderModels(req.body.fileName, req.body.revision)));
});
