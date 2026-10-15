import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096), sessionFile: z.string().regex(/^[\w-]+\.jsonl$/), runId: z.uuid(),
}), async (req, res) => {
  const { directory, sessionFile, runId } = req.body;
  const { path } = await u.workspaceFile.resolveWorkspaceFile(req, directory, `.agent/sessions/${sessionFile}`);
  const active = u.agent.getAgentRun(path, runId, u.mobileLink.getMobileLinkDevice(req)?.id);
  await active?.abort();
  res.json(success({ stopped: true }));
});
