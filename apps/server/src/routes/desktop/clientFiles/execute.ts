import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ scopeId: z.uuid(), id: z.uuid(), runId: z.uuid(), request: u.clientFiles.requestSchema }), async (req, res) => {
  const { scopeId, id, runId, request } = req.body;
  res.json(success(await u.clientFiles.execute(req.app, scopeId, id, runId, request)));
});
