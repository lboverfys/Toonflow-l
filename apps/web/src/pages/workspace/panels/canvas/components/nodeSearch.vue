<template>
  <el-dialog v-model="visible" title="画布节点搜索" width="min(560px, calc(100vw - 32px))" alignCenter appendToBody @opened="focusSearch">
    <div class="nodeSearch" @keydown.capture="navigateResults">
      <el-input
        ref="searchInput"
        v-model="query"
        class="searchInput"
        :prefixIcon="IconSearch"
        placeholder="搜索名称、类型、分组或文字摘要"
        aria-label="搜索画布节点"
        containerRole="combobox"
        aria-autocomplete="list"
        :aria-expanded="visible"
        :aria-controls="listId"
        :aria-activedescendant="activeResultId"
        clearable />
      <div class="searchScopes" aria-label="搜索范围">
        <button type="button" :aria-pressed="scope === 'all'" @click="changeScope('all')">全部节点</button>
        <button type="button" :aria-pressed="scope === 'groups'" @click="changeScope('groups')">仅分组</button>
        <span class="resultCount" role="status">{{ results.length }} 个结果</span>
      </div>
      <div :id="listId" ref="resultList" class="resultList" role="listbox" aria-label="画布节点" :aria-busy="selecting">
        <div class="resultRows" :style="{ height: `${listVirtualizer.getTotalSize()}px` }" role="presentation">
          <button
            v-for="{ item, index, start, preview } in visibleRows"
            :id="`${listId}-${index}`"
            :key="item.node.id"
            class="nodeResult"
            :style="{ transform: `translateY(${start}px)` }"
            type="button"
            role="option"
            tabindex="-1"
            :aria-selected="activeIndex === index"
            :aria-disabled="selecting"
            :aria-posinset="index + 1"
            :aria-setsize="results.length"
            :title="`${item.label} · ${item.typeLabel} · ${item.groupLabel}`"
            @mouseenter="activeIndex = index"
            @mousedown.prevent
            @click="selectNode(index)">
            <span class="nodeHeading"><span class="nodeLabel">{{ item.label }}</span><span class="nodeType">{{ item.typeLabel }}</span></span>
            <span class="nodeSummary"><span class="nodeGroup">{{ item.groupLabel }}</span><span v-if="preview" class="nodePreview">{{ preview }}</span></span>
          </button>
        </div>
        <p v-if="!results.length" class="empty" role="status">{{ query.trim() ? '没有匹配的节点' : scope === 'groups' ? '当前画布暂无分组' : '当前画布暂无可定位的节点' }}</p>
      </div>
      <p v-if="selectionError" class="selectionError" role="alert">{{ selectionError }}</p>
      <div class="searchFooter"><span>{{ selecting ? '正在定位…' : '↑ ↓ 选择 · Enter 定位 · Esc 关闭' }}</span><span title="仅检索提示词及文本输出的开头摘要">文字按摘要搜索</span></div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { IconSearch } from "@tabler/icons-vue";
import type { InputInstance } from "element-plus";
import { canvasNodeSummary } from "../canvasQueries";

