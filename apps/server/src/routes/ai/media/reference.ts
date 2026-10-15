import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";

export default Router().get("/", validateFields({
  providerId: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/),
  modelId: z.string().min(1).max(200),
  source: z.enum(["input", "output"]),
  path: z.string().min(1).max(2048),
}, "query"), async (req, res) => {
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  try {
    const asset = await u.mediaGeneration.getVideoReference(String(req.query.providerId), String(req.query.modelId), req.query.source as "input" | "output", String(req.query.path), AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(asset.mimeType).send(asset.bytes);
  } finally { res.off("close", close); }
});
