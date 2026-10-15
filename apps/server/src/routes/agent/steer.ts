import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const input = z.object({
  directory: z.string().min(1).max(4096), sessionFile: z.string().regex(/^[\w-]+\.jsonl$/),
  runId: z.uuid(), messageId: z.uuid(), prompt: z.string().trim().min(1).max(100000),
});

export default Router().post("/", validateFields(input.shape), async (req, res) => {
  const { directory, sessionFile, runId, messageId, prompt } = input.parse(req.body);
  const { directory: cwd, path } = await u.workspaceFile.resolveWorkspaceFile(req, directory, `.agent/sessions/${sessionFile}`);
  const active = u.agent.getAgentRun(path, runId, u.mobileLink.getMobileLinkDevice(req)?.id);
  if (!active) throw Object.assign(new Error("此轮回复已结束，请重新发送消息"), { status: 409 });
  const entryId = await u.agent.steerAgentSession(cwd, active, prompt, messageId);
  res.json(success({ accepted: true, entryId }));
});