const props = defineProps<{ disabled?: boolean; nodeTypes?: { type: string; label: string }[]; focusNodes: (ids: string[]) => Promise<boolean> }>();
const flow = useVueFlow();
const listId = useId();
const visible = ref(false);
const query = ref("");
const scope = ref<"all" | "groups">("all");
const activeIndex = ref(0);
const searchInput = ref<InputInstance>();
const resultList = ref<HTMLDivElement>();
const selecting = ref(false);
const selectionError = ref("");
let selectionRequest = 0;
const keyword = computed(() => query.value.trim().toLocaleLowerCase());
const indexedNodes = computed(() => {
  if (!visible.value || props.disabled) return [];
  const nodes = flow.getNodes.value;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const typeLabels = new Map(props.nodeTypes?.map(type => [type.type, type.label]));
  return nodes.filter(node => !node.hidden).map(node => {
    const typeLabel = node.type === "canvasGroup" ? "分组" : typeLabels.get(node.type ?? "") ?? node.type?.replace(/^remote-/, "") ?? "节点";
    const label = canvasNodeSummary(node).label || typeLabel;
    const parent = byId.get(node.parentNode ?? "");
    const groupLabel = parent ? canvasNodeSummary(parent).label || "分组" : "未分组";
    const content = textSummary(node);
    return { node, label, typeLabel, groupLabel, content,
      searchText: `${label} ${typeLabel} ${node.type ?? ""} ${node.id} ${groupLabel} ${content}`.toLocaleLowerCase() };
  });
});
const results = computed(() => {
  return indexedNodes.value.filter(item => (scope.value === "all" || item.node.type === "canvasGroup") && item.searchText.includes(keyword.value));
});
const listVirtualizer = useVirtualizer<HTMLDivElement, HTMLButtonElement>(computed(() => ({
  count: results.value.length,
  getScrollElement: () => resultList.value ?? null,
  getItemKey: (index: number) => results.value[index]?.node.id ?? index,
  estimateSize: () => 64,
  overscan: 4,
  enabled: visible.value && !props.disabled,
})));
const visibleRows = computed(() => listVirtualizer.value.getVirtualItems().flatMap(row => {
  const item = results.value[row.index];
  if (!item) return [];
  const excerptStart = Math.max(0, item.content.toLocaleLowerCase().indexOf(keyword.value) - 24);
  const preview = `${excerptStart ? "…" : ""}${item.content.slice(excerptStart, excerptStart + 120)}${item.content.length > excerptStart + 120 ? "…" : ""}`;
  return [{ item, index: row.index, start: row.start, preview }];
}));
const activeResultId = computed(() => visibleRows.value.some(row => row.index === activeIndex.value) ? `${listId}-${activeIndex.value}` : undefined);

watch([query, scope], () => { activeIndex.value = 0; selectionError.value = ""; });
watch(results, items => { activeIndex.value = Math.min(activeIndex.value, Math.max(0, items.length - 1)); });
watch([query, scope, activeIndex], () => {
  if (visible.value && !props.disabled && results.value[activeIndex.value]) listVirtualizer.value.scrollToIndex(activeIndex.value, { align: "auto" });
}, { flush: "post" });
watch(() => props.disabled, disabled => { if (disabled) visible.value = false; }, { flush: "sync" });
watch(visible, value => {
  if (value) return;
  selectionRequest++;
  selecting.value = false;
  selectionError.value = "";
}, { flush: "sync" });
onBeforeUnmount(() => { selectionRequest++; });

