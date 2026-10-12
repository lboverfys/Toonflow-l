import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ requestId: z.uuid(), error: z.string().max(4096).optional() }), (req, res) => {
  res.once("finish", () => req.app.locals.desktop.closePrepared(req.body.requestId, req.body.error));
  res.json(success(null));
});
