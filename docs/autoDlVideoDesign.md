# AutoDL 图生视频接入方案

日期：2026-10-13。基线：master / 8b5e447。

2026-10-14 在 master / b636d7e 上增加首尾帧视频，补充方案及本轮验证记录见文末；以下原图生视频接入记录保留。

## 实施步骤

- [x] 补齐 ProviderModel、MediaModel、VideoRequest、MediaGenerationRequest 的 supportsSeed、referenceAudioInput、minReferenceImages、seed，以及视频请求的安全整数校验。
- [x] 视频节点增加 seed 输入、画布持久化、getConfig/setConfig 与生成透传，更新音频上传说明；注册内置供应商源码。
- [x] OSS 支持图片和音频的单次批量预检、上传及缓存；生成入口按模型能力转换音频并透传 seed。
- [x] 实现 AutoDL 配置、参数映射、请求快照、单次提交、可恢复查询及结果下载，注册包公开导出。
- [x] 执行已有相关类型检查、构建和可完成的实际 HTTP 验证；完整生成及 OSS 实测限制见末节。
- [x] 完成独立规格与代码审查，修正上传前缺图校验、提交前链接过期检查及限流等待时间持久化。

## 本次范围

用户已明确先接图生视频，使用示例工作流 `minimax_h3_zm_u08` 的参数协议。工作流 ID 和 Token 必须可配置。音频由画布节点提供，seed 优先使用视频节点的值，节点未填写时回退到供应商默认值。此方案未包含真实 Token。

## 接入方式

推荐新增内置媒体供应商 `autoDl`，复用现有视频生成节点。用户在「设置 → 媒体模型」添加 AutoDL，填写连接配置后，在画布的视频生成节点选择该模型。

另一种方式是仅提供可导入的 `autoDl.ts`，通过现有自定义供应商入口安装；同样可以生成，但不会在内置列表显示。两种方式使用同一份适配器，推荐内置以符合日常操作习惯。

不新建生成节点、服务框架或专属 HTTP 路由。该工作流的参数映射、校验和平台请求留在供应商实现中。

## 配置与输入

| 位置 | 字段 | 行为 |
| --- | --- | --- |
| 供应商设置 | Token（内部沿用 apiKey） | 密码输入，默认空；使用用户给定凭据进行本地配置，真实值不写入源码、方案或日志 |
| 供应商设置 | workflowId | 必填，默认 minimax_h3_zm_u08，可修改；适用于相同参数协议的工作流 |
| 供应商设置 | 默认 seed | 可选整数；仅在视频节点未填写 seed 时使用 |
| 视频节点 | 提示词 | 映射 prompt；1～20000 字符，拒绝纯空白 |
| 视频节点 | 参考图片 | 至少 1 张、最多 9 张，按顺序映射 ref_image_0～8；支持 JPG/PNG/WebP |
| 视频节点 | 参考音频 | 连接音频节点，按引用列表中的音频顺序映射 ref_audio_0～2；可选，最多 3 段，本地素材经 OSS 上传后传 URL |
| 视频节点 | seed | 可选整数，优先于供应商默认 seed；值为 0 时仍覆盖默认值；两处均未填写则不传 seed |
| 视频节点 | 时长 | 整数 1～15 秒；接口缺省 5 秒 |
| 视频节点 | 分辨率、比例 | 480p/768p 与竖向、横向、1:1 映射为平台的 6 个 resolution 枚举；接口缺省 768p竖 |

供应商配置复用现有 `rules` 表单和 `settings.mediaProviderConfigs.autoDl` 持久化，不改设置完整保存的语义。供应商设置不再提供参考音频 URL 字段。模型声明混合参考能力 `["imageReference:9", "audioReference:3"]` 和 `minReferenceImages: 1`，节点与服务端在上传前校验至少有 1 张图片，适配器再次校验；不声明文生视频、参考视频或首尾帧能力。平台未声明的声音、水印开关不发送。