function textSummary(node: GraphNode) {
  // ACT: 每节点最多读取提示词前 2048 字及前 32 个输出中共 2048 字的文本；全文搜索需独立索引。
  const parts = typeof node.data.prompt === "string" ? [node.data.prompt.slice(0, 2048)] : [];
  const outputs = node.data.outputs;
  let remaining = 2048;
  let visited = 0;
  if (outputs && typeof outputs === "object") for (const id in outputs) {
    if (!Object.hasOwn(outputs, id)) continue;
    if (visited++ >= 32 || remaining <= 0) break;
    const output = outputs[id];
    if (!output || output.dataType !== "STRING" || typeof output.value !== "string") continue;
    const text = output.value.slice(0, remaining);
    parts.push(text);
    remaining -= text.length;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function focusSearch() {
  if (!visible.value || props.disabled) return;
  searchInput.value?.focus();
  listVirtualizer.value.measure();
  if (results.value.length) listVirtualizer.value.scrollToIndex(activeIndex.value, { align: "auto" });
}

function changeScope(value: "all" | "groups") {
  scope.value = value;
  searchInput.value?.focus();
}

function open() {
  if (props.disabled) return;
  selectionRequest++;
  selecting.value = false;
  selectionError.value = "";
  query.value = "";
  scope.value = "all";
  activeIndex.value = 0;
  visible.value = true;
  focusSearch();
}

function navigateResults(event: KeyboardEvent) {
  // Tab 留给弹窗的焦点循环，其余按键不传递到画布快捷键。
  if (event.key === "Tab") return;
  event.stopPropagation();
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    visible.value = false;
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLocaleLowerCase() === "f") {
    event.preventDefault();
    searchInput.value?.select();
    return;
  }
  if (!(event.target instanceof Element) || !event.target.closest(".searchInput, .resultList") || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
  event.preventDefault();
  if (selecting.value || !results.value.length) return;
  if (event.key === "ArrowDown") activeIndex.value = Math.min(activeIndex.value + 1, results.value.length - 1);
  else if (event.key === "ArrowUp") activeIndex.value = Math.max(activeIndex.value - 1, 0);
  else void selectNode(activeIndex.value);
}

async function selectNode(index: number) {
  const node = results.value[index]?.node;
  if (!node || node.hidden || flow.findNode(node.id) !== node || props.disabled || !visible.value || selecting.value) return;
  const request = ++selectionRequest;
  selecting.value = true;
  selectionError.value = "";
  try {
    const focused = await props.focusNodes([node.id]);
    if (request !== selectionRequest || props.disabled || !visible.value) return;
    if (flow.findNode(node.id) !== node || node.hidden) {
      selectionError.value = "目标节点已变化，请重新选择";
      return;
    }
    if (!focused) {
      selectionError.value = "节点暂时无法定位，请稍后重试";
      return;
    }
    if (node.selectable !== false) {
      flow.removeSelectedElements();
      flow.addSelectedNodes([node]);
      flow.nodesSelectionActive.value = false;
    }
    visible.value = false;
  } catch (error) {
    if (request === selectionRequest && !props.disabled && visible.value) selectionError.value = error instanceof Error ? error.message : "节点定位失败";
  } finally {
    if (request === selectionRequest) selecting.value = false;
  }
}

defineExpose({ open });
</script>

<style lang="scss" scoped>
.nodeSearch {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .searchScopes {
    display: flex;
    align-items: center;
    gap: 8px;

    button {
      padding: 5px 10px;
      border: 1px solid var(--el-border-color);
      border-radius: var(--el-border-radius-base);
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      font-size: 12px;
      cursor: pointer;

      &[aria-pressed="true"] { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
    }
    .resultCount { margin-left: auto; color: var(--el-text-color-secondary); font-size: 12px; }
  }

  .resultList {
    max-height: min(360px, 50vh);
    overflow-y: auto;
    overscroll-behavior: contain;

    .resultRows {
      position: relative;

      .nodeResult {
        position: absolute;
        inset: 0 0 auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
        width: 100%;
        height: 64px;
        padding: 10px 12px;
        border: 0;
        border-radius: var(--el-border-radius-base);
        background: transparent;
        color: var(--el-text-color-primary);
        font: inherit;
        text-align: left;
        cursor: pointer;

        &[aria-selected="true"] { background: var(--el-color-primary-light-9); }
        &[aria-disabled="true"] { cursor: progress; }
        &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
        .nodeHeading, .nodeSummary { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; }
        .nodeHeading {
          line-height: 22px;
          .nodeLabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .nodeType { flex-shrink: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-color-primary); font-size: 12px; }
        }
        .nodeSummary {
          color: var(--el-text-color-secondary);
          font-size: 12px;
          line-height: 18px;
          .nodeGroup { flex-shrink: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .nodePreview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        }
      }
    }
    .empty { margin: 32px 0; color: var(--el-text-color-secondary); text-align: center; }
  }

  .selectionError { margin: 0; color: var(--el-color-danger); font-size: 12px; }
  .searchFooter { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; color: var(--el-text-color-secondary); font-size: 12px; }
}
</style>
