# Toonflow 本地 Whisper 字幕与 FFmpeg 烧录实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Toonflow 中加入本地官方 Whisper 转录、可编辑 SRT 字幕节点和 FFmpeg 硬字幕烧录节点。

**Architecture:** 服务端通过受校验的 Python 子进程运行 `python -m whisper`，以任务 ID 管理长任务并把结果原子写入工作区。`subtitleNode` 负责媒体输入、分段表格、SRT 持久化和 Agent/手动转录；`subtitleBurnNode` 负责视频与 SRT 输入、FFmpeg 烧录和新视频输出。两个节点只通过现有节点值、工作区文件和宿主 API 通信。

**Tech Stack:** Bun、TypeScript、Express、Zod、Vue 3、Vue Flow、Element Plus、`@toonflow/file`、`@toonflow/nodes-scaffold`、`@toonflow/ffmpeg`、本机 Python `openai-whisper`。

---

## 实现时的契约修正

以下修正是对现有代码约束的落实，优先于下方原始步骤中的接口示意：

- SRT 编解码由 `@toonflow/node-shared/subtitleSrt` 同时供服务端与两个节点复用；换行统一为 CRLF，区间按毫秒校验，解析与序列化可往返。服务端通过工作区依赖声明引用，不能穿透源码。
- Python 路径和默认模型由服务端读取已安装、已启用的 `subtitleNode` 配置；HTTP 不接受 `pythonPath`。`check` 接收授权工作区目录，返回完整预检、模型名单及默认值。类型通过 `@toonflow/server/whisper/types` 公开子路径供前端仅作类型引用。
- 转录先排他写入独立结果 SRT，再由节点载入草稿。只有“保存字幕”或明确的 Agent 保存工具才使用 `writeTextSnapshot` 更新 canonical `subtitle.srt` 和输出端，失败保留草稿。
- 本地单进程同一时间执行一个 Whisper 任务，完成状态在退出和清理后发布；任务表有界保留。`writing` 作为不可取消的原子提交边界，取消请求等待真实结果。
- 节点工具有 120 秒上限。`generateSubtitle` 和 `burnSubtitles` 启动后台操作并立即返回；查询/取消复用现有 `useNodeGeneration`。前端轮询不占用 Agent 回合，不能把前次输出误当本次完成结果。
- 原 Task 4 在没有 `index.vue` 时无法独立构建，所以 Task 4 和 Task 5 作为一个字幕节点实现单元执行和审查。两包均须有 `tsconfig.json`，注册工作区依赖后更新 `bun.lock`。
- 烧录使用不同的输入/输出端口 ID：`videoInput`、`subtitleInput`、`video`。每次导出创建新的子目录与 `burned.mp4`，保留历史成品。能力查询必须确认 `subtitles` 滤镜可用，并检查中文字体渲染。
- 当前机器原有 Python 3.8/PyTorch 保持不动；真实验证使用隔离工作区 `data/whisperPython` 的 Python 3.11、官方 Whisper 和 CPU PyTorch。用户指定的视频仅复制到工作区使用。

## 执行记录

- [x] Task 1：共享 SRT 编解码器、规范审查及完整差异质量复审通过，提交 `9384243`。
- [x] Task 2：服务端运行时及两阶段审查通过，提交 `acf5224`。
- [x] Task 3：HTTP 接口与共享契约集成，提交 `4c296cd`，两阶段审查通过。
- [x] Task 4 + Task 5：字幕节点及编辑表格，最终提交 `f894673`，两阶段审查通过。
- [x] Task 6：烧录节点与 FFmpeg 禁止覆盖参数修正，提交 `f1dd049`、`8257519`，两阶段审查通过。
- [x] Task 7：相关构建、真实媒体手动链路和最终跨模块审查完成，验证边界见下文。

### 实际验证记录（2026-10-15）

