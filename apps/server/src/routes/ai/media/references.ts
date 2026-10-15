import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({
  providerId: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/),
  modelId: z.string().min(1).max(200),
  source: z.enum(["input", "output"]),
  offset: z.string().regex(/^\d{1,6}$/),
  search: z.string().max(200),
}, "query"), async (req, res) => {
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  try {
    const data = await u.mediaGeneration.getVideoReferences(String(req.query.providerId), String(req.query.modelId), {
      source: req.query.source as "input" | "output", offset: Number(req.query.offset), search: String(req.query.search),
    }, controller.signal);
    res.json(success(data));
  } finally { res.off("close", close); }
});
