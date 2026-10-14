<template>
  <div class="canvasMap nodrag nopan nowheel" :style="{ width: `${mapSize.width}px` }" @pointerdown.stop @mousedown.stop @click.stop @dblclick.stop @wheel.stop>
    <div class="mapHeader">
      <div class="mapTitle">
        <strong>工作流地图</strong>
        <span>{{ nodeCount }} 个节点</span>
      </div>
      <div class="mapActions">
        <el-tooltip :content="expanded ? '收起地图' : '展开地图'" :showArrow="false" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <button class="mapButton" type="button" :aria-label="expanded ? '收起地图' : '展开地图'" :aria-expanded="expanded" @click="expanded = !expanded">
            <icon-arrows-minimize v-if="expanded" :size="15" />
            <icon-arrows-maximize v-else :size="15" />
          </button>
        </el-tooltip>
        <el-tooltip content="关闭地图" :showArrow="false" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <button class="mapButton" type="button" aria-label="关闭地图" @click="emit('close')">
            <icon-x :size="15" />
          </button>
        </el-tooltip>
      </div>
    </div>
    <div
      ref="mapElement"
      class="mapViewport"
      :class="{ dragging }"
      tabindex="0"
      role="group"
      aria-label="工作流地图：单击定位，拖动巡览，双击节点聚焦，滚轮缩放。方向键移动，Enter 显示全图，Escape 关闭地图。"
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Enter Escape"
      @pointerdown.capture.stop="startPointer"
      @pointermove.stop="movePointer"
      @pointerup.stop="finishPointer"
      @pointercancel="stopPointer"
      @lostpointercapture="stopPointer"
      @mousedown.capture.stop.prevent
      @touchstart.capture.stop.prevent
      @click.capture.stop.prevent
      @dblclick.capture.stop.prevent
      @wheel.capture.stop.prevent="zoomMap"
      @keydown="navigateMap"
      @mouseleave="hoveredLabel = ''">
      <mini-map
        :width="mapSize.width"
        :height="mapSize.height"
        :style="{ position: 'relative', margin: 0, inset: 'auto' }"
        :pannable="false"
        :zoomable="false"
        :nodeColor="nodeColor"
        :nodeStrokeColor="nodeStrokeColor"
        :nodeClassName="nodeClassName"
        :nodeStrokeWidth="1"
        :nodeBorderRadius="8"
        :offsetScale="10"
        maskColor="var(--el-mask-color-extra-light)"
        maskStrokeColor="var(--el-color-primary)"
        :maskStrokeWidth="1.5"
        ariaLabel="工作流节点分布与当前视口"
        @nodeMouseenter="({ node }) => hoveredLabel = String(node.data.label || node.label || node.id)"
        @nodeMouseleave="hoveredLabel = ''" />
    </div>
    <div class="mapFooter">
      <span class="mapHint" :title="hoveredLabel || '单击定位 · 拖动巡览 · 双击节点聚焦'">{{ hoveredLabel || "单击定位 · 拖动巡览 · 双击节点聚焦" }}</span>
      <span class="mapZoom">{{ zoomPercent }}%</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import type { GraphNode, XYPosition } from "@vue-flow/core";
import { MiniMap } from "@vue-flow/minimap";
import { IconArrowsMaximize, IconArrowsMinimize, IconX } from "@tabler/icons-vue";
import type { CanvasNavigation } from "../useCanvasNavigation";

const props = defineProps<{ active: boolean; navigation: CanvasNavigation }>();
const emit = defineEmits<{ close: [] }>();
const flow = useVueFlow();
const mapElement = ref<HTMLElement>();
const expanded = ref(false);
const dragging = ref(false);
const hoveredLabel = ref("");
const nodeCount = computed(() => flow.getNodes.value.filter(node => !node.hidden && node.type !== "canvasGroup").length);
const zoomPercent = computed(() => Math.round(flow.viewport.value.zoom * 100));
const mapSize = computed(() => ({
  width: Math.max(1, Math.min(expanded.value ? 460 : 300, flow.dimensions.value.width - 32)),
  height: Math.max(1, Math.min(expanded.value ? 260 : 170, flow.dimensions.value.height - 164)),
}));
type MapPointer = {
  pointerId: number;
  element: HTMLElement;
  matrix: DOMMatrix;
  client: XYPosition;
  point: XYPosition;
  center: XYPosition;
  target: XYPosition;
  zoom: number;
  nodeId?: string;
};
let pointer: MapPointer | undefined;
let panFrame = 0;
let pendingClick: { nodeId: string; client: XYPosition; timer: ReturnType<typeof setTimeout> } | undefined;
let wheelTimer: ReturnType<typeof setTimeout> | undefined;

