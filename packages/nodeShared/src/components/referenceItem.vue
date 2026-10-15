<template>
  <vue-draggable
    v-model="items"
    class="referenceList"
    aria-label="输入引用"
    :animation="180"
    :disabled="disabled"
    direction="horizontal"
    ghostClass="referenceGhost"
    filter=".removeButton"
    :preventOnFilter="false">
    <referenceCard
      v-for="(item, index) in items"
      :key="JSON.stringify([item.source, item.sourceHandle])"
      :item="item"
      :index="index + 1"
      :disabled="disabled"
      tabindex="0"
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      @keydown.alt.left.stop.prevent="moveReference(index, index - 1)"
      @keydown.alt.right.stop.prevent="moveReference(index, index + 1)"
      @preview="(url, originalUrl) => emit('preview', item, url, originalUrl)"
      @remove="emit('remove', item)" />
  </vue-draggable>
</template>

<script setup lang="ts">
import { VueDraggable } from "vue-draggable-plus";
import type { NodeInputValue } from "@toonflow/nodes-scaffold/values";
import referenceCard from "./referenceCard.vue";

const props = defineProps<{ disabled?: boolean }>();
const items = defineModel<NodeInputValue[]>({ required: true });
const emit = defineEmits<{ remove: [item: NodeInputValue]; preview: [item: NodeInputValue, url: string, originalUrl: string] }>();

function moveReference(from: number, index: number) {
  const item = items.value[from];
  if (props.disabled || !item || from === index || index < 0 || index >= items.value.length) return;
  const next = [...items.value];
  next.splice(from, 1);
  next.splice(index, 0, item);
  items.value = next;
}
</script>

<style scoped>
.referenceList {
  display: flex;
  flex: 1;
  gap: 8px;
  min-width: 0;
  min-height: 48px;
  overflow-x: auto;
}
</style>
