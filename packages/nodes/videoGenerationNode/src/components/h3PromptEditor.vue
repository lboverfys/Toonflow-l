<template>
  <section class="h3PromptEditor nodrag nopan nowheel" aria-label="H3 提示词创作" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.capture="handleHistoryKey" @keydown.stop @wheel.stop>
    <div class="promptTools">
      <el-button type="primary" size="small" :icon="IconSparkles" :loading="optimizing" :disabled="disabled || !prompt.trim() || !selectedModel" @click="optimize">Skill 优化提示词</el-button>
      <el-button v-if="optimizing" size="small" @click="optimizationController?.abort()">停止优化</el-button>
      <el-popover trigger="click" placement="bottom-start" :width="300">
        <template #reference><el-button size="small" :icon="IconSettings" aria-label="提示词优化设置" /></template>
        <div class="optimizerSettings">
          <label>优化使用的文本模型</label>
          <el-select v-model="state.model" filterable :loading="modelsLoading" :disabled="optimizing" aria-label="提示词优化模型" @visibleChange="(opened: boolean) => opened && loadModels()">
            <el-option v-for="item in models" :key="JSON.stringify([item.providerId, item.modelId])" :value="JSON.stringify([item.providerId, item.modelId])" :label="`${item.providerLabel} / ${item.label}`" />
          </el-select>
          <span>沿用 Toonflow 中配置的文本模型；参考图分析需要模型支持看图。</span>
          <el-button text size="small" @click="skillVisible = true">查看内置 Skill 原文</el-button>
        </div>
      </el-popover>
      <el-button size="small" :disabled="editingDisabled" @click="openDialogue()">插入对白</el-button>
      <el-button size="small" :disabled="editingDisabled" @click="insertSkeleton">插入骨架</el-button>
      <el-button size="small" :disabled="editingDisabled" @click="emit('upload')">上传素材</el-button>
      <el-button v-if="remoteLibrary" size="small" :disabled="editingDisabled" @click="emit('openLibrary')">面板素材库</el-button>
      <el-button size="small" :disabled="editingDisabled || !references.length" @click="emit('clearReferences')">清空素材</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-collapse class="referenceSettings">
      <el-collapse-item title="主体与音色" name="subjects">
        <div v-for="item in references.filter(item => ['picture', 'video'].includes(item.category))" :key="item.id" class="subjectRow">
          <span>{{ item.name }}</span>
          <el-select :modelValue="state.subjects.find(subject => subject.references.includes(item.id))?.name ?? ''" filterable allowCreate defaultFirstOption clearable :disabled="editingDisabled" :aria-label="`${item.name}主体名称`" placeholder="输入主体名称，相同名称合并为同一主体" @update:modelValue="value => assignSubject(item.id, String(value || ''))">
            <el-option v-for="subject in state.subjects" :key="subject.id" :value="subject.name" :label="subject.name" />
          </el-select>
          <el-button text size="small" @click="previewReference = item">预览</el-button>
          <el-button text size="small" :disabled="editingDisabled" @click="emit('replaceReference', item)">替换</el-button>
        </div>
        <div v-if="voices" class="voiceLibrary">
          <span>内置音色（与上传音频合计最多 3 段）</span>
          <el-select v-model="state.voices" multiple filterable :disabled="editingDisabled" aria-label="H3 内置音色" placeholder="选择面板内置音色">
            <el-option v-for="voice in voices" :key="voice.path" :value="voice.path" :label="`${voice.gender === 'female' ? '女声' : '男声'} · ${voice.label}`" :disabled="!state.voices.includes(voice.path) && references.filter(item => item.category === 'audio').length >= 3" />
          </el-select>
        </div>
        <div v-for="item in references.filter(item => item.category === 'audio')" :key="item.id" class="audioBinding">
          <div class="bindingRow">
            <span>{{ item.name }}</span>
            <el-select :modelValue="state.audioBindings[item.id]?.subject" clearable :disabled="editingDisabled" :aria-label="`${item.name}绑定主体`" placeholder="不绑定主体" @update:modelValue="value => bindAudio(item.id, value ? Number(value) : undefined)">
              <el-option v-for="subject in state.subjects" :key="subject.id" :value="subject.id" :label="subject.name" />
            </el-select>
            <el-button text size="small" @click="previewReference = item">试听</el-button>
            <el-button v-if="item.input" text size="small" :disabled="editingDisabled" @click="emit('replaceReference', item)">替换</el-button>
          </div>
          <div v-if="state.audioBindings[item.id]" class="bindingDetails">
            <el-input-number :modelValue="state.audioBindings[item.id]!.speaker" :min="1" :max="99" :disabled="editingDisabled" :aria-label="`${item.name}说话人编号`" @update:modelValue="value => changeSpeaker(item.id, value)" />
            <el-input v-model="state.audioBindings[item.id]!.description" :disabled="editingDisabled" :aria-label="`${item.name}英文音色特征`" placeholder="英文音色特征（可选）" @change="syncDefinitions()" />
          </div>
        </div>
        <p class="helpText">相同主体可以绑定多张图或视频；音频绑定会生成音色参考句。移除最后一份素材后，主体和关联音色绑定会从候选中移除；正文保留失效标记，方便修正。</p>
      </el-collapse-item>
    </el-collapse>
    <div class="editorHeader">
      <span>输入 @ 选择素材、主体、说话人、对白、镜头和任务类型</span>
      <el-segmented v-model="state.editorMode" :options="[{ label: '标签', value: 'tags' }, { label: '代码', value: 'code' }]" :disabled="editingDisabled" size="small" aria-label="提示词编辑模式" />
    </div>
    <promptInput v-if="state.editorMode !== 'code'" ref="editor" v-model="promptModel" v-model:text="prompt" :references="mentions" :referenceGroups="referenceGroups" :disabled="editingDisabled" recognizeTokens preserveMissingReferences expandable placeholder="描述画面，输入 @ 插入素材、主体、对白或镜头" @activateReference="activateMention" @insertReference="insertMention" />
    <el-input v-else v-model="prompt" class="codeEditor" type="textarea" :autosize="{ minRows: 10, maxRows: 24 }" :disabled="editingDisabled" aria-label="H3 提示词代码" @input="syncCodeModel" />
    <div class="editorActions">
      <el-button text size="small" :disabled="editingDisabled || historyIndex === 0" @click="restoreHistory(-1)">撤销</el-button>
      <el-button text size="small" :disabled="editingDisabled || historyIndex >= history.length - 1" @click="restoreHistory(1)">重做</el-button>
      <span class="characterCount">{{ prompt.length }} 字符</span>
      <el-button text size="small" :disabled="!prompt" @click="copyPrompt">复制</el-button>
      <el-button text size="small" :disabled="editingDisabled || !prompt" @click="replacePrompt('')">清空</el-button>
      <el-button text size="small" @click="helpVisible = true">对白写法</el-button>
    </div>
    <div v-if="issues.length" class="promptIssues" role="status"><p v-for="issue in issues" :key="issue">{{ issue }}</p></div>
    <el-dialog v-model="dialogueVisible" title="插入对白" width="min(560px, 92vw)" appendToBody :closeOnClickModal="false">
      <el-form labelPosition="top" class="dialogueForm">
        <el-form-item label="发声主体（多选为齐声）"><el-select v-model="dialogue.subjects" multiple aria-label="对白主体"><el-option v-for="subject in state.subjects" :key="subject.id" :value="subject.id" :label="subject.name" /></el-select></el-form-item>
        <el-form-item label="发声方式"><el-select v-model="dialogue.delivery" aria-label="对白发声方式"><el-option v-for="item in deliveries" :key="item.value" :value="item.value" :label="item.label" /><el-option v-if="!deliveries.some(item => item.value === dialogue.delivery)" :value="dialogue.delivery" :label="dialogue.delivery" /></el-select></el-form-item>
        <div class="dialogueRow">
          <el-form-item label="语言"><el-select v-model="dialogue.language" aria-label="对白语言"><el-option v-for="item in h3Languages" :key="item.value" :value="item.value" :label="item.label" /></el-select></el-form-item>
          <el-form-item label="旁白说话人编号"><el-input-number v-model="dialogue.speaker" :min="1" :max="99" :disabled="!!dialogue.subjects.length" aria-label="旁白说话人编号" /></el-form-item>
        </div>
        <el-form-item label="台词"><el-input v-model="dialogue.text" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" aria-label="对白台词" /></el-form-item>
        <div class="dialogueRow"><el-checkbox v-model="dialogue.sceneTransition">台词跨镜衔接</el-checkbox><el-checkbox v-model="dialogue.cutoff">结尾截断</el-checkbox></div>
      </el-form>
      <template #footer><el-button @click="dialogueVisible = false">取消</el-button><el-button type="primary" :disabled="!dialogue.text.trim()" @click="applyDialogue">{{ editingDialogue ? '更新对白' : '插入对白' }}</el-button></template>
    </el-dialog>
    <el-dialog v-model="skillVisible" title="内置 H3 Skill 原文" width="min(960px, 94vw)" appendToBody><el-input :modelValue="h3PromptSkill" type="textarea" :rows="22" readonly aria-label="内置 H3 Skill 原文" /></el-dialog>
    <el-dialog v-model="helpVisible" title="主体与对白写法" width="min(620px, 92vw)" appendToBody>
      <ol class="dialogueHelp"><li>在“主体与音色”中给图片或视频命名，同一个人物的多个素材使用同一名称。</li><li>在提示词中输入 @，可以插入主体、素材、说话人、镜头和任务类型。</li><li>点击“插入对白”，选择主体、语言和发声方式；多选主体生成齐声编号，例如 (S1,S2)。</li><li>音频可绑定主体和说话人；内置音色和上传音频一起按音频顺序编号。</li><li>画面内对白默认开口说话；只有明确选择旁白或内心独白时才使用画外音写法。</li><li>“代码”展示实际 H3 标签；“复制”复制完整提交文本。“撤销”可恢复优化前的内容。</li></ol>
    </el-dialog>
    <el-dialog :modelValue="!!previewReference" :title="previewReference?.name" width="min(760px, 92vw)" appendToBody destroyOnClose @close="previewReference = undefined">
      <el-alert v-if="previewError" :title="previewError" type="error" :closable="false" />
      <div v-else-if="previewSource" class="referencePreview"><img v-if="previewReference?.category === 'picture'" :src="previewSource" :alt="previewReference.name" /><video v-else-if="previewReference?.category === 'video'" :src="previewSource" controls preload="metadata" /><audio v-else :src="previewSource" controls preload="metadata" aria-label="参考音频试听" /></div>
    </el-dialog>
    <el-dialog v-model="resultVisible" title="优化结果（原内容已保留）" width="min(900px, 94vw)" appendToBody><p>优化期间内容或素材发生了变化，请对照后取用，避免覆盖正在编辑的内容。</p><el-input :modelValue="pendingResult" type="textarea" :rows="18" readonly aria-label="未应用的优化结果" /></el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onScopeDispose, reactive, ref, watch } from "vue";
