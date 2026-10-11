<template>
  <simple-bezier-edge v-if="visible" v-bind="props" />
</template>

<script setup lang="ts">
import { computed, inject, type Ref } from "vue";
import { SimpleBezierEdge, useVueFlow, type EdgeProps } from "@vue-flow/core";

defineOptions({ inheritAttrs: false });
const props = defineProps<EdgeProps>();
const { viewport, dimensions } = useVueFlow();
const canvasActive = inject<Ref<boolean>>("canvasActive");
const showEdges = inject<Ref<boolean>>("canvasShowEdges");
const visible = computed(() => {
  if (canvasActive?.value === false) return false;
  const nodeActive = props.sourceNode.selected || props.sourceNode.dragging || props.targetNode.selected || props.targetNode.dragging;
  if (showEdges?.value === false && !nodeActive) return false;
  const { x, y, zoom } = viewport.value;
  const margin = Math.max(80, (props.interactionWidth ?? 40) * zoom);
  // ACT: simple-bezier 的控制点位于端点包围盒内；连线穿过视口时保留，即使两个节点都在屏幕外。
  return Math.max(props.sourceX, props.targetX) * zoom + x >= -margin
    && Math.min(props.sourceX, props.targetX) * zoom + x <= dimensions.value.width + margin
    && Math.max(props.sourceY, props.targetY) * zoom + y >= -margin
    && Math.min(props.sourceY, props.targetY) * zoom + y <= dimensions.value.height + margin;
});
</script>
