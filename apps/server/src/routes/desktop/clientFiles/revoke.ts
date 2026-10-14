import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ scopeId: z.uuid() }), async (req, res) => {
  await u.clientFiles.revoke(req.app, req.body.scopeId);
  res.json(success());
});