import { ElAlert, ElButton, ElCheckbox, ElCollapse, ElCollapseItem, ElDialog, ElForm, ElFormItem, ElInput, ElInputNumber, ElMessage, ElOption, ElPopover, ElSegmented, ElSelect } from "element-plus";
import { IconSettings, IconSparkles } from "@tabler/icons-vue";
import { type useNode, type NodeAiModel } from "@toonflow/nodes-scaffold/runtime";
import promptInput from "@toonflow/node-shared/promptInput";
import h3PromptSkill from "../h3PromptSkill.txt?raw";
import { h3GenerationPrompt, h3Languages, h3PromptIssues, h3PromptSubjects, h3Sections, h3Skeleton, parseH3Optimization, type H3PromptState, type H3Reference } from "../h3Prompt";
import type { ZealmanVoice } from "../zealmanOptions";

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const props = defineProps<{ references: H3Reference[]; ai: ReturnType<typeof useNode>["ai"]; files: ReturnType<typeof useNode>["files"]; maxDuration: number; voices?: ZealmanVoice[]; remoteLibrary?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ upload: []; clearReferences: []; replaceReference: [item: H3Reference]; busy: [value: boolean]; openLibrary: [] }>();
const state = defineModel<H3PromptState>({ required: true });
const prompt = defineModel<string>("prompt", { required: true });
const promptModel = defineModel<PromptModel>("promptModel", { required: true });
const duration = defineModel<number | undefined>("duration", { required: true });
const editor = ref<InstanceType<typeof promptInput>>();
const models = ref<NodeAiModel[]>([]);
const modelsLoading = ref(false);
const optimizing = ref(false);
const error = ref("");
const skillVisible = ref(false);
const helpVisible = ref(false);
const previewReference = ref<H3Reference>();
const previewError = ref("");
const previewMedia = computed(() => {
  const input = previewReference.value?.input;
  return input && ["IMAGE", "VIDEO", "AUDIO"].includes(String(input.dataType)) ? input.value as { url: string; mimeType: string } | undefined : undefined;
});
watch(previewReference, () => { previewError.value = ""; });
const localPreview = props.files.useFileUrl(() => previewMedia.value && !/^https?:\/\//.test(previewMedia.value.url) ? previewMedia.value : undefined, cause => { previewError.value = cause instanceof Error ? cause.message : "参考素材读取失败"; });
const previewSource = computed(() => previewReference.value?.voice?.url || (previewMedia.value && /^https?:\/\//.test(previewMedia.value.url) ? previewMedia.value.url : localPreview.value));
const resultVisible = ref(false);
const pendingResult = ref("");
const editingDisabled = computed(() => props.disabled || optimizing.value);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === state.value.model));
const preferences = inject<Pick<Storage, "getItem" | "setItem">>("nodePreferences");
let optimizationController: AbortController | undefined;
const history = ref<string[]>([prompt.value]);
const historyIndex = ref(0);
let historyTimer: ReturnType<typeof setTimeout> | undefined;
let replaying = false;
const finalPrompt = computed(() => h3GenerationPrompt(prompt.value, props.references, state.value));
const issues = computed(() => h3PromptIssues(finalPrompt.value, props.references, duration.value ?? 10));
const dialogueVisible = ref(false);
let editingDialogue: { start: number; end: number; original: string } | undefined;
const dialogue = reactive({ subjects: [] as number[], speaker: 1, delivery: "says", language: "Chinese", text: "", sceneTransition: false, cutoff: false });
const deliveries = [{ value: "says", label: "开口说话" }, { value: "says in a low whisper", label: "小声说" }, { value: "says with a trembling tone", label: "颤抖着说" }, { value: "shouts", label: "喊叫" }, { value: "says off-screen", label: "画外说话" }, { value: "male narrator", label: "男性旁白" }, { value: "female narrator", label: "女性旁白" }, { value: "inner monologue", label: "内心独白（闭口）" }];
const referenceGroups = [
  { label: "素材", categories: ["picture", "video", "audio", "text"] },
  { label: "主体人物", categories: ["subject"] },
  { label: "说话人", categories: ["speaker"] },
  { label: "镜头", categories: ["shot"] },
  { label: "对白", categories: ["dialogue"] },
  { label: "任务与段落", categories: ["task", "section"] },
];
const mentions = computed<H3Reference[]>((previous) => {
  const byId = new Map(props.references.map(item => [item.id, item]));
  const subjects = state.value.subjects.filter(subject => subject.references.some(id => byId.has(id)));
  const values: H3Reference[] = [...props.references, ...subjects.map(subject => {
    const preview = subject.references.map(id => byId.get(id)).find(item => item?.avatar);
    return { id: `subject:${subject.id}`, name: subject.name, value: `<Subject ${subject.id}>`, category: "subject", avatar: preview?.avatar, previewUrl: preview?.previewUrl };
  })];
  for (let index = 1; index <= 12; index++) {
    values.push({ id: `speaker:${index}`, name: `说话人${index}`, value: `(S${index})`, category: "speaker" });
    values.push({ id: `shot:${index}`, name: `镜头${index}`, value: `[Shot ${index}]`, category: "shot" });
  }
  for (const language of h3Languages) values.push({ id: `dialogue:${language.value}`, name: `${language.label}对白`, value: `<d>[${language.value}] 台词</d>`, category: "dialogue", action: true });
  const lines = new Set<string>();
  for (const match of prompt.value.matchAll(/<d>\[([^\]]+)\]\s*([\s\S]*?)<\/d>/g)) {
    if (lines.has(match[0])) continue;
    lines.add(match[0]);
    values.push({ id: `dialogue:${match[0]}`, name: `${h3Languages.find(item => item.value === match[1])?.label ?? match[1]}对白：${match[2]}`, value: match[0], category: "dialogue" });
  }
  for (const [value, name] of [["reference generation", "参考生成"], ["video editing", "视频编辑"], ["video continuation", "视频续写"], ["audio reuse", "音频复用"], ["audio reference", "音频参考"]]) values.push({ id: `task:${value}`, name, value: `[${value}]`, category: "task" });
  for (const [value, name] of h3Sections) values.push({ id: `section:${value}`, name, value: `${value}:`, category: "section" });
  for (const [value, name] of [["<scenetrans>", "对白跨镜衔接"], ["<cutoff>", "对白结尾截断"]]) values.push({ id: value, name, value, category: "dialogue" });
  return previous?.length === values.length && values.every((item, index) => ["id", "name", "value", "avatar", "previewUrl", "category", "action"].every(key => item[key as keyof H3Reference] === previous[index][key as keyof H3Reference])) ? previous : values;
});