function viewportCenter() {
  const { x, y, zoom } = flow.viewport.value;
  return { x: (flow.dimensions.value.width / 2 - x) / zoom, y: (flow.dimensions.value.height / 2 - y) / zoom };
}

function nodeColor(node: GraphNode) {
  if (node.type === "canvasGroup") return "var(--el-fill-color)";
  const type = node.type.toLocaleLowerCase();
  const color = type.includes("text") ? "#8b7ad9" : type.includes("image") ? "#50ad91" : type.includes("video") ? "#dd9c52" : "#799ab8";
  return `color-mix(in srgb, ${color} 62%, var(--el-bg-color))`;
}

function nodeStrokeColor(node: GraphNode) {
  return node.selected ? "var(--el-color-primary)" : node.type === "canvasGroup" ? "var(--el-border-color-darker)" : "transparent";
}

function nodeClassName(node: GraphNode) {
  return node.type === "canvasGroup" ? "mapGroup" : "mapNode";
}

function clearClick() {
  if (pendingClick) clearTimeout(pendingClick.timer);
  pendingClick = undefined;
}

function startPointer(event: PointerEvent) {
  if (!props.active || event.button !== 0 || !event.isPrimary || pointer) return;
  const element = mapElement.value;
  const matrix = element?.querySelector("svg")?.getScreenCTM()?.inverse();
  if (!element || !matrix) return;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
  const nodeElement = event.target instanceof Element ? event.target.closest(".vue-flow__minimap-node") : null;
  const center = viewportCenter();
  // ACT: 一次拖动冻结 SVG 投影；地图范围会随视口变化，逐帧重算会放大位移。
  pointer = { pointerId: event.pointerId, element, matrix, client: { x: event.clientX, y: event.clientY }, point, center, target: center, zoom: flow.viewport.value.zoom, nodeId: nodeElement?.id };
  element.focus({ preventScroll: true });
  element.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function movePointer(event: PointerEvent) {
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  event.preventDefault();
  if (!dragging.value) {
    if (Math.hypot(event.clientX - pointer.client.x, event.clientY - pointer.client.y) < 3) return;
    clearClick();
    props.navigation.rememberView();
    dragging.value = true;
    hoveredLabel.value = "";
  }
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(pointer.matrix);
  pointer.target = { x: pointer.center.x + point.x - pointer.point.x, y: pointer.center.y + point.y - pointer.point.y };
  if (!panFrame) panFrame = requestAnimationFrame(panMap);
}

function panMap() {
  panFrame = 0;
  if (pointer && dragging.value) void props.navigation.centerOn(pointer.target, { remember: false, animate: false, zoom: pointer.zoom });
}

function finishPointer(event: PointerEvent) {
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  movePointer(event);
  if (dragging.value) {
    cancelAnimationFrame(panFrame);
    panMap();
  } else {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(pointer.matrix);
    const nodeId = pointer.nodeId;
    const node = nodeId ? flow.findNode(nodeId) : undefined;
    const zoom = pointer.zoom;
    const doubleClick = pendingClick && pendingClick.nodeId === nodeId && Math.hypot(event.clientX - pendingClick.client.x, event.clientY - pendingClick.client.y) < 6;
    clearClick();
    if (doubleClick && nodeId) void props.navigation.focusNodes([nodeId]);
    else if (!nodeId) void props.navigation.centerOn(point, { zoom });
    else if (node && !node.hidden) {
      const position = { ...node.computedPosition };
      pendingClick = {
        nodeId: node.id,
        client: { x: event.clientX, y: event.clientY },
        timer: setTimeout(() => {
          pendingClick = undefined;
          if (!props.active || flow.findNode(node.id) !== node || node.hidden || node.computedPosition.x !== position.x || node.computedPosition.y !== position.y) return;
          void props.navigation.centerOn(point, { zoom });
        }, 350),
      };
    }
  }
  stopPointer();
}

function stopPointer(event?: PointerEvent) {
  if (event && pointer?.pointerId !== event.pointerId) return;
  const state = pointer;
  pointer = undefined;
  dragging.value = false;
  cancelAnimationFrame(panFrame);
  panFrame = 0;
  if (state?.element.hasPointerCapture(state.pointerId)) state.element.releasePointerCapture(state.pointerId);
}

function zoomMap(event: WheelEvent) {
  if (!props.active || !event.deltaY || pointer) return;
  clearClick();
  if (!wheelTimer) props.navigation.rememberView();
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheelTimer = undefined; }, 200);
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? mapSize.value.height : 1);
  const zoom = flow.viewport.value.zoom * Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.002);
  void props.navigation.centerOn(viewportCenter(), { zoom, remember: false, animate: false });
}

