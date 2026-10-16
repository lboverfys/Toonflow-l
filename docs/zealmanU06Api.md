# ZEALMAN U06 页面接口与 Toonflow 对照

调查日期：2026-10-16。目标页面：**MINIMAX-H3 Light2V加速 多参极速创作台 / U06**，面板版本 `v2026.10.15.1150`。

## 结论与证据范围

U06 快捷生成可以直接通过 HTTP 调用。网页将用户选择写进完整 ComfyUI 工作流，再提交 `workflow_template`；不是仅发送「API 生成」页开放的少量 `input_values`。因此主模型、CLIP、LoRA、步数、种子、分辨率和显存相关开关都能随工作流提交。

本次用独立浏览器会话实际打开了快捷生成、U06、Skill 设置，并读取页面加载的 JavaScript、默认目录和工作流模板。用户原有标签页未修改。提交与上传格式来自页面实际加载的提交函数及接口说明，**不是一次成功生成的网络抓包**。

远端健康接口正常，但 GPU 接口返回 `hasGPU: false`、`detectFailed: true`，错误是 `/usr/bin/nvidia-smi: Permission denied`；ComfyUI 状态为 `running: false`、`process_not_found`，页面生成按钮显示「无卡模式不可运行」。本次未启动 ComfyUI、上传用户素材、调用付费文本模型或提交生成任务。

## 请求链路

以下路径都相对于供应商中配置的面板地址。地址应使用面板入口，不应填写 ComfyUI 自身端口或重复添加 `/api`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 面板存活状态 |
| GET | `/api/gpu/info` | GPU 是否可用 |
| GET | `/api/comfy/status` | ComfyUI 是否运行 |
| GET | `/api/gpu/rtx-upscale` | RTX 放大能力与不可用原因 |
| GET | `/u-series-defaults.json` | 模型、CLIP、LoRA 目录与默认参数 |
| GET | `/U06-minimax_h3_lightX2v多图参考生视频V5.json` | U06 完整 API 格式工作流，实际请求时编码中文路径 |
| GET | `/api/voices` | 内置音色目录 |
| POST | `/api/comfy/upload/file` | 上传图片、视频、音频 |
| POST | `/api/workflow/generate` | 提交完整工作流，取得 `prompt_id` |
| GET | `/api/workflow/result?prompt_id=...` | 轮询结果 |
| GET | `/api/tasks/{prompt_id}` | 查询任务账本与进度 |
| GET | `/api/comfy/view?filename=...&subfolder=...&type=input` | 预览输入素材 |
| GET | `/output/{subfolder}/{filename}` | 下载生成结果，使用接口返回的真实路径 |

### 1. 上传素材

`POST /api/comfy/upload/file` 使用 `FormData`：

| 字段 | 内容 |
| --- | --- |
| `file` | 二进制文件，包含文件名与 MIME 类型 |
| `overwrite` | 字符串 `"false"` 或 `"true"` |

让 HTTP 客户端生成 multipart boundary，不手工固定 `Content-Type`。网页上传函数默认覆盖；Toonflow 已使用独立文件名和 `overwrite=false`，避免覆盖其他素材。

接口说明中的返回形状为：

```json
{ "name": "reference.png", "subfolder": "", "type": "input" }
```

将返回的 `subfolder/name` 写入工作流的 LoadImage、LoadAudio 或 VHS_LoadVideo 节点。不可将 Toonflow 的本地磁盘路径直接交给远端机器。

### 2. 提交 U06

页面实际请求结构如下；`workflowGraph` 表示已经填好参数和参考素材的完整工作流对象：

```ts
const body = {
  source: "quick",
  workflow_template: workflowGraph,
  client_id: clientId,
};
```

`POST /api/workflow/generate`，JSON 请求体。页面的队列路径还可以附带 `prompt_id`，但本次没有验证该字段的幂等保证。

成功回执需要检查 `success === true` 和非空 `prompt_id`。U06 使用这种方式无需在 API 页另存 `API-U06`，也不受 `api_config.enabledParams` 的开放字段限制。

### 3. 查询与保存

轮询 `/api/workflow/result?prompt_id=...`，结束后读取 `results` 中 `type: "video"` 的 `url`。相对 URL 使用同一面板地址解析，并及时保存成片。面板接口说明指出：ComfyUI 重启后 history 可能丢失，`pending=true` 也可能表示旧编号已不存在，不能仅靠该字段无限等待。

Toonflow 已同时查询任务账本、保存提交快照，并按原任务恢复。提交超时或回执丢失时不能直接重发，避免重复生成。

显存释放是独立请求：`POST /api/comfy/proxy/free`，JSON 为 `{ "unload_models": true, "free_memory": true }`。现有适配只在队列确认为空时调用；不应在其他任务运行时强制释放。

## U06 参数映射

这些节点编号属于本次读取的 V5 模板，升级面板后必须重新核对类型和连线。