function remember() {
  clearTimeout(historyTimer);
  if (replaying || history.value[historyIndex.value] === prompt.value) return;
  history.value = [...history.value.slice(0, historyIndex.value + 1), prompt.value].slice(-50);
  historyIndex.value = history.value.length - 1;
}
watch(prompt, () => { clearTimeout(historyTimer); if (!replaying) historyTimer = setTimeout(remember, 350); }, { flush: "sync" });
watch(prompt, value => {
  for (const subject of h3PromptSubjects(value, props.references)) if (!state.value.subjects.some(item => item.id === subject.id)) state.value.subjects.push(subject);
}, { immediate: true });
function syncCodeModel(value = prompt.value) { promptModel.value = value.split("\n").map(text => [{ type: "Write", text }]); }
function replacePrompt(value: string) { remember(); prompt.value = value; syncCodeModel(value); void nextTick(remember); }
function restoreHistory(delta: number) {
  remember();
  const next = historyIndex.value + delta;
  if (next < 0 || next >= history.value.length) return;
  replaying = true;
  historyIndex.value = next;
  const value = history.value[next];
  prompt.value = value;
  syncCodeModel(value);
  void nextTick(() => { replaying = false; });
}
function handleHistoryKey(event: KeyboardEvent) {
  if (editingDisabled.value || event.isComposing || !(event.ctrlKey || event.metaKey) || !["z", "y"].includes(event.key.toLowerCase()) || !(event.target instanceof Element) || !event.target.closest(".promptInput, .codeEditor")) return;
  event.preventDefault();
  event.stopPropagation();
  restoreHistory(event.key.toLowerCase() === "y" || event.shiftKey ? 1 : -1);
}
function syncDefinitions(value = prompt.value) { replacePrompt(h3GenerationPrompt(value, props.references, state.value, true)); }
function assignSubject(reference: string, name: string) {
  name = name.trim();
  let text = prompt.value;
  const previous = state.value.subjects.find(item => item.references.includes(reference));
  if (previous?.name === name) return;
  let target = state.value.subjects.find(item => item.name === name);
  if (!target && name && previous?.references.length === 1) { previous.name = name; syncDefinitions(); return; }
  if (previous) previous.references = previous.references.filter(id => id !== reference);
  if (!target && name) {
    const usedIds = [...prompt.value.matchAll(/<(?:Missing )?Subject\s+(\d+)>/g)].map(match => Number(match[1]));
    target = { id: Math.max(0, ...state.value.subjects.map(item => item.id), ...usedIds) + 1, name, references: [] };
    state.value.subjects.push(target);
  }
  if (target) target.references.push(reference);
  if (previous && !previous.references.length) {
    const previousToken = `<Subject ${previous.id}>`;
    const targetSpeaker = target ? speakerFor(target.id) : undefined;
    text = text.split("\n").filter(line => !line.startsWith(`${previousToken} is `) && !line.startsWith(`${previousToken} 是 `)).join("\n");
    text = text.replace(new RegExp(`${previousToken}\\s*\\(S\\d+\\)`, "g"), () => target ? `<Subject ${target.id}> (S${targetSpeaker})` : `<Missing Subject ${previous.id}>`);
    text = text.replaceAll(previousToken, target ? `<Subject ${target.id}>` : `<Missing Subject ${previous.id}>`);
    for (const [id, binding] of Object.entries(state.value.audioBindings)) {
      if (binding.subject !== previous.id) continue;
      if (target) { binding.subject = target.id; binding.speaker = targetSpeaker!; }
      else delete state.value.audioBindings[id];
    }
  }
  state.value.subjects = state.value.subjects.filter(item => item.references.length);
  syncDefinitions(text);
}
function speakerFor(subject: number) {
  const previous = new RegExp(`<Subject\\s+${subject}>\\s*\\(S(\\d+)\\)`).exec(prompt.value);
  const binding = Object.values(state.value.audioBindings).find(item => item.subject === subject);
  const item = state.value.subjects.find(item => item.id === subject)!;
  const existing = previous ? Number(previous[1]) : binding?.speaker ?? item.speaker;
  if (existing) return existing;
  const used = new Set([...prompt.value.matchAll(/\bS(\d+)\b/g)].map(match => Number(match[1])));
  for (const subject of state.value.subjects) if (subject.speaker) used.add(subject.speaker);
  for (const binding of Object.values(state.value.audioBindings)) used.add(binding.speaker);
  let next = 1;
  while (used.has(next)) next++;
  item.speaker = next;
  return next;
}
function bindAudio(id: string, subject?: number) {
  const reference = props.references.find(item => item.id === id)!;
  let text = prompt.value;
  if (subject) state.value.audioBindings[id] = { subject, speaker: speakerFor(subject), description: state.value.audioBindings[id]?.description ?? "" };
  else {
    delete state.value.audioBindings[id];
    text = text.split("\n").filter(line => !line.startsWith(`${reference.value} is the voice-timbre reference for `)).join("\n");
  }
  syncDefinitions(text);
}
function changeSpeaker(id: string, value?: number) {
  if (!value || !Number.isInteger(value)) return;
  const binding = state.value.audioBindings[id];
  if (state.value.subjects.some(subject => subject.id !== binding.subject && subject.speaker === value) || Object.values(state.value.audioBindings).some(item => item.subject !== binding.subject && item.speaker === value)) { ElMessage.error("该说话人编号已绑定其他主体，请选择不同编号"); return; }
  const previous = binding.speaker;
  for (const item of Object.values(state.value.audioBindings)) if (item.subject === binding.subject) item.speaker = value;
  const subject = state.value.subjects.find(subject => subject.id === binding.subject);
  if (subject) subject.speaker = value;
  syncDefinitions(prompt.value.replace(/\(S\d+(?:,\s*S\d+)*\)/g, text => text.replace(new RegExp(`\\bS${previous}\\b`, "g"), `S${value}`)));
}
function insertSkeleton() { replacePrompt(h3Skeleton(prompt.value, props.references, state.value, duration.value ?? 10)); }
async function copyPrompt() {
  try { await navigator.clipboard.writeText(finalPrompt.value); ElMessage.success("已复制 H3 提示词"); }
  catch { ElMessage.error("复制失败，请在代码模式中选中提示词复制"); }
}
function openDialogue(value = "", occurrence = 0, inserting = false, at?: number) {
  const parsed = /<d>\[([^\]]+)\]\s*([\s\S]*?)<\/d>/.exec(value);
  editingDialogue = undefined;
  Object.assign(dialogue, { subjects: [], speaker: 1, delivery: "says", language: parsed?.[1] ?? "Chinese", text: inserting ? "" : (parsed?.[2] ?? "").replace(/<scenetrans>|<cutoff>/g, ""), sceneTransition: value.includes("<scenetrans>"), cutoff: value.includes("<cutoff>") });
  if (inserting && at !== undefined) editingDialogue = { start: at, end: at + value.length, original: value };
  if (value && !inserting) {
    let start = -1;
    for (let index = 0; index <= occurrence; index++) start = prompt.value.indexOf(value, start + 1);
    if (start < 0) return;
    const prefix = /((?:<Subject\s+\d+>(?:\s+and\s+<Subject\s+\d+>)*|a (?:male |female )?narrator))\s*\((S\d+(?:,\s*S\d+)*)\)\s*([^<>\n]+),\s*$/.exec(prompt.value.slice(0, start));
    const end = start + value.length;
    if (prefix) {
      start -= prefix[0].length;
      dialogue.subjects = [...prefix[1].matchAll(/<Subject\s+(\d+)>/g)].map(match => Number(match[1]));
      dialogue.speaker = Number(/S(\d+)/.exec(prefix[2])![1]);
      dialogue.delivery = prefix[1].includes("narrator") ? prefix[1].slice(2) : prefix[3];
    }
    editingDialogue = { start, end, original: prompt.value.slice(start, end) };
  }
  dialogueVisible.value = true;
}
function activateMention(item: { value: string; category?: string }, occurrence: number) { if (item.category === "dialogue" && item.value.startsWith("<d>")) openDialogue(item.value, occurrence); }
async function insertMention(item: { value: string; action?: boolean }, offset: number) { if (item.action) { await nextTick(); openDialogue(item.value, 0, true, offset); } }
async function applyDialogue() {
  if (dialogue.subjects.some(id => !state.value.subjects.some(subject => subject.id === id))) { ElMessage.error("发声主体已被移除，请重新选择"); return; }
  const line = `<d>[${dialogue.language}] ${dialogue.text}${dialogue.sceneTransition ? "<scenetrans>" : ""}${dialogue.cutoff ? "<cutoff>" : ""}</d>`;
  let text = line;
  {
    const subjects = dialogue.subjects.map(id => `<Subject ${id}>`).join(" and ");
    const speakers = [...new Set(dialogue.subjects.map(speakerFor))];
    const speaker = `(${(speakers.length ? speakers : [dialogue.speaker]).map(id => `S${id}`).join(",")})`;
    const narrator = dialogue.delivery.includes("narrator") ? `a ${dialogue.delivery}` : "a narrator";
    const delivery = dialogue.delivery === "inner monologue" ? "says in an off-screen voiceover, while their lips remain completely closed"
      : dialogue.delivery.includes("narrator") || !subjects ? "says in an off-screen voiceover"
      : dialogue.subjects.length > 1 ? dialogue.delivery.replace(/^says/, "say").replace(/^shouts/, "shout together") : dialogue.delivery;
    text = `${subjects || narrator} ${speaker} ${delivery}, ${line}`;
  }
  if (editingDialogue) {
    const { start, end, original } = editingDialogue;
    if (prompt.value.slice(start, end) !== original) { ElMessage.error("原对白已发生变化，请关闭后重新选择对白编辑"); return; }
    replacePrompt(`${prompt.value.slice(0, start)}${text}${prompt.value.slice(end)}`);
  }
  else {
    const detail = /(?:^|\n)[ \t]*detailed_description[ \t]*:[\s\S]*?(?=\n[ \t]*(?:overall_soundscape|non_diegetic_music)[ \t]*:|$)/.exec(prompt.value);
    const caret = state.value.editorMode === "tags" ? editor.value?.getCaretOffset() : undefined;
    if (detail && (caret === undefined || caret < detail.index || caret >= detail.index + detail[0].length)) {
      const at = detail.index + detail[0].trimEnd().length;
      replacePrompt(`${prompt.value.slice(0, at)}\n${text}${prompt.value.slice(at)}`);
    } else if (state.value.editorMode === "tags" && editor.value) { remember(); await editor.value.insertText(text); void nextTick(remember); }
    else replacePrompt(`${prompt.value}${prompt.value.endsWith("\n") || !prompt.value ? "" : "\n"}${text}`);
  }
  dialogueVisible.value = false;
}

