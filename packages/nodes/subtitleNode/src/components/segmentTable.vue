<template>
  <div class="segmentTable nodrag nopan nowheel">
    <div class="tableScroll">
      <table>
        <thead><tr><th scope="col">编号</th><th scope="col">开始（HH:MM:SS,mmm）</th><th scope="col">结束（HH:MM:SS,mmm）</th><th scope="col">文本</th><th scope="col">操作</th></tr></thead>
        <tbody>
          <tr v-for="(segment, index) in modelValue" :key="index">
            <td>{{ index + 1 }}</td>
            <td><input :value="segment.start" :disabled="disabled" :aria-label="`第 ${index + 1} 段开始时间`" @input="update(index, 'start', $event)" /></td>
            <td><input :value="segment.end" :disabled="disabled" :aria-label="`第 ${index + 1} 段结束时间`" @input="update(index, 'end', $event)" /></td>
            <td><textarea :value="segment.text" :disabled="disabled" :aria-label="`第 ${index + 1} 段文本`" rows="2" @input="update(index, 'text', $event)" /></td>
            <td><button type="button" :disabled="disabled" :aria-label="`删除第 ${index + 1} 段`" @click="emit('update:modelValue', modelValue.filter((_, position) => position !== index))">删除</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <button type="button" :disabled="disabled" @click="emit('update:modelValue', [...modelValue, { start: '', end: '', text: '' }])">新增分段</button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ modelValue: { start: string; end: string; text: string }[]; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: { start: string; end: string; text: string }[]] }>();
function update(index: number, field: "start" | "end" | "text", event: Event) {
  const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  emit("update:modelValue", props.modelValue.map((segment, position) => position === index ? { ...segment, [field]: value } : segment));
}
</script>

<style scoped lang="scss">
.segmentTable {
  .tableScroll {
    max-height: 360px;
    overflow: auto;
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      th, td { padding: 6px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--el-border-color); }
      input, textarea { box-sizing: border-box; padding: 5px; color: var(--el-text-color-primary); background: var(--el-fill-color-blank); border: 1px solid var(--el-border-color); border-radius: 4px; }
      input { width: 130px; }
      textarea { width: 100%; min-width: 160px; resize: vertical; }
    }
  }
  button { padding: 5px 8px; color: var(--el-text-color-primary); background: var(--el-fill-color-blank); border: 1px solid var(--el-border-color); border-radius: 4px; cursor: pointer; }
  > button { margin-top: 10px; }
}
</style>
