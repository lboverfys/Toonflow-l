import { computed, ref, type Ref } from "vue";
import { nodeTools, z } from "@toonflow/nodes-scaffold/nodeTools";
import type { NodeOutputs } from "@toonflow/nodes-scaffold/values";
import { useNode } from "@vue-flow/core";

export type GenerationTiming = { startedAt: number; endedAt?: number; operationId?: string; status: "running" | "succeeded" | "failed" | "interrupted" };

export function useNodeGeneration(outputs: Readonly<Ref<NodeOutputs>>, cancel: () => void, cancelMessage = "生成已取消") {
  const { node } = useNode();
  const status = ref<"idle" | "running" | "succeeded" | "failed">("idle");
  const error = ref("");
  const generating = computed(() => status.value === "running");
  const getStatus = () => ({ status: status.value, outputs: outputs.value, ...(error.value ? { error: error.value } : {}) });

  nodeTools.register({
    name: "getGenerationStatus",
    description: "按需查询本次打开节点后的生成状态（idle/running/succeeded/failed）、当前输出和最近一次生成错误。running 时默认继续独立工作或结束本轮，不循环查询等待，除非用户明确要求等待结果。当前输出可能来自之前的生成；idle 不表示没有历史输出，只有 succeeded 表示本次生成成功",
    parameters: z.strictObject({}),
    execute: getStatus,
  });
  nodeTools.register({
    name: "cancelGeneration",
    description: "请求停止当前后台生成；cancellationRequested 表示已发出停止请求，随后用 getGenerationStatus 查询终止状态。不会删除已有输出，不能保证供应商撤销任务或费用",
    parameters: z.strictObject({}),
    execute() {
      const cancellationRequested = generating.value;
      if (cancellationRequested) cancel();
      return { ...getStatus(), cancellationRequested };
    },
  });

  function syncTask(task: { operationId: string; startedAt: number; endedAt?: number; phase: string; running: boolean }) {
    const previous = node.data.generationTiming as GenerationTiming | undefined;
    if (generating.value && previous?.operationId !== task.operationId) return;
    if (previous?.operationId !== task.operationId && previous && previous.startedAt > task.startedAt) return;
    const timing: GenerationTiming = { startedAt: task.startedAt, endedAt: task.endedAt, operationId: task.operationId,
      status: task.phase === "completed" ? "succeeded" : ["failed", "expired"].includes(task.phase) ? "failed" : task.running ? "running" : "interrupted" };
    if (JSON.stringify(previous) !== JSON.stringify(timing)) node.data.generationTiming = timing;
  }

  async function run<T>(task: () => Promise<T>, options: { startedAt?: number; operationId?: string } = {}): Promise<T> {
    if (generating.value) throw new Error("节点正在生成，请等待完成");
    status.value = "running";
    error.value = "";
    const previous = node.data.generationTiming as GenerationTiming | undefined;
    const timing: GenerationTiming = { startedAt: options.startedAt ?? (options.operationId && previous?.operationId === options.operationId ? previous.startedAt : Date.now()), operationId: options.operationId, status: "running" };
    node.data.generationTiming = timing;
    try {
      const result = await task();
      status.value = "succeeded";
      const current = node.data.generationTiming as GenerationTiming;
      node.data.generationTiming = { ...current, status: "succeeded", endedAt: current.endedAt ?? Date.now() };
      return result;
    } catch (failure) {
      status.value = "failed";
      const current = node.data.generationTiming as GenerationTiming;
      const httpStatus = (failure as { status?: number }).status;
      const rejected = httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && ![408, 409, 429].includes(httpStatus);
      if (!current.endedAt) node.data.generationTiming = options.operationId && !rejected || failure instanceof Error && failure.name === "AbortError"
        ? { ...current, status: "interrupted" } : { ...current, status: "failed", endedAt: Date.now() };
      const message = (failure as { response?: { data?: { message?: string } } })?.response?.data?.message;
      error.value = failure instanceof Error && failure.name === "AbortError" ? cancelMessage
        : message || (failure instanceof Error ? failure.message : "生成失败");
      throw failure;
    }
  }

  return { generating, run, syncTask };
}