async function loadModels() {
  if (modelsLoading.value) return;
  modelsLoading.value = true;
  try {
    models.value = await props.ai.getModels();
    if (!state.value.model) {
      let preferred = "";
      try { preferred = JSON.parse(preferences?.getItem("toonflow:generation:text") ?? "{}").model ?? ""; } catch { /* 旧模型偏好无效时由已配置模型列表选择。 */ }
      const choice = models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === preferred) ?? models.value[0];
      if (choice) state.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    }
    if (!models.value.length) error.value = "请先在设置中配置文本模型，再使用 Skill 优化";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "文本模型读取失败"; }
  finally { modelsLoading.value = false; }
}
async function optimize() {
  const choice = selectedModel.value;
  if (!choice || editingDisabled.value || !prompt.value.trim()) return;
  optimizationController = new AbortController();
  const signal = optimizationController.signal;
  const original = finalPrompt.value;
  const readSnapshot = () => JSON.stringify([prompt.value, props.references.map(item => [item.id, item.value, item.input?.value]), state.value.subjects, state.value.audioBindings, duration.value]);
  const snapshot = readSnapshot();
  const inputReferences = props.references.map(item => ({ ...item, input: item.input ? JSON.parse(JSON.stringify(item.input)) : undefined }));
  const originalDuration = duration.value ?? 10;
  optimizing.value = true;
  emit("busy", true);
  error.value = "";
  try {
    const references = inputReferences.filter(item => item.input?.value !== undefined && ["IMAGE", "STRING"].includes(String(item.input?.dataType)));
    const directory = props.files.getWorkspaceDirectory();
    const workspace = props.files.getWorkspaceFiles();
    const aiReferences = await Promise.all(references.map(async item => {
      if (item.input!.dataType === "STRING") return { dataType: "STRING" as const, value: String(item.input!.value) };
      let value = { ...(item.input!.value as { url: string; mimeType: string }) };
      if (/^https:\/\//i.test(value.url)) {
        if (!workspace.importImage) throw new Error("当前应用不支持导入公网图片，请先把图片上传到节点再优化");
        const imported = await workspace.importImage(value.url);
        value = { url: imported.path, mimeType: imported.mimeType };
      }
      return { dataType: "IMAGE" as const, value };
    }));
    signal.throwIfAborted();
    const result = await props.ai.generate({
      providerId: choice.providerId, modelId: choice.modelId, systemPrompt: h3PromptSkill, signal,
      directory,
      prompt: JSON.stringify({ request: original, durationSeconds: originalDuration, maxDurationSeconds: props.maxDuration,
        referenceLabels: references.map((item, index) => ({ attachment: `{{ref ${index + 1}}}`, h3Tag: item.value })),
        materials: inputReferences.map(item => ({ tag: item.value, name: item.name })), subjects: state.value.subjects,
      }),
      references: aiReferences,
    });
    signal.throwIfAborted();
    const next = parseH3Optimization(result.text, original, inputReferences, originalDuration, props.maxDuration);
    if (snapshot !== readSnapshot()) {
      pendingResult.value = next.prompt;
      resultVisible.value = true;
      return;
    }
    replacePrompt(next.prompt);
    duration.value = next.duration;
    ElMessage.success("已按内置 Skill 优化，可撤销恢复原提示词");
  } catch (cause) {
    if (!signal.aborted) error.value = cause instanceof SyntaxError ? "模型没有返回规范的六段 JSON，原提示词已保留，请重试" : cause instanceof Error ? /^No API key/.test(cause.message) ? "请在设置 → 文本模型中填写所选模型的 API Key，原提示词已保留" : cause.message : "提示词优化失败";
  } finally { optimizing.value = false; emit("busy", false); }
}