- `server`、`node-shared`、`ffmpeg`、`node-subtitle`、`node-subtitle-burn` 的最终类型检查全部通过；Server、Web、两个新节点构建成功。
- 通过实际 HTTP 验证了参数拒绝、目录授权、禁止调用方覆盖 Python 路径、节点未安装及任务失效。真实运行接口链为 check → start → task → completed。
- 使用用户指定的约 15 秒视频，官方 Whisper `small` / 中文在 CPU 上完成转录。独立 Python 3.11.9、Whisper 20250625、CPU PyTorch 2.14.1 成功导入；未改原有 Python 环境。
- 浏览器中创建视频、字幕、字幕烧录节点并完成连线。点击 AI 生成后草稿出现，canonical SRT 仍为空；错误的零时长区间被拒绝。修改为多行中文字幕后显式保存成功，导出文件与工作区 SRT 的 SHA256 一致。页面重载保留草稿和已保存内容。
- 点击烧录生成新的 H.264 / AAC MP4，FFprobe 确认 1344×768、15.083333 秒。应用内大屏预览确认中文正常显示；原视频 SHA256 保持不变。
- 在真实 Whisper 任务处于 transcribing 时调用 cancel，返回 cancelled / running=false，本次结果文件不存在、任务临时目录已清空，已有字幕与成品保留。
- 最终整体代码审查未发现 P1/P2 问题；没有新增测试模块、临时测试文件或测试入口。
- 验证限制：没有配置并调用真实对话模型，因此 Agent 工具覆盖由节点工具注册、共同执行函数与代码审查确认，未宣称完成模型实际调度验证。全仓基线 typecheck 在 desktop/mobile 因隔离工作区缺少 `.hutch` 开发类型失败，未改动这些模块；相关包检查和独立 Web/Server 验证通过。
- 预览数据放在独立的普通目录，避免 Express 对 `.codex` 路径默认忽略导致节点脚本 404；没有修改 HTTP 文件服务安全规则。

## 文件地图

### 新建文件

- `packages/nodeShared/src/subtitleSrt.ts`：SRT 分段类型、解析、序列化和时间戳校验。
- `apps/server/src/utils/whisper/types.ts`：服务端 Whisper 模型、预检和任务状态类型。
- `apps/server/src/utils/whisper/runtime.ts`：Python/Whisper 预检、进程启动、任务状态、取消和临时目录清理。
- `apps/server/src/utils/whisper/index.ts`：Whisper 公共导出。
- `apps/server/src/routes/whisper/check.ts`：预检接口。
- `apps/server/src/routes/whisper/start.ts`：启动转录接口。
- `apps/server/src/routes/whisper/task.ts`：任务查询接口。
- `apps/server/src/routes/whisper/cancel.ts`：任务取消接口。
- `packages/nodes/subtitleNode/package.json`、`vite.config.ts`、`readme.md`。
- `packages/nodes/subtitleNode/src/index.vue`：字幕节点外壳、持久化、按钮和 Agent 工具。
- `packages/nodes/subtitleNode/src/whisperClient.ts`：字幕节点调用服务端任务接口的客户端。
- `packages/nodes/subtitleNode/src/components/segmentTable.vue`：分段时间轴表格。
- `packages/nodes/subtitleBurnNode/package.json`、`vite.config.ts`、`readme.md`。
- `packages/nodes/subtitleBurnNode/src/index.vue`：烧录节点 UI、输入输出和 Agent 工具。
- `packages/nodes/subtitleBurnNode/src/videoBurning.ts`：FFmpeg 烧录、取消和 FFprobe 验证。

### 修改文件

- `packages/nodeShared/package.json`：公开 `./subtitleSrt` 子路径。
- `apps/server/src/utils.ts`：把 Whisper 公共模块挂到 `u.whisper`。
- `apps/server/src/router.ts`：由 `bun run routes` 根据新路由自动生成，不手工维护。

实现期间不修改现有视频生成节点、媒体供应商、全局 `NodeValueMap` 或测试目录。

## Task 1: 建立共享 SRT 编解码器

**Files:**

- Create: `packages/nodeShared/src/subtitleSrt.ts`
- Modify: `packages/nodeShared/package.json`

- [ ] **Step 1: 定义共享类型和边界**

在 `subtitleSrt.ts` 中定义：