现有视频节点通过 `referenceImageInput: "url"` 显示图片链接输入。本地图片复用「素材存储」中的阿里云 OSS 上传；已有公网链接可直接使用。保持先本地图片、再手填链接的顺序，首张为必填的 ref_image_0。现有提示语“没有图片和链接时为文生视频”须移除或按模型能力显示，避免误导此工作流。

### 节点音频与上传

视频节点已有 `AUDIO` 引用和 `audios` 请求字段，直接沿用。用户连接音频节点，按参考列表排序、移除；未连接音频时不发送 ref_audio 字段。超过 3 段或引用节点尚未产出音频时，在提交任务前报错，不静默截断。

AutoDL 只接受素材 URL，公开文档没有素材上传接口。因此在现有 `uploadOssReferences` 中补充音频支持，复用 OSS 配置、签名、内容哈希缓存和错误处理，不另建上传服务。通过模型能力 `referenceAudioInput: "url"` 标记需要上传的音频，仅对声明该能力的模型转换音频输入。

上传前按实际媒体类型校验格式：MP3、WAV、FLAC、MP4 音频容器。视频节点已有“提取音轨”功能会生成音频节点，带画面的 MP4 可沿用此入口提供音频，不把参考视频连线当作音频。此处的 MP4 是音频参考素材格式，不增加参考视频能力。

沿用现有 OSS 传输预算：待上传的单个本地素材不超过 20 MiB，同次生成待上传的图片与音频合计不超过 300 MiB；这是宿主上传预算，不宣称为 AutoDL 的平台上限。读取、上传前统一校验数量、格式和大小。已有图片模型仍沿用原图片校验。使用本地音频时即使图片来自公网链接，也必须读取并启用 OSS 配置。任一上传失败则停止，不提交视频任务。

### seed 的优先级与保存

视频节点的生成设置增加可选 seed 输入，按模型 `supportsSeed` 能力显示；供应商设置保留默认 seed。节点 seed 随画布节点数据保存，不加入跨节点的全局生成偏好。

取值顺序固定为：节点 seed → 供应商默认 seed → 不发送 seed，由平台使用缺省行为。只将未填写视为缺省，不能通过真假判断丢掉 0；非整数或超出 JavaScript 安全整数范围的输入报错，不回退默认值。清空节点输入即恢复使用供应商默认值。

公共视频请求增加可选 `seed` 字段，贯通节点、请求类型、Zod 校验、后端与供应商 `VideoRequest`；节点的 `getConfig`、`setConfig` 同步支持读取、设置和清空 seed。`setConfig` 中省略 seed 表示不修改，传 null 表示清空；对外生成请求在清空后省略 seed。生成中或存在待恢复任务时，seed 与其他生成参数一样不可修改。

供应商在首次提交前解析并保存最终采用的 seed；请求快照同时保存工作流 ID、图片及音频 URL。任务恢复不重新读取节点音频，也不重新采用后来修改的节点或供应商 seed。

工作流 ID 可配置不代表任意工作流自动兼容。若替换为不同输入结构的工作流，需另行适配其参数和模型能力。

## 请求与任务处理

官方文档：https://autodl.art/docs/comfyui_api/

1. 服务端读取配置和节点参数，校验参数，按需上传本地图片与音频并得到 URL，按优先级确定最终 seed。
2. 使用宿主 `this.videoTask.saveRequest` 保存首次工作流 ID 与实际请求体快照，包含图片、音频 URL 和最终 seed，不保存 Token。恢复时沿用快照，配置或节点变化不改变已开始的任务。
3. 向 `POST https://autodl.art/api/v1/comfyui/comfyui_workflow/{workflow_id}` 提交 JSON。`Authorization` 直接为 Token，不加 Bearer。拒绝把凭据发送到重定向目标。
4. 检查 HTTP 状态、业务 code 和 data.task_id，持久化 task_id。
5. 用 `GET https://autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}` 查询原任务，核对返回的任务编号。轮询遵守取消信号、请求超时及有限等待。
6. 状态不区分大小写；兼容文档的 SUCCESS 与用户示例的 completed。QUEUED、RUNNING 映射宿主任务状态；FAILED 等明确失败停止查询并显示脱敏错误。未知状态不当作成功。
7. 从 results 中获取最终输出视频，调用 `this.videoTask.download` 立即保存 MP4。下载公开结果 URL 时不附带 AutoDL Token，复用断点续传和文件完整性校验。
8. 返回现有视频节点结果，继续沿用预览、历史和下游节点连接。