watch(() => state.value.editorMode, () => { remember(); syncCodeModel(); });
onMounted(async () => { await loadModels(); await nextTick(); const normalized = h3GenerationPrompt(prompt.value, props.references, state.value); if (normalized !== prompt.value) replacePrompt(normalized); });
onScopeDispose(() => { clearTimeout(historyTimer); optimizationController?.abort(); emit("busy", false); });
</script>

<style scoped lang="scss">
.h3PromptEditor {
  display: grid; gap: 10px; margin-bottom: 12px;
  .promptTools, .editorHeader, .editorActions, .bindingRow, .subjectRow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .promptTools, .editorActions { :deep(.el-button) { margin: 0; } }
  .editorHeader { justify-content: space-between; color: var(--el-text-color-secondary); font-size: 11px; }
  .characterCount { margin-left: auto; color: var(--el-text-color-secondary); font-size: 11px; }
  .referenceSettings { border-top: 0; }
  .subjectRow { margin: 6px 0; > span { min-width: 30px; } :deep(.el-select) { flex: 1; min-width: 150px; } }
  .voiceLibrary { display: grid; gap: 6px; margin: 10px 0; }
  .audioBinding { margin-top: 8px; .bindingRow { > span { flex: 1; min-width: 90px; } :deep(.el-select) { flex: 1; min-width: 120px; } } .bindingDetails { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 6px; margin-top: 6px; :deep(.el-input-number) { width: 100%; } } }
  .helpText { margin: 8px 0 0; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.6; }
  .promptIssues { color: var(--el-color-warning); font-size: 11px; p { margin: 3px 0; } }
  .codeEditor :deep(textarea) { font-family: ui-monospace, monospace; line-height: 1.7; }
  :deep(.imageReference[data-category="subject"]) { color: var(--el-color-success); background: var(--el-color-success-light-9); }
  :deep(.imageReference[data-category="shot"]), :deep(.imageReference[data-category="speaker"]) { color: var(--el-color-primary); }
  :deep(.imageReference[data-category="dialogue"]) { cursor: pointer; white-space: normal; }
  :deep(.imageReference[data-category="section"]) { color: var(--el-text-color-regular); background: var(--el-fill-color); }
}
.optimizerSettings { display: grid; gap: 8px; > span { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; } }
.dialogueForm { .dialogueRow { display: flex; flex-wrap: wrap; gap: 16px; > * { flex: 1; } } }
.dialogueHelp { padding-left: 22px; line-height: 1.8; li { margin-bottom: 8px; } }
.referencePreview { display: grid; place-items: center; img, video { max-width: 100%; max-height: 70vh; } audio { width: 100%; } }
</style>
