import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ scopeId: z.uuid(), id: z.uuid(), runId: z.uuid(), active: z.boolean() }), async (req, res) => {
  const { scopeId, id, runId, active } = req.body;
  await u.clientFiles.changeRun(req.app, scopeId, id, runId, active);
  res.json(success());
});
