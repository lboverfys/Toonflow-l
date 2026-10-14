<template>
  <el-dialog v-model="visible" :title="plugin.displayName" width="min(800px, calc(100vw - 32px))" alignCenter appendToBody destroyOnClose>
    <div class="pluginContent" tabindex="0" aria-label="插件说明">
      <messageMarkdown :content="plugin.readme ?? ''" />
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import messageMarkdown from "@/components/messageMarkdown.vue";
import type { Plugin } from "./types";

defineProps<{ plugin: Plugin }>();
const visible = defineModel<boolean>({ default: false });
</script>

<style lang="scss" scoped>
.pluginContent {
  max-height: min(65vh, calc(100dvh - 160px));
  overflow: auto;
  overflow-wrap: anywhere;
  padding: 0 4px;
  font-size: 14px;
  line-height: 1.7;
}
</style>