function navigateMap(event: KeyboardEvent) {
  if (!props.active || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  const directions: Record<string, XYPosition> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
  const direction = directions[event.key];
  if (!direction && event.key !== "Enter" && event.key !== "Escape") return;
  event.stopPropagation();
  event.preventDefault();
  releaseNavigation();
  if (event.key === "Escape") return emit("close");
  if (event.key === "Enter") return void props.navigation.showAll();
  if (!direction) return;
  if (!event.repeat) props.navigation.rememberView();
  const center = viewportCenter();
  const distance = (event.shiftKey ? 160 : 64) / flow.viewport.value.zoom;
  void props.navigation.centerOn({ x: center.x + direction.x * distance, y: center.y + direction.y * distance }, { remember: false, animate: false });
}

function releaseNavigation() {
  stopPointer();
  clearClick();
  clearTimeout(wheelTimer);
  wheelTimer = undefined;
}

watch(() => props.active, active => { if (!active) releaseNavigation(); }, { flush: "sync" });
watch(() => [flow.viewport.value.x, flow.viewport.value.y, flow.viewport.value.zoom], clearClick, { flush: "sync" });
watch(mapSize, releaseNavigation);
onBeforeUnmount(releaseNavigation);
</script>

<style lang="scss" scoped>
.canvasMap {
  overflow: hidden;
  box-sizing: content-box;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--ui-radius-large);
  background: var(--el-bg-color-overlay);
  box-shadow: var(--floatingShadow);
  color: var(--el-text-color-primary);

  .mapHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 6px 6px 12px;

    .mapTitle {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
      white-space: nowrap;

      strong { font-size: 12px; font-weight: 600; }
      span { color: var(--el-text-color-secondary); font-size: 11px; }
    }

    .mapActions {
      display: flex;
      gap: 2px;

      .mapButton {
        display: grid;
        place-items: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        border-radius: var(--ui-radius-small);
        background: transparent;
        color: var(--el-text-color-secondary);
        cursor: pointer;

        &:hover { color: var(--el-text-color-primary); background: var(--el-fill-color-light); }
        &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
      }
    }
  }

  .mapViewport {
    touch-action: none;
    user-select: none;
    cursor: crosshair;

    &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
    &.dragging { cursor: grabbing; }

    :deep(.vue-flow__minimap) {
      background: var(--el-fill-color-extra-light);

      svg { display: block; overflow: hidden; }
      .vue-flow__minimap-mask { pointer-events: none; vector-effect: non-scaling-stroke; }
      .vue-flow__minimap-node {
        vector-effect: non-scaling-stroke;
        shape-rendering: geometricPrecision;

        &.mapGroup { fill-opacity: 0.4; }
        &.selected { stroke-width: 2.5px; }
      }
    }
  }

  .mapFooter {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    font-size: 10px;
    color: var(--el-text-color-secondary);

    .mapHint { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mapZoom { flex-shrink: 0; font-variant-numeric: tabular-nums; }
  }
}
</style>
