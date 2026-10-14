import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { localOnly, validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", localOnly("请在桌面端或服务器本机管理供应商"), validateFields({
  fileName: u.mediaProvider.mediaProviderFileSchema,
  models: u.mediaProvider.mediaModelsSchema,
  label: z.string().trim().min(1, "请填写供应商名称").max(200, "供应商名称不能超过 200 个字符").optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}), async (req, res) => {
  res.json(success(await u.mediaProvider.saveMediaProvider(req.body.fileName, req.body.models, req.body.revision, req.body.label)));
});