```ts
export type SubtitleSegment = {
  start: number;
  end: number;
  text: string;
};

export function parseSrt(source: string): SubtitleSegment[];
export function serializeSrt(segments: readonly SubtitleSegment[]): string;
export function formatSrtTime(seconds: number): string;
export function parseSrtTime(value: string): number;
```

解析器去掉 UTF-8 BOM，按空行分块，要求每块包含序号、`HH:MM:SS,mmm --> HH:MM:SS,mmm` 和至少一行文本；允许文本包含换行，输出前重新编号。所有时间必须有限、非负且 `start < end`，分段按开始时间不递减；不符合时抛出面向用户的中文错误。

- [ ] **Step 2: 实现规范化序列化**

`serializeSrt` 将文本行首尾空白清理为稳定结果，使用三位毫秒和 CRLF 分隔，并在最后一个分段后保留一个换行。空文本、逆序时间和超过安全范围的秒数都在序列化前拒绝。

- [ ] **Step 3: 暴露公开子路径并检查类型**

在 `packages/nodeShared/package.json` 的 `exports` 中加入 `"./subtitleSrt": "./src/subtitleSrt.ts"`，然后运行：

```powershell
bun run --filter '@toonflow/node-shared' typecheck
```

预期：命令成功，且没有新增测试文件。

- [ ] **Step 4: 提交共享编解码器**

```powershell
git add packages/nodeShared/package.json packages/nodeShared/src/subtitleSrt.ts
git commit -m "feat: add shared srt codec"
```

## Task 2: 实现服务端 Whisper 运行时

**Files:**

- Create: `apps/server/src/utils/whisper/types.ts`
- Create: `apps/server/src/utils/whisper/runtime.ts`
- Create: `apps/server/src/utils/whisper/index.ts`
- Modify: `apps/server/src/utils.ts`

- [ ] **Step 1: 固定运行时接口和状态模型**

在 `types.ts` 中使用以下稳定名称，后续路由和前端按这些类型通信：

```ts
export const whisperModels = ["tiny", "base", "small", "medium", "large", "turbo"] as const;
export type WhisperModel = typeof whisperModels[number];
export type WhisperTaskPhase = "preparing" | "downloadingModel" | "transcribing" | "writing" | "completed" | "failed" | "cancelled";
export type WhisperTask = {
  operationId: string;
  phase: WhisperTaskPhase;
  running: boolean;
  model: WhisperModel;
  output?: string;
  error?: string;
  updatedAt: number;
};
```

`runtime.ts` 导出 `checkWhisper(pythonPath?: string)`、`startWhisper(input)`、`getWhisperTask(directory, operationId)` 和 `cancelWhisper(directory, operationId)`；`index.ts` 只重导出这些公共符号。

- [ ] **Step 2: 实现 Python 可执行文件和依赖预检**

按 `pythonPath` 或 `Bun.which("python")` 查找一个可执行文件；拒绝空路径、目录和无法启动的程序。用 `Bun.spawn([python, "-c", probeScript], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })` 运行探测脚本，脚本只输出 JSON，读取 `importlib.util.find_spec("whisper")`、`torch.__version__` 和 `torch.cuda.is_available()`，不加载模型。

预检同时调用现有 `@/utils/ffmpeg` 的 `getStatus()`，返回 Python 路径、Whisper/PyTorch 是否可导入、设备信息、FFmpeg 两个程序状态，以及 `join(dirname(conf.path), "whisper", "cache")` 的缓存目录。预检失败返回具体缺项，不自动安装依赖。

- [ ] **Step 3: 实现受控任务启动**

`startWhisper` 先校验模型名和语言长度，再锁定输出文件，创建位于 Toonflow 数据目录的唯一临时目录。通过 `Bun.spawn` 使用参数数组启动：

```ts
[
  pythonPath,
  "-m", "whisper", sourcePath,
  "--model", model,
  "--output_dir", temporaryDirectory,
  "--output_format", "srt",
  "--task", "transcribe",
  ...(language ? ["--language", language] : []),
]
```