| 网页参数 | 工作流字段或处理 | 当前 Toonflow |
| --- | --- | --- |
| 提示词 | `664.inputs.prompt` | 已接入 |
| 时长 | `132.inputs.value` | 已接入，当前面板上限 30 秒 |
| 画面比例、像素规模 | `665.inputs.aspect_ratio / megapixels / multiple` | 已接入，32 对齐 |
| 主模型 | `620.inputs.unet_name` | 已接入，目录从面板读取 |
| CLIP | `128.inputs.clip_name` | 已接入 |
| 原版／加速 | `718.inputs.select`：1／2 | 已接入；当前默认步数 20／8 |
| 加速 LoRA、强度 | `710.inputs.lora_name / strength_model` | 已接入，并校验兼容性 |
| 额外 LoRA、强度 | 在 718 后插入 `LoraLoaderModelOnly` 并调整连线 | 已接入 |
| 采样步数 | `728.inputs.steps` | 已接入 |
| 随机／固定种子 | `142.inputs.seed` | 已接入 |
| RTX 2 倍放大 | 保留或旁路 668 节点 | 已接入，按机器能力限制 |
| VAE 前清理 | 在解码输入前插入 `VRAMCleanup` | 已接入 |
| 9 张图片 | LoadImage：137、139、144、151、653–657 | 已接入，允许直接上传 |
| 3 段视频 | VHS_LoadVideo：638、659、660 | 已接入，保留缩放和取帧链路 |
| 3 段音频／内置音色 | LoadAudio：719、720、721 | 已接入，与内置音色合计最多 3 段 |
| 参考槽位 | `136.inputs.ref_images.* / ref_videos.* / ref_audios.*` | 已接入，删除未使用槽位和对应输入节点 |
| 多图尺寸策略 | 图片超过 2 张时 `ref_image_size=match`，否则 `max` | 与当前网页一致 |
| 串行队列 | 网页独立队列逻辑 | 节点已有快照队列，当前面板上限 50 |

本次目录返回 26 个 ref2va 模型、5 个 CLIP、45 个 LoRA。目录中列出不等于机器已安装、显存足够或可以生成。

## Skill 优化协议与差异

网页先用 AI 改写提示词，再把结果填回编辑器；它并非每次点击生成都自动调用 AI。

`GET /api/autodl/h3-skill-prompts` 返回 `fullReference`、`keyframeFl2va`、`keyframeI2va`、`keyframeT2va`。U06 使用 `fullReference`。

网页的 API 优化请求是 `POST /api/autodl/h3-reference-prompt`，字段包括：

| 字段 | 含义 |
| --- | --- |
| `apiKey`、`model` | 网页选择的上游文本模型凭证与名称 |
| `userPrompt` | 原提示词 |
| `durationSeconds`、`maxDurationSeconds` | 当前时长与上限 |
| `outputChinese` | 是否输出中文叙述 |
| `promptMode`、`keyframeMode` | 素材模式，U06 为多参考路径 |
| `systemPrompt` | 当前 Skill 系统提示词 |
| `assets` | 素材的 `kind/name/subjectName/token` |
| `images` | 参考图的 `token/subjectName/base64` |

网页读取成功返回的 `prompt`、`warnings` 和 `suggestedDurationSeconds`。图片会参与视觉理解；视频和音频作为文字标签输入。

网页本机 QWEN3.8 路径改为提交 `/api/workflow/generate`，使用 `source: "skill"`、工作流 `U00-minimax_h3提示词QWEN3.8群主版`、`workflow_template` 与 `input_values`，再轮询文本结果。它依赖远端 ComfyUI 和 GPU，且会与视频生成争用资源。

| 能力 | 网页 | 当前 Toonflow 源码 |
| --- | --- | --- |
| 点击 Skill 按钮优化并回填 | 有 | 已有，复用 Toonflow 配置的文本模型 |
| 参考图片理解 | 有 | 已有，取决于所选文本模型是否支持图像 |
| 主体、对白、六段骨架、撤销 | 有 | 已有 |
| 中文叙述开关 | 有 | 尚无，内置 Skill 默认英文叙述、对白保留原语言 |
| 页面中编辑 Skill | 有 | 当前只读查看内置 Skill |
| 本机 QWEN3.8 优化 | 有 | 当前没有该专用路径 |
| 点击生成前自动优化 | 当前网页是分开点击 | 当前节点也是分开点击 |

本次远端 `fullReference` 与本地 `h3PromptSkill.txt` 的主体内容一致；本地额外增加了音色参考句原样保留规则。不要直接用远端文本覆盖本地增强。

## 推荐集成方式

用户已确认交互流程：上传素材 → 点击「Skill 优化提示词」→ 查看和修改结果 → 点击生成视频。当前节点已按此方式实现，提示词优化由用户单独触发。

保留当前 U06 完整工作流提交方式、素材上传和 Toonflow 文本模型入口。无需再建一套节点或要求用户在网页保存 API 参数。本次确认范围由现有流程覆盖，后续在 GPU 可用时验证上传、优化回填和出片的完整链路。

网页本机 QWEN 路径是可选的另一方案，但依赖同一台 GPU；将 API 优化再代理到网页则会增加一层凭证与上游耦合。用户已有文本模型时，直接复用 Toonflow 的模型选择最少改动。

现有入口：

- `packages/nodes/videoGenerationNode/src/index.vue`：上传、设置、生成与队列。
- `packages/nodes/videoGenerationNode/src/components/h3PromptEditor.vue`：文本模型选择、Skill 优化、主体与对白。
- `packages/nodes/videoGenerationNode/src/h3PromptSkill.txt`：内置 Skill。
- `packages/nodes/videoGenerationNode/src/components/zealmanSettings.vue`：U06 高级参数。
- `packages/providers/src/media/zealmanH3.ts`：目录读取、上传、工作流构造、提交和轮询。
- `packages/nodes/videoGenerationNode/readme.md`：现有操作步骤。

下一步实际出片验证需要先恢复该实例的 GPU 可访问状态，并启动 ComfyUI；仅启动进程不能解决 `nvidia-smi` 权限问题。本次没有验证真实素材上传、文本模型调用、生成成功或成片下载。
