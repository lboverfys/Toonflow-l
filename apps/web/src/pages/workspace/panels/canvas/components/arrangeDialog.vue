<template>
  <el-dialog
    :modelValue="visible"
    title="智能整理画布"
    width="min(720px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    :closeOnClickModal="false"
    :closeOnPressEscape="!applying"
    :showClose="!applying"
    @update:modelValue="!$event && cancel()">
    <div class="arrangeDialog">
      <div class="modelRow">
        <span id="arrangeModelLabel">文字模型</span>
        <el-select
          v-model="model"
          filterable
          :disabled="loading || applying"
          aria-labelledby="arrangeModelLabel"
          placeholder="选择文字模型"
          noDataText="请先在设置中添加文字模型"
          @change="analyze">
          <el-option v-for="item in models" :key="JSON.stringify([item.providerId, item.modelId])"
            :value="JSON.stringify([item.providerId, item.modelId])" :label="`${item.providerLabel} · ${item.label}`" />
        </el-select>
      </div>
      <p class="arrangeScope">分析当前画布的节点文字与连接，确认后重新分组并排列。原节点内容和连接保留，整次整理可一步撤销。</p>
      <p v-if="loading" class="analysisStatus" role="status" aria-live="polite">{{ status }}</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon />
      <div v-if="plan" class="planPreview">
        <p class="planSummary">{{ plan.snapshot.nodes.length }} 个节点 · {{ plan.groups.length }} 个分组 · 按阶段从左到右展开</p>
        <section v-for="(group, index) in plan.groups" :key="index" class="groupPreview">
          <div class="groupHeader">
            <strong>{{ group.name }}</strong>
            <span>阶段 {{ stages.indexOf(group.stage) + 1 }} · {{ group.nodeIds.length }} 个节点</span>
          </div>
          <p class="groupReason">{{ group.reason }}</p>
          <ul class="groupMembers">
            <li v-for="id in group.nodeIds" :key="id" :title="nodeLabels.get(id)">{{ nodeLabels.get(id) }}</li>
          </ul>
        </section>
      </div>
    </div>
    <template #footer>
      <el-button :disabled="applying" @click="cancel">取消</el-button>
      <el-button :disabled="loading || applying" @click="analyze">{{ plan || error ? "重新分析" : "分析分组" }}</el-button>
      <el-button type="primary" :disabled="!plan || loading" :loading="applying" @click="confirm">确认整理并分组</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { useNodeAi, type NodeAiModel } from "@toonflow/nodes-scaffold/nodeAi";
import { arrangeCanvas } from "../arrangeCanvas";
import { arrangeSystemPrompt, captureArrangeSnapshot, createArrangePrompt, parseArrangePlan, type CanvasArrangeGroup } from "../arrangePlan";

