<template>
  <div v-if="timing" class="generationTiming" :title="`${formatDate(timing.startedAt)}${timing.endedAt ? ` → ${formatDate(timing.endedAt)}` : ''}`">
    <span><span class="timeLabel">开始</span><time :datetime="new Date(timing.startedAt).toISOString()">{{ formatTime(timing.startedAt) }}</time></span>
    <span><span class="timeLabel">结束</span><time v-if="timing.endedAt" :datetime="new Date(timing.endedAt).toISOString()">{{ formatTime(timing.endedAt) }}</time><span v-else>{{ running ? '生成中' : '待确认' }}</span></span>
    <span v-if="timing.endedAt || running" class="elapsed">{{ running ? '已用' : timing.status === 'failed' ? '失败前用时' : '耗时' }} {{ elapsed }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import type { GenerationTiming } from "../useNodeGeneration";

const props = defineProps<{ timing?: GenerationTiming; running: boolean }>();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
watch(() => props.running, running => {
  clearInterval(timer);
  now.value = Date.now();
  if (running) timer = setInterval(() => { now.value = Date.now(); }, 1000);
}, { immediate: true });
onScopeDispose(() => clearInterval(timer));
const elapsed = computed(() => {
  const seconds = Math.max(0, Math.round(((props.timing?.endedAt ?? now.value) - (props.timing?.startedAt ?? now.value)) / 1000));
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
});
const formatTime = (value: number) => new Date(value).toLocaleTimeString([], { hour12: false });
const formatDate = (value: number) => new Date(value).toLocaleString([], { hour12: false });
</script>

<style scoped lang="scss">
.generationTiming {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding-top: 10px;
  margin-top: 10px;
  border-top: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-regular);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  > span { display: inline-flex; gap: 6px; }
  .timeLabel { color: var(--el-text-color-secondary); }
  .elapsed { margin-left: auto; color: var(--el-color-primary); }
}
</style>
