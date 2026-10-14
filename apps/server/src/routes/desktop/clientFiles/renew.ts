import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ scopeId: z.uuid(), id: z.uuid() }), (req, res) => {
  u.clientFiles.renew(req.app, req.body.scopeId, req.body.id);
  res.json(success());
});
