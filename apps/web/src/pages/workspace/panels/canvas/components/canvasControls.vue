<template>
  <mini-map
    v-if="showMap"
    position="bottom-left"
    :style="{ bottom: '64px' }"
    :pannable="true"
    :zoomable="true"
    node-color="var(--el-fill-color-dark)"
    mask-color="var(--el-mask-color-extra-light)" />
  <panel position="bottom-left">
    <elCard shadow="never" :body-style="{ padding: '4px' }">
      <div class="canvasControls">
        <el-tooltip :showArrow="false" :content="assetsVisible ? '关闭素材库' : '打开素材库'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="assetsVisible ? 'primary' : 'default'"
            :aria-pressed="assetsVisible"
            aria-label="素材库"
            @click="assetsVisible = !assetsVisible">
            <icon-folders :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" content="整理画布" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="toolButton" text :disabled="!canArrange" aria-label="整理画布" @click="arrangeNodes">
            <icon-sitemap :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="showMap ? '隐藏地图' : '显示地图'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="showMap ? 'primary' : 'default'"
            :aria-pressed="showMap"
            aria-label="显示或隐藏地图"
            @click="showMap = !showMap">
            <icon-map :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="snapEnabled ? '关闭网格吸附' : '开启网格吸附'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="snapEnabled ? 'primary' : 'default'"
            :aria-pressed="snapEnabled"
            aria-label="网格吸附"
            @click="snapEnabled = !snapEnabled">
            <icon-magnet :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="showEdges ? '隐藏连线' : '显示连线'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="showEdges ? 'primary' : 'default'"
            :aria-pressed="showEdges"
            aria-label="显示或隐藏连线"
            @click="showEdges = !showEdges">
            <icon-arrow-guide :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" content="适应视图" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="toolButton" text aria-label="适应视图" @click="fitView()">
            <icon-focus-centered :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false"
          content="缩放菜单（滚轮调整缩放）"
          placement="top"
          :hideAfter="0"
          :enterable="false"
          :triggerKeys="[]"
          :disabled="zoomMenuVisible">
          <span class="toolTrigger">
            <el-popover v-model:visible="zoomMenuVisible" trigger="click" placement="top-start" :width="216">
              <template #reference>
                <el-button
                  class="toolButton"
                  text
                  aria-label="缩放菜单"
                  @wheel.stop.prevent="$event.deltaY && applyZoom(Math.min(800, Math.max(2, zoomPercent - Math.sign($event.deltaY))))">
                  {{ zoomPercent }}%
                </el-button>
              </template>
              <div class="zoomMenu">
                <el-input-number
                  class="zoomInput"
                  :modelValue="zoomPercent"
                  :min="2"
                  :max="800"
                  :controls="false"
                  aria-label="缩放百分比"
                  @change="applyZoom">
                  <template #suffix>%</template>
                </el-input-number>
                <el-button class="zoomAction" text @click="zoomIn()">放大</el-button>
                <el-button class="zoomAction" text @click="zoomOut()">缩小</el-button>
                <el-button class="zoomAction" text @click="fitView()">适合屏幕</el-button>
              </div>
            </el-popover>
          </span>
        </el-tooltip>
        <el-tooltip :showArrow="false" content="帮助" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]" :disabled="helpVisible">
          <span class="toolTrigger">
            <el-popover v-model:visible="helpVisible" trigger="click" placement="top-end" :width="196">
              <template #reference>
                <el-button class="toolButton" text aria-label="帮助">
                  <icon-help :size="17" />
                </el-button>
              </template>
              <div class="helpMenu">
                <el-button
                  class="helpAction"
                  tag="a"
                  text
                  :icon="IconBook"
                  href="https://qcn7xdsqgc4z.feishu.cn/docx/RXFqdgR2Xo0dXZxGfd0cZCGgnwf"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click="helpVisible = false">
                  使用教程
                </el-button>
                <el-button
                  class="helpAction"
                  tag="a"
                  text
                  :icon="IconBug"
                  href="https://docs.qq.com/smartsheet/form/EmvmQBrmlPmr%2Fss_vsqk2v%2FvhiGzE?tab=ss_vsqk2v"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Toonflow 需求/BUG反馈表"
                  @click="helpVisible = false">
                  汇报 BUG
                </el-button>
                <el-button class="helpAction" text :icon="IconBrandWechat" @click="showContact('community')">加入交流群</el-button>
                <el-button class="helpAction" text :icon="IconBriefcase" @click="showContact('business')">商务合作</el-button>
              </div>
            </el-popover>
          </span>
        </el-tooltip>
      </div>
    </elCard>
  </panel>
  <arrangeDialog ref="arrangeDialogRef" :active="active" :canvasId="canvasId" :directory="directory" :projectName="projectName" :batchHistory="batchHistory" />
  <el-dialog v-model="contactVisible" :title="contactInfo.title" width="min(360px, calc(100vw - 32px))" alignCenter appendToBody>
    <div class="contactContent">
      <q-r-code
        :value="contactInfo.url"
        :size="192"
        type="svg"
        color="#000000"
        bgColor="#ffffff"
        borderless
        role="img"
        :aria-label="`${contactInfo.title}二维码`" />
      <p class="contactTip">{{ contactInfo.tip }}</p>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Panel, useVueFlow } from "@vue-flow/core";
