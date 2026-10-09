# 老李视频特价 2.5 接入与验收

本次接入基于 Toonflow 上游 `2c7fb257affb65777110fe4c6e60cd3c09187d9b`。接口依据为 2026-10-09 发布的 v1.39.7 [说明](https://video.laoliimage2.win/docs/video-api/)、[请求 Schema](https://video.laoliimage2.win/docs/video-api/request.schema.json)和[特价型号示例](https://video.laoliimage2.win/docs/video-api/examples/request-classic35.json)。

已完成代码接入和本地模拟验证。真实账户权限、账户倍率、真实成片效果尚未验证；没有调用付费生成接口。Windows 安装包及安装后的验证仍是下一阶段。

## 在界面中配置

1. 打开「设置 → 媒体模型」。
2. 找到「老李视频」，点击「编辑模型」。
3. 在 API Key 输入框中填写密钥。不要把密钥写进代码、提示词、命令行或截图。
4. API 地址填写 `https://video.laoliimage2.win`，保存。
5. 在画布的视频生成节点选择「特价 2.5 · 16～30 秒 · 720p」。
6. 填写提示词，将需要的角色图、场景图作为图片参考接入节点，核对顺序、比例和时长。

实际提交的型号严格使用 `特价2.5需要过人脸技术-可参考过人脸素材库`。界面显示的简称不会替代 API 模型 ID。

| 项目 | 支持范围 |
| --- | --- |
| 时长 | 16～30 秒，每个整数秒均可选 |
| 分辨率 | 720p |
| 参考素材 | 0～30 张 PNG、JPEG、WebP 原图，保留顺序和重复图片 |
| 图片体积 | 单张不超过 50 MiB，合计不超过 70 MiB |
| 提示词 | 1～15000 个 Unicode 字符；提交快照保留原文 |
| 请求字段 | `model`、`prompt`、`duration`、`resolution`、`ratio`、`images` |
| 价格 | 基础 2 元/条，再乘账户或分组倍率；本地不会推断实际扣费或退款 |

不提供参考视频、参考音频、首尾帧模式或人脸开关。不发送全参型号的 `seconds`、`aspect_ratio`、`references`。普通图片链接会先读取原始字节，再编码为 Base64；画布图片直接复用工作区读取能力，不压缩或重排原图。

比例沿用 Toonflow 的通用选项。API 的 Schema 未声明固定比例枚举，具体可用性仍需由渠道校验，不能把界面选项视作渠道全部实测通过。

## 生成、恢复和交付

每次新生成使用独立 UUID 作为 `Idempotency-Key`。先保存操作记录和首次序列化的请求字节，再向 `POST /v1/videos` 提交；收到 `id` 或 `task_id` 后保存任务编号。相同操作的重试复用同一密钥身份、幂等键和原始请求字节。

- 有任务编号后，只执行原任务的查询和下载，不再创建任务。
- 创建回执不明确时，单次恢复最多确认三次；仍不能确认则保留记录，停止自动确认，不换键补发。
- 相同节点的未完成操作会阻止新操作；不同节点的主动生成仍分别创建任务。
- 查询失败、断网、关闭页面或应用，不会被当作中转站任务失败。
- 「停止本地等待」中断本地请求，不承诺撤销中转站任务或费用。
- 重新打开节点后，会继续跟踪或恢复已有编号的任务；没有取得编号的操作可点击箭头确认原提交。
- 恢复使用首次保存的参数和图片，不重新读取后来修改或删除的参考图。恢复期间不要更换渠道地址或密钥。
- 明确失败后保留失败原因；重新点击生成才会创建新操作。幂等冲突需要核查原记录，不能自动换键重发。

下载使用带 Bearer 认证的 `/v1/videos/{id}/download`，拒绝自动重定向。只有原片标记、媒体类型、已声明的长度和 MP4 容器完整性检查通过，文件实际保存后，才显示「原片已保存」。中转站返回的其他下载域名不会用于转发密钥。

下载保留 `.part` 文件。有 ETag 或 Last-Modified 时使用 Range / If-Range 恢复；返回 206 时核对偏移和完整长度，返回 200 时从头写入，不追加重复内容。416 会重置失效断点，下次恢复从头下载原任务。下载错误不触发新生成。沿用 Toonflow 单个生成文件最多 **100 MiB** 的限制。

节点结果保存在项目的 `assets/<节点 ID>/`，继续使用现有视频播放、历史记录和素材库。恢复记录保存在同一项目的 `.toonflow/videoTasks/<节点目录摘要>/`，包含操作记录、首次请求和下载断点，不包含 API Key。备份或迁移未完成项目时应一并保留这个目录。

## 实现范围

渠道协议独立放在 `packages/providers/src/media/laoliVideo.ts`。宿主只增加了视频任务持久化上下文、读取/恢复接口及视频节点的状态跟踪。已有供应商默认沿用原流程。

由于上游的供应商接口仅返回最终媒体，不提供持久化任务上下文，单独导入这个 TS 文件到未修改的旧版 Toonflow，无法获得完整恢复能力；适配器会在提交前明确拒绝无持久化上下文的调用。请使用本次修改后的宿主。

## 本地验证

按任务明确要求添加了模拟测试，使用 Bun 自带测试能力，没有新增测试框架或依赖。模拟接口仅监听本机随机端口，使用测试密钥，结束后关闭。测试覆盖真实子进程退出、同键重放、参数/图片限制、认证下载、断点续传、失败恢复和重复提交保护。

测试需要预先准备一份可正常播放的 MP4，测试命令本身不下载素材。例如本次使用 MDN 的公开 CC0 花朵视频；它只是模拟接口的返回数据，不代表模型生成的内容或时长。

在仓库根目录的 PowerShell 中运行，按本机已有路径设置 Bun 和临时目录：

```powershell
$taskBun = 'D:\rubbish\zhongjian\envs\toonflow\bun1.3.14\bun-windows-x64\bun.exe'
$env:TEMP = 'D:\rubbish\zhongjian\temp\toonflow\laoliIntegration'
$env:TMP = $env:TEMP
$env:BUN_RUNTIME_TRANSPILER_CACHE_PATH = 'D:\rubbish\zhongjian\caches\node\bun\transpiler'
$env:TOONFLOW_TEST_DIR = Join-Path $env:TEMP 'testRuns'
$env:TOONFLOW_TEST_VIDEO = Join-Path $env:TEMP 'sample.mp4'
& $taskBun test apps/server/verification/laoliVideo.test.ts --timeout 15000
```

本次还在构建后的 Web 与 Server 中，通过 Chrome DevTools 验证了供应商配置保存、时长列表、真实进度显示、停止等待、页面刷新后跟踪原任务、视频回填及播放。两次主动生成对应两个独立操作，恢复和刷新没有增加生成数。

最终模拟检查为 **40 项通过、0 项失败**。服务端、Web、供应商和视频节点类型检查通过；插件、Web 和 Server 构建通过。Web 构建存在上游已有的大文件块提示。浏览器中的 `/api/connection/connection` 404 是独立 Web 模式的设备连接探测，现有前端会识别并停用该探测，不是视频接口失败。

构建使用项目现有命令，产物位于仓库的 `build/`，运行数据位于 `data/` 或显式传入的任务临时数据目录。桌面 SDK 准备完成后可运行服务端和视频节点的类型检查。开发模式前后端可分别运行 `bun run dev:server` 和 `bun run dev:web`；本机验证结束后应关闭对应进程。

## 本机再次打开验收界面

当前已构建的源码预览可以直接运行，无需重新安装依赖。在 `D:\learning-continuing\toonflow` 打开 PowerShell：

```powershell
$env:TEMP = 'D:\rubbish\zhongjian\temp\toonflow\laoliIntegration'
$env:TMP = $env:TEMP
$env:BUN_RUNTIME_TRANSPILER_CACHE_PATH = 'D:\rubbish\zhongjian\caches\node\bun\transpiler'
& 'D:\rubbish\zhongjian\envs\toonflow\bun1.3.14\bun-windows-x64\bun.exe' build/server/index.js
```

然后打开 `http://localhost:3000`。在设置中填写老李密钥前不会调用该渠道；填写密钥后点击生成属于真实付费操作。使用结束后在这个终端按 `Ctrl+C`。如果 3000 已被其他程序占用，应先确认占用者，不能直接结束其他进程。

这是当前阶段的源码验收入口。最终桌面应用会自动管理本地服务，安装包尚未制作。

## 首次真实验收

先核对账户可用型号和实际倍率，再确认要生成的内容与费用。建议第一条采用 16 秒、单角色、单场景。图片可先从外部导入；自动写剧本、生成角色图或场景图需要其他模型服务，本次没有额外接入或采购。