命令环境将 `XDG_CACHE_HOME` 设为数据目录下的缓存根，并把当前 Toonflow FFmpeg 所在目录放在 `PATH` 首位。所有进程输入使用绝对的、已通过工作区边界校验的路径；不调用 shell、不拼接命令字符串。

- [ ] **Step 4: 实现结果提交、阶段状态和取消**

任务表以 `${directory}\0${operationId}` 为键，记录 `AbortController`、子进程、完成 Promise 和对外状态。模型缓存不存在时先报告 `downloadingModel`，进程启动后报告 `transcribing`；退出码为零后在临时目录中读取唯一 `.srt` 文件，使用 `writeAtomic(outputPath, content)` 提交并报告 `writing`、`completed`。任何非零退出、空结果、多个结果、取消或异常都报告失败/取消并删除临时目录。

取消先杀死子进程，等待 `exited` 后再释放文件锁和删除临时目录；任务结束函数只能执行一次，防止迟到的进程事件覆盖新状态。服务重启不恢复内存任务，查询不到的任务返回“任务已失效”。

- [ ] **Step 5: 接入统一服务端工具出口并检查类型**

在 `apps/server/src/utils.ts` 中加入 `import * as whisper from "@/utils/whisper";` 和对象属性 `whisper`，然后运行：

```powershell
bun run --filter '@toonflow/server' typecheck
```

- [ ] **Step 6: 提交运行时**

```powershell
git add apps/server/src/utils.ts apps/server/src/utils/whisper
git commit -m "feat: add local whisper runtime"
```

## Task 3: 增加 Whisper HTTP 路由

**Files:**

- Create: `apps/server/src/routes/whisper/check.ts`
- Create: `apps/server/src/routes/whisper/start.ts`
- Create: `apps/server/src/routes/whisper/task.ts`
- Create: `apps/server/src/routes/whisper/cancel.ts`
- Modify: `apps/server/src/router.ts` through `bun run routes`

- [ ] **Step 1: 编写预检接口**

`check.ts` 注册 `GET /api/whisper/check`，从 query 读取可选的 `pythonPath`，调用 `u.whisper.checkWhisper`，使用 `success` 返回状态。沿用 `x-toonflow-workspace` 和现有来源校验，不接受文件路径或任意命令参数。

- [ ] **Step 2: 编写启动接口**

`start.ts` 注册 `POST /api/whisper/start`，用 Zod 严格校验 `{ directory, source, output, pythonPath?, model, language? }`；`model` 使用 `z.enum(whisperModels)`，`source` 必须是已有工作区文件，`output` 允许缺失父目录但仍必须在工作区内。调用 `u.workspace.resolveWorkspace(req, directory)`，再用 `resolveWorkspacePath` 得到实际路径，最后返回 `{ operationId, phase, running }`。

- [ ] **Step 3: 编写查询和取消接口**

`task.ts` 注册 `GET /api/whisper/task`，从 query 读取 `directory` 和 UUID `operationId`，返回当前任务或已失效错误。`cancel.ts` 注册 `POST /api/whisper/cancel`，校验同样的两个字段，调用取消函数并返回最终状态。两个接口都只操作当前工作区，不接受绝对路径。

- [ ] **Step 4: 生成路由并检查服务端**

```powershell
bun run --cwd apps/server routes
bun run --filter '@toonflow/server' typecheck
```

检查 `apps/server/src/router.ts` 只由生成器新增导入和注册项；不手工重命名 `routeN`。完成后提交：

```powershell
git add apps/server/src/routes/whisper apps/server/src/router.ts
git commit -m "feat: expose whisper task routes"
```

## Task 4: 建立字幕节点包和客户端任务适配

**Files:**

- Create: `packages/nodes/subtitleNode/package.json`
- Create: `packages/nodes/subtitleNode/vite.config.ts`
- Create: `packages/nodes/subtitleNode/readme.md`
- Create: `packages/nodes/subtitleNode/src/whisperClient.ts`
- Create: `packages/nodes/subtitleNode/src/components/segmentTable.vue`

- [ ] **Step 1: 创建节点包元数据**

