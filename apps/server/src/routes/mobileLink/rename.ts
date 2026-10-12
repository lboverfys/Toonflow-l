import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", validateFields({ id: z.uuid(), name: z.string().trim().min(1).max(100) }), (req, res) => {
  u.mobileLink.assertMobileLinkControl(req);
  u.mobileLink.renameMobileDevice(req.body.id, req.body.name);
  res.json(success());
});
