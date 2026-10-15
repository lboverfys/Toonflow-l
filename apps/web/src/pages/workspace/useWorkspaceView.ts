import { reactive, watch } from "vue";
import { z } from "zod";
import { settingsStorage } from "@/stores/settings";

const agentLayoutSchema = z.object({
  docked: z.boolean().catch(true),
  width: z.number().positive().catch(360),
  height: z.number().positive().optional().catch(undefined),
  left: z.number().nonnegative().optional().catch(undefined),
  top: z.number().nonnegative().optional().catch(undefined),
});
export type AgentLayout = z.infer<typeof agentLayoutSchema>;
const workspaceViewSchema = z.object({
  activePanel: z.enum(["canvas", "document"]).catch("canvas"),
  agentVisible: z.boolean().catch(false),
  inspectorVisible: z.boolean().catch(false),
  inspectorWidth: z.number().positive().max(600).catch(420),
  agent: agentLayoutSchema.catch({ docked: true, width: 360 }),
});

export function useWorkspaceView(directory: () => string | undefined) {
  const view = reactive(workspaceViewSchema.parse({}));
  let key = "";
  let restoring = false;
  watch(directory, value => {
    key = value ? `toonflow:workspaceView:${value}` : "";
    let saved;
    try { saved = workspaceViewSchema.parse(JSON.parse(key ? settingsStorage.getItem(key) ?? "{}" : "{}")); }
    catch { saved = workspaceViewSchema.parse({}); }
    restoring = true;
    Object.assign(view, saved);
    restoring = false;
  }, { immediate: true, flush: "sync" });
  watch(view, () => {
    if (key && !restoring) settingsStorage.setItem(key, JSON.stringify(view));
  }, { deep: true, flush: "sync" });
  return view;
}