复制现有 `textNode` 的脚手架结构，包名使用 `@toonflow/node-subtitle`，节点名使用 `subtitleNode`，显示名为“字幕”，依赖 `@toonflow/node-shared`、`@toonflow/nodes-scaffold` 和 `@tabler/icons-vue`。`vite.config.ts` 使用 `createNodeConfig`，增加一个可选的 `pythonPath` 输入配置；所有文件名和本地组件名保持小驼峰。

- [ ] **Step 2: 实现任务客户端**

`whisperClient.ts` 定义：

```ts
const whisperModels = ["tiny", "base", "small", "medium", "large", "turbo"] as const;
type WhisperModel = typeof whisperModels[number];
type WhisperEnvironment = { pythonPath: string; whisper: boolean; torch: { version?: string; cuda: boolean }; ffmpeg: { path?: string; error?: string } };
type WhisperTask = { operationId: string; phase: string; running: boolean; model: WhisperModel; output?: string; error?: string; updatedAt: number };

export type WhisperClientInput = {
  directory: string;
  source: string;
  output: string;
  pythonPath?: string;
  model: WhisperModel;
  language?: string;
};

export function checkWhisper(pythonPath?: string, signal?: AbortSignal): Promise<WhisperEnvironment>;
export function startWhisper(input: WhisperClientInput, signal?: AbortSignal): Promise<WhisperTask>;
export function readWhisperTask(directory: string, operationId: string, signal?: AbortSignal): Promise<WhisperTask>;
export function cancelWhisper(directory: string, operationId: string): Promise<WhisperTask>;
export async function waitWhisper(input: WhisperClientInput, signal?: AbortSignal): Promise<WhisperTask>;
```

所有请求都带 `Content-Type: application/json` 和 `x-toonflow-workspace: 1`。`waitWhisper` 只在 `running` 为真时按 800ms 轮询，接收取消信号时先请求取消再抛出 AbortError；完成状态不是 `completed` 时抛出服务端错误。

- [ ] **Step 3: 实现分段表格组件**

`segmentTable.vue` 接收 `modelValue: SubtitleSegment[]`、`disabled?: boolean`，发出 `update:modelValue`。每行使用三个可编辑输入（开始、结束、文本）、删除按钮和末尾新增按钮；时间输入使用秒数显示，失焦时交给共享 `parseSrtTime` 校验。组件不负责文件读写和网络请求。

- [ ] **Step 4: 构建空节点包确认宿主依赖**

```powershell
bun run --filter '@toonflow/node-subtitle' typecheck
bun run --filter '@toonflow/node-subtitle' build
```

预期：生成 `build/nodes/subtitleNode.umd.js`，不修改其他节点产物。

## Task 5: 完成 `subtitleNode` 状态、编辑和 Agent 工具

**Files:**

- Create: `packages/nodes/subtitleNode/src/index.vue`

- [ ] **Step 1: 声明节点端口和持久化路径**

在 `defineOptions` 中声明一个 `media` target，`dataType: ["VIDEO", "AUDIO"]`，以及一个 `subtitle` source，`dataType: "STRING"`。调用 `useNode({ label: "字幕", outputs: { subtitle: { dataType: "STRING", value: "" } } })`。节点资产路径固定为 `assets/${node.id}/subtitle.srt`，启动时拒绝任何不同的已保存路径。

- [ ] **Step 2: 加载文本快照并保持保存队列**

复用 `files.getWorkspaceFiles().readTextSnapshot` 和 `writeTextSnapshot`：首次缺失时创建 `assets`、节点目录和空 SRT，之后读取现有文件并解析到表格。所有编辑串行写入，记录当前 `revision`；`nodeEvent` 的 `save` 等待队列完成，`reload` 期间有未完成任务时抛出错误，`copy` 返回 `subtitleSnapshot` 而不复制原节点目录。

- [ ] **Step 3: 实现手动导入、导出和表格校验**

导入按钮用 `File.text()` 读取 SRT，调用共享 `parseSrt`，成功后替换表格并保存；失败只显示错误，不覆盖现有字幕。导出使用当前序列化结果创建 `Blob([srt], { type: "text/srt;charset=utf-8" })`，通过 `nodeSkeleton` 下载入口导出 `subtitle.srt`。表格变更先调用 `serializeSrt`，校验通过才更新 `outputs.subtitle.value` 和磁盘快照。