const props = defineProps<{
  active: boolean;
  canvasId: string;
  directory: string | undefined;
  projectName: string;
  batchHistory: (action: () => Promise<void>) => Promise<void>;
}>();
type ArrangeResult = Awaited<ReturnType<typeof arrangeCanvas>>;
type ArrangeRequest = {
  controller: AbortController;
  signal: AbortSignal;
  resolve: (result: ArrangeResult) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
const flow = useVueFlow();
const ai = useNodeAi();
const visible = ref(false);
const loading = ref(false);
const applying = ref(false);
const status = ref("");
const error = ref("");
const model = ref("");
const models = shallowRef<NodeAiModel[]>([]);
const plan = shallowRef<{ snapshot: ReturnType<typeof captureArrangeSnapshot>; groups: CanvasArrangeGroup[] }>();
const nodeLabels = computed(() => new Map(plan.value?.snapshot.nodes.map(node => [node.id, node.label]) ?? []));
const stages = computed(() => [...new Set(plan.value?.groups.map(group => group.stage) ?? [])]);
let pending: ArrangeRequest | undefined;

function finish(request: ArrangeRequest, result?: ArrangeResult, failure?: unknown) {
  if (pending !== request) return;
  pending = undefined;
  request.signal.removeEventListener("abort", request.abort);
  request.controller.abort();
  visible.value = false;
  loading.value = false;
  applying.value = false;
  if (result) request.resolve(result);
  else request.reject(failure ?? new DOMException("已取消整理", "AbortError"));
}

function cancel() {
  pending?.controller.abort(new DOMException("已取消整理", "AbortError"));
}

function open(signal?: AbortSignal): Promise<ArrangeResult> {
  if (pending) return Promise.reject(new Error("整理窗口已打开，请先完成或取消当前整理"));
  if (!props.active) return Promise.reject(new Error("请先切换到要整理的画布"));
  if (!props.directory || !props.canvasId) return Promise.reject(new Error("请先打开画布"));
  const controller = new AbortController();
  const result = Promise.withResolvers<ArrangeResult>();
  const request: ArrangeRequest = {
    controller, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    resolve: result.resolve, reject: result.reject, abort: () => finish(request, undefined, request.signal.reason),
  };
  pending = request;
  plan.value = undefined;
  error.value = "";
  visible.value = true;
  request.signal.addEventListener("abort", request.abort, { once: true });
  if (request.signal.aborted) request.abort();
  else void analyze();
  return result.promise;
}

async function analyze() {
  const request = pending;
  if (!request || loading.value || applying.value) return;
  loading.value = true;
  error.value = "";
  plan.value = undefined;
  status.value = "正在加载文字模型…";
  try {
    models.value = await ai.getModels(request.signal);
    request.signal.throwIfAborted();
    let selected = models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === model.value);
    if (!selected) {
      selected = models.value[0];
      model.value = selected ? JSON.stringify([selected.providerId, selected.modelId]) : "";
    }
    if (!selected) throw new Error("请先在设置中添加可用的文字模型");
    const snapshot = captureArrangeSnapshot(flow.getNodes.value, flow.getEdges.value);
    const prompt = createArrangePrompt(snapshot, props.projectName, props.canvasId, selected.contextWindow);
    status.value = `正在分析 ${snapshot.nodes.length} 个节点的分组与连接…`;
    const result = await ai.generate({
      providerId: selected.providerId, modelId: selected.modelId, prompt, systemPrompt: arrangeSystemPrompt,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(180000)]),
    });
    request.signal.throwIfAborted();
    if (pending !== request) return;
    if (captureArrangeSnapshot(flow.getNodes.value, flow.getEdges.value).key !== snapshot.key) {
      throw new Error("分析期间画布已发生变化，请重新分析");
    }
    plan.value = { snapshot, groups: parseArrangePlan(result.text, snapshot.nodes.map(node => node.id)) };
  } catch (failure) {
    if (pending === request && !request.signal.aborted) {
      error.value = failure instanceof Error ? failure.message : "AI 分组分析失败";
    }
  } finally {
    if (pending === request) loading.value = false;
  }
}

async function confirm() {
  const request = pending;
  const proposal = plan.value;
  if (!request || !proposal || loading.value || applying.value) return;
  if (!props.active) return cancel();
  applying.value = true;
  error.value = "";
  try {
    let result: ArrangeResult | undefined;
    await props.batchHistory(async () => {
      request.signal.throwIfAborted();
      if (captureArrangeSnapshot(flow.getNodes.value, flow.getEdges.value).key !== proposal.snapshot.key) {
        throw new Error("画布已发生变化，请重新分析后确认");
      }
      result = await arrangeCanvas(flow, proposal.groups, request.signal);
    });
    if (result) finish(request, result);
  } catch (failure) {
    if (pending === request && !request.signal.aborted) {
      error.value = failure instanceof Error ? failure.message : "整理画布失败";
      plan.value = undefined;
    }
  } finally {
    if (pending === request) applying.value = false;
  }
}

watch(() => [props.directory, props.canvasId], cancel, { flush: "sync" });
watch(() => props.active, active => { if (!active) cancel(); }, { flush: "sync" });
onBeforeUnmount(cancel);
defineExpose({ open, visible });
</script>

<style lang="scss" scoped>
.arrangeDialog {
  .modelRow {
    display: flex;
    align-items: center;
    gap: 16px;

    > span { flex-shrink: 0; }
    .el-select { flex: 1; min-width: 0; }
  }

  .arrangeScope,
  .planSummary,
  .analysisStatus {
    margin: 16px 0;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
  }

  .analysisStatus { color: var(--el-color-primary); }

  .planPreview {
    max-height: min(52vh, 540px);
    overflow: auto;

    .groupPreview {
      margin-bottom: 12px;
      padding: 16px;
      border: 1px solid var(--el-border-color-light);
      border-radius: var(--el-border-radius-base);

      .groupHeader {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 8px;

        strong { color: var(--el-text-color-primary); overflow-wrap: anywhere; }
        span { color: var(--el-text-color-secondary); font-size: 12px; }
      }

      .groupReason { margin: 8px 0 12px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }

      .groupMembers {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 0;
        padding: 0;
        list-style: none;

        li {
          max-width: 100%;
          padding: 4px 8px;
          border-radius: 4px;
          background: var(--el-fill-color-light);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }
    }
  }
}
</style>
