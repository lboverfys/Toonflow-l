<template>
  <div ref="listElement" class="h3ReferenceList" aria-label="生成参考素材">
    <div v-for="item in orderedReferences" :key="item.id" class="referenceEntry" :class="{ dragTarget: dragTarget === item.id, selectedReference: activeId === item.id }" :data-category="item.category" :data-reference-id="item.id"
      :draggable="!disabled && swapTargets(item).length > 0" @dragstart="startDrag($event, item)" @dragover="overReference($event, item)" @dragleave="dragTarget = ''" @drop="dropReference($event, item)" @dragend="dragged = undefined; dragTarget = ''">
      <referenceCard v-if="item.input && !h3ReferenceGroup(item).endsWith(':url')" class="referencePreview" :item="item.input" :index="Number(item.value.match(/\d+/)?.[0]) || 1" :label="item.name" :disabled="disabled"
        @preview="(url, original) => emit('preview', item, url, original)" @remove="emit('remove', item)" />
      <button v-else-if="item.input?.dataType === 'IMAGE'" type="button" class="remotePreview" :aria-label="`预览${item.name}`" @click="emit('inspect', item)"><img :src="item.input.value?.url" alt="" draggable="false" /><span>{{ item.name }}</span></button>
      <button v-else type="button" class="voicePreview" :aria-label="`试听${item.name}`" @click="emit('inspect', item)"><icon-music :size="24" /><span>{{ item.name }}</span></button>
      <el-select v-if="['picture', 'video'].includes(item.category)" class="subjectName" :modelValue="subjects.find(subject => subject.references.includes(item.id))?.name ?? ''"
        filterable allowCreate defaultFirstOption clearable size="small" :disabled="disabled" :aria-label="`${item.name}主体名称`" placeholder="给主体取名"
        @pointerdown.stop @mousedown.stop @dragstart.stop.prevent @update:modelValue="emit('assignSubject', item.id, String($event || ''))">
        <el-option v-for="subject in subjects" :key="subject.id" :value="subject.name" :label="subject.name" />
      </el-select>
      <div class="referenceActions" @pointerdown.stop @mousedown.stop @dragstart.stop.prevent>
        <el-button v-if="item.category !== 'text'" text size="small" :aria-label="`预览${item.name}`" @click="emit('inspect', item)">预览</el-button>
        <el-dropdown trigger="click" :disabled="disabled" @command="handleCommand(item, $event)">
          <el-button text size="small" :disabled="disabled" :aria-label="`${item.name}素材操作`">{{ swapTargets(item).length ? '换位置' : '更多' }}<icon-chevron-down :size="12" /></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="target in swapTargets(item)" :key="target.id" :command="target.id">与 {{ target.name }}{{ subjectLabel(target) }} 交换</el-dropdown-item>
              <el-dropdown-item v-if="item.input && item.category !== 'text'" command="replace" :divided="swapTargets(item).length > 0">更换文件</el-dropdown-item>
              <el-dropdown-item command="remove">移除素材</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElOption, ElSelect } from "element-plus";
import { IconChevronDown, IconMusic } from "@tabler/icons-vue";
import referenceCard from "@toonflow/node-shared/referenceCard";
import { h3ReferenceGroup, type H3Reference, type H3Subject } from "../h3Prompt";

const props = defineProps<{ references: H3Reference[]; subjects: H3Subject[]; disabled?: boolean; activeId?: string }>();
const emit = defineEmits<{
  swap: [first: H3Reference, second: H3Reference]; remove: [item: H3Reference]; replace: [item: H3Reference]; inspect: [item: H3Reference];
  preview: [item: H3Reference, url: string, original: string]; assignSubject: [id: string, name: string];
}>();
const orderedReferences = computed(() => ["picture", "video", "audio", "text"].flatMap(category => props.references.filter(item => item.category === category)));
const dragged = ref<H3Reference>();
const dragTarget = ref("");
const listElement = ref<HTMLElement>();

function swapTargets(item: H3Reference) { return item.category === "text" ? [] : props.references.filter(target => target.id !== item.id && h3ReferenceGroup(target) === h3ReferenceGroup(item)); }
function subjectLabel(item: H3Reference) {
  const name = props.subjects.find(subject => subject.references.includes(item.id))?.name;
  return name ? `（${name}）` : "";
}
function handleCommand(item: H3Reference, command: string) {
  if (props.disabled) return;
  if (command === "replace") return emit("replace", item);
  if (command === "remove") return emit("remove", item);
  const target = swapTargets(item).find(target => target.id === command);
  if (target) emit("swap", item, target);
}
function startDrag(event: DragEvent, item: H3Reference) {
  if (props.disabled || !swapTargets(item).length || (event.target as Element).closest("button, input, .subjectName")) return event.preventDefault();
  dragged.value = item;
  if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.name); }
}
function overReference(event: DragEvent, item: H3Reference) {
  if (props.disabled || !dragged.value || !swapTargets(dragged.value).some(target => target.id === item.id)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dragTarget.value = item.id;
}
function dropReference(event: DragEvent, item: H3Reference) {
  event.preventDefault();
  event.stopPropagation();
  const first = dragged.value;
  dragged.value = undefined;
  dragTarget.value = "";
  if (!props.disabled && first && swapTargets(first).some(target => target.id === item.id)) emit("swap", first, item);
}
watch(() => props.disabled, () => { dragged.value = undefined; dragTarget.value = ""; });
watch(() => props.activeId, async () => {
  await nextTick();
  const entry = Array.from(listElement.value?.children ?? []).find(child => (child as HTMLElement).dataset.referenceId === props.activeId);
  entry?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
});
</script>

<style scoped lang="scss">
.h3ReferenceList {
  display: flex; gap: 8px; overflow-x: auto; padding: 3px; min-width: 0;
  .referenceEntry {
    --referenceColor: #2563eb;
    display: flex; flex: 0 0 126px; flex-direction: column; gap: 6px; min-width: 0; padding: 6px;
    border: 1px solid var(--el-border-color-light); border-top: 3px solid var(--referenceColor); border-radius: 10px;
    background: var(--el-bg-color); cursor: grab;
    &[data-category="picture"] { --referenceColor: #8b5cf6; }
    &[data-category="audio"] { --referenceColor: #d97706; }
    &.dragTarget, &.selectedReference { outline: 2px solid var(--referenceColor); outline-offset: 1px; }
    &.dragTarget { background: var(--el-fill-color-light); }
    .referencePreview { width: 100%; height: 76px; border: 0; :deep(.indexBadge) { font-size: 11px; line-height: 18px; padding: 0 5px; color: var(--referenceColor); } }
    .remotePreview { position: relative; width: 100%; height: 76px; padding: 0; border: 0; border-radius: 6px; overflow: hidden; cursor: pointer; background: var(--el-fill-color-light); img { width: 100%; height: 100%; object-fit: cover; } span { position: absolute; left: 2px; top: 2px; padding: 1px 5px; border-radius: 3px; color: var(--referenceColor); background: var(--el-bg-color-overlay); font-size: 11px; } }
    .voicePreview { display: grid; place-items: center; gap: 4px; width: 100%; height: 76px; padding: 6px; border: 0; border-radius: 6px; color: var(--referenceColor); background: var(--el-fill-color-light); cursor: pointer; span { font-size: 11px; overflow-wrap: anywhere; } }
    .subjectName { width: 100%; }
    .referenceActions { display: flex; justify-content: space-between; margin-top: auto; :deep(.el-button) { padding: 3px 4px; margin: 0; font-size: 11px; } }
  }
}
</style>