- [ ] **Step 4: 接入 AI 转录和取消**

用 `useNodeInputs().getTargetValues(node.id, "media")` 找到一个有效的视频或音频输出；读取 `value.url` 作为工作区相对路径，把节点模型、语言和 `config.pythonPath` 传给 `waitWhisper`。生成期间锁定表格和删除/刷新操作，显示预检、模型下载、转录、写入阶段；完成后读取 `subtitlePath`，解析并保存分段。节点卸载、删除或用户取消都调用 `cancelWhisper`。

- [ ] **Step 5: 注册 Agent 工具**

注册下列小驼峰工具，并让按钮调用相同函数：

```ts
nodeTools.register({ name: "generateSubtitle", description: "使用本地 Whisper 为已连接的视频或音频生成 SRT 字幕", parameters: z.strictObject({ model: z.enum(whisperModels).optional(), language: z.string().max(32).optional() }), execute: generateSubtitle });
nodeTools.register({ name: "setSubtitle", description: "用合法的 SRT 文本替换此字幕节点内容", parameters: z.strictObject({ srt: z.string().max(2_000_000) }), execute: setSubtitle });
```

`generateSubtitle` 返回当前任务状态和字幕路径；`setSubtitle` 先解析再保存，不接受任意文件路径。节点删除时等待保存队列和转录取消完成。

- [ ] **Step 6: 构建字幕节点并提交**

```powershell
bun run --filter '@toonflow/node-subtitle' typecheck
bun run --filter '@toonflow/node-subtitle' build
git add packages/nodes/subtitleNode
git commit -m "feat: add editable subtitle node"
```

## Task 6: 实现 `subtitleBurnNode`

**Files:**

- Create: `packages/nodes/subtitleBurnNode/package.json`
- Create: `packages/nodes/subtitleBurnNode/vite.config.ts`
- Create: `packages/nodes/subtitleBurnNode/readme.md`
- Create: `packages/nodes/subtitleBurnNode/src/videoBurning.ts`
- Create: `packages/nodes/subtitleBurnNode/src/index.vue`

- [ ] **Step 1: 创建节点包和端口**

包名使用 `@toonflow/node-subtitle-burn`，节点名使用 `subtitleBurnNode`，依赖 `@toonflow/node-shared`、`@toonflow/nodes-scaffold`、`@toonflow/node-video` 和 `@tabler/icons-vue`。声明 `video` target（`VIDEO`）、`subtitle` target（`STRING`）和 `video` source（`VIDEO`），默认输出为空。

- [ ] **Step 2: 实现安全路径和 FFmpeg 处理函数**

`videoBurning.ts` 导出 `burnSubtitles(ffmpeg, files, nodeId, videoPath, srtText, signal)`。函数先用 `parseSrt` 校验字幕，创建 `assets/<nodeId>` 和唯一临时 SRT/MP4 路径，写入 UTF-8 SRT，然后按以下链式调用执行：

```ts
const command = ffmpeg(videoPath)
  .videoFilters([{ filter: "subtitles", options: { filename: subtitlePath } }])
  .output(outputPath)
  .videoCodec("libx264")
  .audioCodec("aac")
  .audioBitrate(192)
  .format("mp4")
  .outputOptions("-map", "0:v:0", "-map", "0:a?", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
```

监听 `start`、`progress`、`error` 和 `end`，`signal` 触发 `command.kill()`。完成后用 `ffprobe` 检查输出视频流和正时长，再返回 `{ path: outputPath, mimeType: "video/mp4" }`。任何失败删除本次临时文件但保留输入和已保存字幕。

- [ ] **Step 3: 实现节点 UI 和生命周期**

使用 `useNodeInputs` 读取两个输入；视频预览沿用 `@toonflow/node-video/videoPlayer` 的公开导出。烧录按钮在两个输入有效且未处理时可用，处理中显示 FFmpeg 进度、取消按钮和错误信息。`nodeEvent.on("save")` 在处理期间拒绝刷新，`delete` 取消并等待任务；输出成功后写入 `outputs.video`。

