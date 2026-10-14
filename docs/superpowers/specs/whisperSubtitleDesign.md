# Toonflow 本地 Whisper 字幕与 FFmpeg 烧录设计

## 状态

设计已确认，正在隔离工作区实现。本文只定义第一阶段的本地官方 Whisper、字幕编辑和硬字幕烧录能力。

## 目标

- 在 Toonflow 中使用本机的 OpenAI Whisper Python 包从视频或音频生成分段级 SRT。
- 允许用户在独立的字幕节点中查看、修改、导入和导出 SRT 分段。
- 允许 Agent 与手动按钮调用同一套转录与保存流程。
- 通过独立的烧录节点调用 Toonflow 已有的 FFmpeg，把字幕烧录到新的视频文件。
- 保留输入媒体，所有产物都位于当前工作区，并能在画布中继续复用。

## 不在第一阶段范围内

- 不加入云端语音服务、浏览器 WASM Whisper 或 whisper.cpp/faster-whisper 后端。
- 不做逐词高亮、说话人分离、翻译、字幕特效、字体面板或字幕样式预设。
- 不改现有视频生成节点和媒体供应商链路。
- 不新增测试模块、测试脚本或测试依赖。

## 总体架构

### 节点

新增两个独立的小驼峰节点包：

- `packages/nodes/subtitleNode`：输入端接受 `VIDEO` 或 `AUDIO`，输出端使用现有 `STRING` 类型承载规范化 SRT 文本。节点同时维护 `assets/<nodeId>/subtitle.srt`，因此输出既能连接其他节点，也能作为工作区字幕文件下载。
- `packages/nodes/subtitleBurnNode`：输入端接受一个 `VIDEO` 和一个 `STRING` 字幕，输出新的 `VIDEO`。节点把连接的字幕文本写入自身资产目录后调用 FFmpeg，不覆盖输入视频。

字幕仍使用 `STRING` 是有意的最小改动：不扩展全局 `NodeValueMap`，不改变已有画布数据的类型兼容规则。字幕节点通过自身的 `subtitlePath` 和文本快照字段保持磁盘文件与画布复制的一致性。

### 服务端执行器

在 `apps/server/src/utils/whisper` 增加本地执行器和进程任务表，在 `apps/server/src/routes/whisper` 增加以下单接口路由文件：

- `check.ts`：读取 Python、Whisper、PyTorch、FFmpeg 和模型缓存状态，不下载模型。
- `start.ts`：校验工作区路径和任务参数，启动一次转录并返回 `operationId`。
- `task.ts`：按 `operationId` 查询任务状态和结果路径。
- `cancel.ts`：取消运行中的 Python 子进程并清理临时文件。

路由通过 `u.workspace.resolveWorkspace` 和工作区文件工具限制输入、输出及临时结果的路径边界。路由变更后运行 `bun run routes` 生成 `apps/server/src/router.ts`。

### Python 与 FFmpeg

执行器使用参数数组启动 `python -m whisper`，不拼接 shell 命令。Python 可执行文件由服务端读取已保存的节点插件配置，留空时按宿主环境查找；任务接口不接收可执行文件路径。任务进程的环境变量包含：

- `XDG_CACHE_HOME` 指向 Toonflow 数据目录下的 Whisper 缓存目录，模型不会写入可更新的应用资源。
- `PATH` 以 Toonflow 当前可用的 FFmpeg 所在目录为前缀，满足官方 Whisper 的音频读取要求，并与节点使用同一份 FFmpeg。

任务使用官方 `tiny`、`base`、`small`、`medium`、`large`、`turbo` 模型名。默认模型为 `small`，节点可以为单次任务选择其他模型。首版只做原语言转写，语言字段为空时由 Whisper 自动检测。

## 字幕节点交互与数据流

### `subtitleNode`

节点主体包含当前媒体信息、AI 生成、导入 SRT、导出 SRT 和分段表格。表格每行包含编号、开始时间、结束时间和文本，支持新增、删除和直接编辑。保存前验证时间格式、非负值、`开始 < 结束` 以及分段顺序；序号由序列化器重新编号。

AI 生成流程如下：

1. 读取连接的视频或音频工作区相对路径，并调用 `check` 预检。
2. 调用 `start` 创建任务，节点保存 `operationId` 并轮询 `task`。
3. 服务端把 Whisper CLI 输出的唯一 SRT 结果读入临时内容，校验成功后使用 `writeAtomic` 的排他创建写入本次独立结果文件，不覆盖现有字幕。
4. 节点读取并解析结果，填充分段草稿；用户点击“保存字幕”，或 Agent 明确调用保存工具后，才通过工作区文本快照接口更新 `assets/<nodeId>/subtitle.srt` 和输出端。磁盘修订冲突保留当前草稿并报错。

