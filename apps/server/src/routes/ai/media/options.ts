import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({
  providerId: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/),
  modelId: z.string().min(1).max(200),
}, "query"), async (req, res) => {
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  try {
    res.json(success(await u.mediaGeneration.getVideoOptions(String(req.query.providerId), String(req.query.modelId), controller.signal)));
  } finally { res.off("close", close); }
});