- [ ] **Step 4: 注册烧录 Agent 工具并构建**

注册无额外路径参数的 `burnSubtitles` 工具，读取当前两个输入，调用同一个 `burnSubtitles` 函数，返回输出视频路径和媒体类型。运行：

```powershell
bun run --filter '@toonflow/node-subtitle-burn' typecheck
bun run --filter '@toonflow/node-subtitle-burn' build
git add packages/nodes/subtitleBurnNode
git commit -m "feat: add subtitle burn node"
```

## Task 7: 集成构建、文档和真实链路验证

**Files:**

- Modify: `apps/server/src/router.ts` through the route generator.
- Modify: `packages/nodes/subtitleNode/readme.md` and `packages/nodes/subtitleBurnNode/readme.md` with the final node usage, preflight and burn commands.

- [ ] **Step 1: 重生成路由并构建相关包**

```powershell
bun run --cwd apps/server routes
bun run --filter '@toonflow/node-shared' typecheck
bun run --filter '@toonflow/server' typecheck
bun run --filter '@toonflow/node-subtitle' typecheck
bun run --filter '@toonflow/node-subtitle-burn' typecheck
bun run build:nodes
```

预期：服务端和两个节点类型检查成功，`build/nodes` 生成 `subtitleNode.umd.js` 与 `subtitleBurnNode.umd.js`；不手工编辑生成的 `router.ts`。

- [ ] **Step 2: 做本地预检和依赖边界验证**

启动现有开发服务后，通过字幕节点的预检入口确认当前环境。当前机器已知为 Python 3.8.5、CPU 版 PyTorch 1.5.1，尚未安装 `openai-whisper`；在依赖未安装前，预期 UI 明确显示缺项，不能把静态构建当作转录成功。FFmpeg 继续从 Toonflow 插件市场的现有配置读取。

- [ ] **Step 3: 做真实短媒体链路**

在安装兼容依赖和所选模型后，使用短视频或音频按顺序执行：预检、AI 转录、修改一行分段、导出 SRT、把视频和 SRT 连接到 `subtitleBurnNode`、烧录、播放输出、用现有 FFprobe 检查输出时长和视频流。确认源媒体没有变化，取消任务后没有被当作完成结果的临时文件。

- [ ] **Step 4: 做 Agent 链路和最终检查**

通过现有画布工具查询两个节点的 `nodeTools`，执行生成、设置字幕和烧录；检查返回的路径均为工作区相对路径，取消和失败状态可见。最后运行：

```powershell
git diff --check
git status --short --branch
```

确认没有新增测试文件、没有未提交的临时媒体或模型缓存，并提交集成文档变更：

```powershell
git add apps/server/src/router.ts packages/nodes/subtitleNode/readme.md packages/nodes/subtitleBurnNode/readme.md
git commit -m "docs: document whisper subtitle workflow"
```

## 约束与验证边界

- 不新增 `.test.ts`、`.spec.ts`、`scripts/check.ts` 或其他测试/自检模块；所有验证使用已有 typecheck、构建、FFprobe 和真实手动链路。
- 所有业务磁盘操作通过 `@toonflow/file`、工作区文件入口或节点脚手架提供的文件接口完成；服务端完整快照使用 `writeAtomic`，前端字幕编辑使用工作区文本快照接口。
- 所有新文件、文件夹、组件和本地绑定名使用小驼峰；`.vue` 顶层顺序固定为 `<template>`、`<script>`、`<style>`。
- 只有服务端运行时启动外部 Python；节点 UMD 不访问 Node.js、文件系统或子进程。

## 计划自检

- 设计文档中的架构、节点交互、任务阶段、路径边界、错误处理、验证和已知限制分别由 Task 1 至 Task 7 覆盖。
- 计划中没有待填写项、模糊的“稍后处理”步骤或未定义的函数名称；共享类型、路由状态和节点工具名称在后续任务中保持一致。
- 当前环境缺少 Whisper 依赖的事实只影响真实转录验证，不改变代码实现、静态类型检查或构建步骤。