任务阶段至少包括 `preparing`、`downloadingModel`、`transcribing`、`writing`、`completed`、`failed` 和 `cancelled`。模型下载或转录期间可取消；`writing` 是短暂的不可取消原子提交，取消请求等待其真实结果。节点真正卸载或删除时停止任务；同一项目切换画布仍保留后台节点实例和任务。

导入 SRT 使用文件选择器读取 UTF-8 文本，经同一解析器校验后替换草稿表格；保存后可导出当前已保存的 SRT。没有媒体输入时仍可手动创建分段，AI 按钮保持禁用。

节点注册的工具与按钮共用实现，提供启动转录、查询状态、保存草稿、设置 SRT 和取消任务。长任务立即返回已启动，实际任务及前端状态查询在后台继续，避免现有节点工具 120 秒超时；默认不让 Agent 循环等待。

### `subtitleBurnNode`

节点要求两个有效输入：视频文件和非空、可解析的 SRT 文本。点击烧录后：

1. 在 `assets/<nodeId>` 创建唯一的临时 SRT 和输出路径，避免覆盖源文件。
2. 使用 `useNodeFfmpeg()` 创建命令，视频滤镜采用结构化参数 `subtitles`，文件路径保持在工作区内。
3. 重新编码视频并保留或兼容处理音频，输出 `assets/<nodeId>/<本次唯一目录>/burned.mp4`，重复烧录也不覆盖历史成品。
4. 用 FFprobe 检查输出含有效视频和正时长，再写入视频输出端。

烧录期间显示 FFmpeg 进度和取消按钮。失败时删除未提交的临时目录，源视频和字幕节点内容保持不变。首版不暴露字体、字号、描边或位置配置。

## 配置

`subtitleNode` 的插件配置包含可选的 `pythonPath` 和 `defaultModel`（默认 `small`）。配置为空时执行器按系统查找 Python；配置为绝对路径时只把它作为一个进程参数使用，并在启动前验证可执行。节点可保存单独的模型选择。模型缓存统一位于 Toonflow 数据目录，避免污染工作区和应用资源。

预检返回可读的缺项：Python 不存在、`whisper` 导入失败、PyTorch 版本或设备不可用、FFmpeg 未安装、缓存目录不可写。打开节点不会自动安装依赖；错误信息提供用户需要执行的安装方向，但不会在后台修改 Python 环境。

## 错误处理与恢复

- 所有外部输入用 Zod 校验，路径先解析为当前工作区内的安全路径；禁止协议、上级目录和工作区外输出。
- Python、模型下载、Whisper 非零退出、SRT 解析和 FFmpeg 错误都向上抛出，前端显示实际错误，不伪造成功状态。
- 任务使用唯一临时目录；完成后原子提交 SRT，失败和取消清理临时结果。服务重启后内存任务不存在，节点在查询时显示任务已失效并允许重新生成。
- 当前进程只允许同一 `operationId` 结束一次；取消等待子进程退出后再清理文件，避免迟到的写入覆盖新任务。
- 烧录始终使用新文件名，节点删除前等待运行中的 FFmpeg 结束或取消，保持现有节点生命周期约定。

## 验证计划

实现后按以下顺序验证，不新增测试代码：

1. 在 `apps/server` 执行 `bun run routes`。
2. 执行 `bun run --filter '@toonflow/server' typecheck`、两个新节点包的 `typecheck` 和节点构建。
3. 用当前环境的真实预检确认 Python、Whisper、PyTorch、FFmpeg 状态；当前已知环境是 Python 3.8.5、CPU 版 PyTorch 1.5.1，尚未安装 `openai-whisper`，因此不能把预检失败前的静态构建当作转录成功。
4. 在安装依赖和模型后，用短视频或音频手动执行“预检 → AI 转录 → 表格修改 → 导出 SRT → 烧录 → FFprobe”，检查 SRT 内容、视频时长和源文件未被覆盖。
5. 通过 Agent 查询节点工具并执行同一条转录/烧录链路，确认取消和失败状态可见。

## 验收标准

- 选择一个工作区视频或音频，点击 AI 生成后能得到可编辑的分段 SRT。
- 手动修改、导入和导出 SRT 后，字幕文件内容与表格一致。
- 把视频和字幕连接到 `subtitleBurnNode` 后能生成新 MP4，并能在节点内预览。
- 关闭或取消任务不会留下被当作完成结果的半成品，也不会覆盖源视频。
- Agent 调用与手动操作使用同一套状态、错误和取消语义。

## 已知限制

官方 Whisper 在 Windows + AMD 环境通常回退到 CPU，模型越大速度越慢；当前机器还需要更新或安装与官方 Whisper 兼容的 PyTorch 和 `openai-whisper`。FFmpeg 硬字幕必然重新编码视频，输出耗时和质量取决于源媒体与编码器能力。