平台公开文档未声明幂等提交或丢失回执找回机制。提交后网络中断且未取得任务 ID 时，不自动重复 POST；保留本地操作并报告受理状态未确认。已有任务 ID 时，停止等待或下载失败后只恢复同一任务，不重新生成。

首次提交或恢复尚未提交的请求时，先检查快照中 OSS 图片及音频链接的期限；已过期或不足 60 秒时标记失败，不 POST，用户重新生成获取新链接。查询收到限流或服务端错误时，保存退避时间，手动恢复也遵守该时间。

## 代码改动

- 新增 `packages/providers/src/media/autoDl.ts`：配置、能力、映射、校验、提交、轮询和下载。
- 修改 `packages/providers/index.ts`：注册供应商。
- 修改 `packages/providers/package.json`：声明公开导出。
- 修改 `apps/web/src/components/settings/panels/mediaModel/addCustomProviderDialog.vue`：注册内置供应商 raw 源码。
- 修改 `apps/web/src/components/settings/panels/mediaStorage.vue`：说明图片与音频上传格式、数量和传输预算。
- 修改 `packages/nodes/videoGenerationNode/src/index.vue` 与 `src/components/generationSettings.vue`：节点 seed 输入、保存和透传，节点工具读取及修改 seed，更新参考图与音频上传说明。
- 修改 `packages/providers/types.d.ts` 与 `packages/toolScaffold/src/runtime.ts`：补充 seed、音频 URL 输入能力及 seed 能力声明；供应商和宿主类型保持一致。
- 修改 `packages/tools/mediaGeneration/src/runtime.ts`：视频 seed 入参校验；既有 audios 字段继续复用。
- 修改 `packages/tools/mediaGeneration/src/index.ts`：媒体生成工具说明同步 seed 及本地音频上传规则。
- 修改 `apps/server/src/utils/media/generation.ts`：返回模型能力，透传 seed，按声明的音频 URL 能力复用 OSS 转换音频。
- 修改 `apps/server/src/utils/media/oss.ts`：现有上传函数支持音频，并在签名缓存及上传路径中保留正确的媒体类型和扩展名。
- 将原生成模块的文件头 MIME 识别移至 `apps/server/src/utils/media/mimeType.ts`，供生成模块和音频上传复用。

不增加通用工作流编辑器，不新增上传服务、依赖或测试模块。AutoDL 参数映射留在供应商中；共享请求类型只补充通用能力，不将平台业务逻辑放入节点脚手架。

## 验证与当前状态

运行时为 Bun 1.3.14，已完成以下检查：

- `apps/server`、`apps/web`、`packages/nodes/videoGenerationNode`、`packages/tools/mediaGeneration`、`packages/toolScaffold` 的既有 `bun run typecheck` 通过。
- server、web、视频生成节点的既有 `bun run build` 通过。Web 构建仍有大包体和未来 Vite 配置加载方式的提示，无构建错误。
- 临时配置目录中的实际 HTTP 验证：供应商自动安装和模型能力读取；设置保存及读取；非法设置返回 400；非整数 seed 返回 400；无图且有音频在上传前被拦截；有音频但缺 OSS 时明确报错。
- 一次实际的 1 秒、480p 生成提交：节点 seed 为 0、供应商默认值为 42，保存的真实请求快照采用 0，工作流与分辨率映射正确。AutoDL 返回 HTTP 403、`Insufficient account balance`；任务标记失败。随后恢复该失败任务返回 409，不重新提交。
- 独立规格审查和代码审查完成；没有新增测试、自检文件、mock、fixture 或测试专用导出。

