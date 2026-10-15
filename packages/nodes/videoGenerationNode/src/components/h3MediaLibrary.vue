<template>
  <el-dialog v-model="visible" title="面板素材库" width="min(760px, 94vw)" alignCenter appendToBody :closeOnClickModal="false" :closeOnPressEscape="!importing" :showClose="!importing" @open="load()" @closed="reset">
    <div class="mediaLibrary">
      <div class="libraryTools">
        <el-segmented v-model="source" :disabled="loading || importing" :options="[{ label: '面板输入', value: 'input' }, { label: '历史输出', value: 'output' }]" aria-label="面板素材来源" @change="offset = 0; selected = []; load()" />
        <el-input v-model="search" :disabled="importing" clearable placeholder="搜索文件名" aria-label="面板素材搜索" @keyup.enter="offset = 0; load()" />
        <el-button :loading="loading" :disabled="importing" @click="offset = 0; load()">搜索 / 刷新</el-button>
      </div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <div class="assetGrid">
        <div v-for="item in items" :key="item.path" class="assetCard" :class="{ selected: selected.some(value => value.path === item.path) }">
          <el-checkbox :modelValue="selected.some(value => value.path === item.path)" :disabled="importing" :aria-label="`选择 ${item.name}`" @change="toggle(item)">{{ item.mimeType.split('/')[0] === 'image' ? '图片' : item.mimeType.startsWith('video/') ? '视频' : '音频' }}</el-checkbox>
          <span class="assetName" :title="item.name">{{ item.name }}</span>
          <span class="assetSize">{{ (item.size / 1024 / 1024).toFixed(1) }} MiB</span>
          <el-button text size="small" :disabled="importing" @click="preview = item">预览</el-button>
        </div>
      </div>
      <p v-if="!loading && !items.length && !error">没有找到可导入的素材。</p>
      <div class="libraryPagination"><el-button :disabled="loading || importing || offset === 0" @click="offset -= 12; load()">上一页</el-button><span>{{ Math.floor(offset / 12) + 1 }} / {{ Math.max(1, Math.ceil(total / 12)) }} 页 · {{ total }} 项</span><el-button :disabled="loading || importing || offset + 12 >= total" @click="offset += 12; load()">下一页</el-button></div>
    </div>
    <template #footer><el-button :disabled="importing" @click="visible = false">取消</el-button><el-button type="primary" :loading="importing" :disabled="!selected.length" @click="importSelected">导入已选 {{ selected.length }} 项</el-button></template>
  </el-dialog>
  <el-dialog :modelValue="!!preview" :title="preview?.name" width="min(900px, 94vw)" appendToBody destroyOnClose @close="preview = undefined">
    <div v-if="preview" class="assetPreview"><img v-if="preview.mimeType.startsWith('image/')" :src="zealmanAssetUrl(source, preview.path)" :alt="preview.name" /><video v-else-if="preview.mimeType.startsWith('video/')" :src="zealmanAssetUrl(source, preview.path)" controls preload="metadata" /><audio v-else :src="zealmanAssetUrl(source, preview.path)" controls preload="metadata" /></div>
  </el-dialog>
</template>

<script setup lang="ts">
import { onScopeDispose, ref } from "vue";
import { ElAlert, ElButton, ElCheckbox, ElDialog, ElInput, ElSegmented } from "element-plus";
import { zealmanAssetUrl, type ZealmanAsset } from "../zealmanOptions";

const props = defineProps<{ importReferences: (source: "input" | "output", items: ZealmanAsset[], signal: AbortSignal) => Promise<void> }>();
const visible = defineModel<boolean>({ required: true });
const source = ref<"input" | "output">("input");
const items = ref<ZealmanAsset[]>([]);
const selected = ref<ZealmanAsset[]>([]);
const preview = ref<ZealmanAsset>();
const offset = ref(0);
const total = ref(0);
const search = ref("");
const error = ref("");
const loading = ref(false);
const importing = ref(false);
let controller: AbortController | undefined;

async function load() {
  controller?.abort();
  const current = controller = new AbortController();
  loading.value = true;
  error.value = "";
  try {
    const query = new URLSearchParams({ providerId: "zealmanH3", modelId: "u06", source: source.value, offset: String(offset.value), search: search.value });
    const response = await fetch(`/api/ai/media/references?${query}`, { signal: current.signal });
    const result = await response.json();
    if (!response.ok || result.code !== 200) throw new Error(result.message || "面板素材读取失败");
    current.signal.throwIfAborted();
    items.value = result.data.items;
    total.value = result.data.total;
  } catch (cause) { if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : "面板素材读取失败"; }
  finally { if (controller === current) loading.value = false; }
}
function toggle(item: ZealmanAsset) {
  if (selected.value.some(value => value.path === item.path)) selected.value = selected.value.filter(value => value.path !== item.path);
  else if (selected.value.length < 15) selected.value.push(item);
  else error.value = "一次最多选择 15 项，图片、视频和音频数量还须符合模型上限";
}
async function importSelected() {
  controller?.abort();
  const current = controller = new AbortController();
  importing.value = true;
  error.value = "";
  try { await props.importReferences(source.value, [...selected.value], current.signal); visible.value = false; }
  catch (cause) { if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : "导入失败，已导入的素材保留在节点中"; }
  finally { importing.value = false; }
}
function reset() { controller?.abort(); selected.value = []; preview.value = undefined; }
onScopeDispose(() => controller?.abort());
</script>

<style scoped lang="scss">
.mediaLibrary {
  display: grid; gap: 14px; max-height: 65vh; overflow: auto;
  .libraryTools { display: flex; gap: 8px; flex-wrap: wrap; :deep(.el-input) { flex: 1; min-width: 160px; } }
  .assetGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px;
    .assetCard { display: grid; gap: 5px; padding: 10px; border: 1px solid var(--el-border-color-light); border-radius: 8px; min-width: 0;
      &.selected { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
      .assetName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .assetSize { color: var(--el-text-color-secondary); font-size: 12px; }
    }
  }
  .libraryPagination { display: flex; align-items: center; justify-content: center; gap: 12px; }
}
.assetPreview { display: grid; place-items: center; img, video { max-width: 100%; max-height: 70vh; } audio { width: 100%; } }
</style>