import { MiniMap } from "@vue-flow/minimap";
import { IconMap, IconMagnet, IconFocusCentered, IconHelp, IconBook, IconBug, IconBrandWechat, IconBriefcase } from "@tabler/icons-vue";
import { ElMessage } from "element-plus";
import { QRCode } from "tdesign-vue-next";
import arrangeDialog from "./arrangeDialog.vue";

const props = defineProps<{
  active: boolean;
  canvasId: string;
  directory: string | undefined;
  projectName: string;
  batchHistory: (action: () => Promise<void>) => Promise<void>;
}>();
const snapEnabled = defineModel<boolean>("snapEnabled", { required: true });
const showEdges = defineModel<boolean>("showEdges", { required: true });
const assetsVisible = defineModel<boolean>("assetsVisible", { default: false });
const showMap = ref(false);
const zoomMenuVisible = ref(false);
const helpVisible = ref(false);
const contactVisible = ref(false);
const contactType = ref<"community" | "business">("community");
const contacts = {
  community: {
    title: "加入交流群",
    url: "https://work.weixin.qq.com/u/vc36adcc89845edcbe?v=5.0.3.63936&bb=85b8d228e8",
    tip: "Toonflow 是为爱发电的开源项目。欢迎文明交流、友善反馈；回复可能需要一些时间，请避免责问或命令式沟通，感谢你的理解与尊重。",
  },
  business: {
    title: "商务合作",
    url: "https://work.weixin.qq.com/u/vc0f54596c5837d05a?v=5.0.8.70675",
    tip: "此联系方式仅用于商务合作接洽，不提供问题答疑。使用问题欢迎在交流群交流，需求与 BUG 可通过反馈表提交。感谢理解。",
  },
};
const contactInfo = computed(() => contacts[contactType.value]);
const flow = useVueFlow();
const { viewport, zoomTo, zoomIn, zoomOut, fitView, getNodes } = flow;
const zoomPercent = computed(() => Math.round(viewport.value.zoom * 100));
const arrangeDialogRef = ref<InstanceType<typeof arrangeDialog>>();
const canArrange = computed(() => {
  const nodes = getNodes.value.filter((node) => node.type !== "canvasGroup");
  return (
    props.active &&
    !!props.canvasId &&
    !!props.directory &&
    !arrangeDialogRef.value?.visible &&
    nodes.length > 0 &&
    nodes.every((node) => node.dimensions.width > 0 && node.dimensions.height > 0)
  );
});
defineExpose({ arrangeNodes, requestArrange });

function showContact(type: "community" | "business") {
  contactType.value = type;
  helpVisible.value = false;
  contactVisible.value = true;
}

function applyZoom(value: number | undefined) {
  if (value !== undefined && Number.isFinite(value)) void zoomTo(value / 100);
}

async function arrangeNodes() {
  if (!canArrange.value) return;
  try {
    await requestArrange();
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) ElMessage.error(error instanceof Error ? error.message : "整理画布失败");
  }
}

async function requestArrange(signal?: AbortSignal) {
  if (!canArrange.value || !arrangeDialogRef.value) throw new Error("画布尚未就绪或正在整理");
  return arrangeDialogRef.value.open(signal);
}
</script>

<style lang="scss" scoped>
.canvasControls {
  display: flex;
  align-items: center;
  gap: 6px;

  .toolTrigger {
    display: inline-flex;
  }

  .toolButton {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    margin-left: 0;
    padding: 0;
  }
}

.zoomMenu {
  display: flex;
  flex-direction: column;

  .zoomInput {
    width: 100%;
  }

  .zoomAction {
    justify-content: flex-start;
    margin-left: 0;
  }
}

.helpMenu {
  display: flex;
  flex-direction: column;
  gap: 4px;

  .helpAction {
    justify-content: flex-start;
    margin-left: 0;
  }
}

.contactContent {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;

  .contactTip {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.7;
  }
}
</style>