限制：账户余额不足，未取得真实视频，因此成功轮询、成片下载及生成中断后的恢复未做端到端实测。用户确认没有 OSS 配置，本地音频上传未做云端实测。上述行为经过类型检查和代码审查，不能表述为实际生成已通过。

Token 和默认工作流通过既有设置接口保存到本地数据目录；默认 seed 留空。数据目录被 Git 忽略，源码和文档不含真实凭据。恢复真实生成需补足 AutoDL 余额；使用本地图片或节点音频还需启用 OSS。

## 2026-10-14：H3 首尾帧视频

在原 AutoDL 供应商下新增 `minimaxH3FirstLastFrame` 模型，显示为「MiniMax H3 首尾帧视频」。Token 和默认 seed 共用，新增 `firstLastWorkflowId` 配置，默认 `minimax_h3_lightx2v`；原 `workflowId` 继续供 `minimaxH3` 图生视频使用。

视频节点使用已有首尾帧模式和链接输入：先按图片节点的引用顺序，再按 HTTPS 直链的行顺序，合计恰好两张，依次作为首帧和尾帧。支持两个图片节点、两条直链或一张本地图片加一条直链。本地图片通过现有 OSS 上传；仅用直链不需要 OSS。不能混入额外图片、音频或视频。

公共生成请求的 `firstFrame`、`lastFrame` 分别接受工作区图片 `{ path, mimeType }` 或直链 `{ url }`，不混用两种对象结构。URL 必须为不含账号密码及片段的 HTTPS 地址。服务端仅向声明 `referenceImageInput: "url"` 的模型开放帧直链，并将本地帧纳入原有 OSS 单文件 20 MiB、同次合计 300 MiB 的预检与批量上传。

供应商将两张图片映射到 `first_frame`、`last_frame`。提示词、seed 优先级、时长与分辨率转换沿用原实现。API 缺省为 5 秒、768p竖；新模型通过 `defaultDuration`、`defaultResolution` 声明默认值，视频节点和 Agent 的 `setConfig` 在没有有效既有设置时采用 5 秒、768p，保留用户已选的有效值。时长支持 1～15 秒，分辨率支持 480p/768p，比例支持 9:16、16:9、1:1。

首次请求快照保存实际工作流、首尾帧 URL 和最终 seed；恢复沿用快照，不重新读取图片或换用新配置。提交前的 OSS 链接期限检查同时覆盖首帧和尾帧。轮询、受理不明时禁止重复提交及 MP4 下载保存均复用原链路。

内置供应商由 1.0.0 升级时补入首尾帧模型，保留原模型及供应商名称；新版本下主动删除的模型不会反复补入。配置默认值由原 rules 合并逻辑提供，无需改写已有 Token 或工作流设置。不新增依赖、路由、测试模块或专属生成节点。

本轮已通过临时应用服务手动核对：旧供应商升级后的两个模型、缺帧和非法 URL 校验、额外音频拒绝、缺 OSS 时本地图片报错、首尾帧字段映射、节点 seed=0 覆盖默认值、缺省 seed 回退、独立工作流配置、默认 5 秒/768p竖，以及原图生视频请求仍使用原工作流和 ref_image 字段。过期 OSS 首帧、尾帧都在提交前拦截，失败任务恢复返回 409。

最终代码使用 Bun 1.4.0 完成 server、web、视频节点、媒体生成工具、工具脚手架五个包的现有类型检查，以及 server、web、视频节点的现有构建，均通过。Web 构建有大包体提示；代码复审无剩余阻塞问题。没有新增测试或自检文件。

用户本轮没有提供两张图片链接，选择先完成可做的验证。本轮没有向 AutoDL 提交真实生成任务；完整视频生成、成功轮询、成片下载和 OSS 云端上传仍未实测，不能由类型检查或构建结果推断其通过。
