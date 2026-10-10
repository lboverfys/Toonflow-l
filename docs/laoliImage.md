# 老李生图：八个模型接入

接口依据为 2026-10-10 核对的 [正文](https://video.laoliimage2.win/docs/image-api/)、[Markdown 文档](https://video.laoliimage2.win/docs/image-api/image-api.md)、[OpenAPI](https://video.laoliimage2.win/docs/image-api/openapi.json) 与 [模型清单](https://video.laoliimage2.win/docs/image-api/models.json)，版本 `image-upstream-parity-20261009-r1`。本次只调用本机模拟接口，没有消耗真实生图额度。Windows EXE 打包仍是后续任务。

## 使用

1. 打开「设置 → 媒体模型 → 老李生图 → 编辑模型」。
2. 在应用配置中填写 API Key，地址使用 `https://video.laoliimage2.win`，也接受末尾 `/v1`。
3. 在图片生成节点选择下表中的模型，填写提示词，设置分辨率档位和比例。
4. 文生图可以不接参考图；制作角色变体或场景图时，把现有图片节点连入，按需要调整参考顺序。
5. 图片保存到当前项目并回填原节点，可继续用于角色、场景、素材库和视频参考图。

图片与视频供应商分别保存配置，不自动复制或读取另一供应商的密钥。升级后的宿主首次启动会安装内置「老李生图」供应商；仅把适配器 TS 导入未修改的旧版 Toonflow 无法提供持久化任务上下文，调用会在提交前被拒绝。

| 准确模型 ID | 渠道基础价（元/张） |
| --- | --- |
| `gpt-image-2.5` | Flare 超分兼容 ID：1K 0.02、2K 0.03、4K 0.04 |
| `gpt-image-2.5-sr-flare` | 1K 0.02、2K 0.03、4K 0.04 |
| `gpt-image-2.5-sr-sunburst` | 1K 0.02、2K 0.03、4K 0.04 |
| `gpt-image-2.5-flare` | 0.12 |
| `gpt-image-2.5-sunburst` | 0.12 |
| `seedream-v5-pro` | 0.12 |
| `nano-banana-2` | 0.18 |
| `nano-banana-pro` | 0.23 |

实际费用再乘账户倍率，以上为文档标价，不是本次实测账单。所有 ID 原样发送，不把兼容 ID 合并成其他型号。

当前节点每次请求一张，使用 `n=1`。界面提供文档列出的 11 种常用比例及 1K/2K/4K 档位。档位使用 `resolution`，比例使用 `aspect_ratio`，不展开为固定像素 `size`；工具调用显式填写的像素尺寸保留为 `size`，与比例冲突时拒绝提交。选项被接口接受不等于每个上游型号均已实测支持，实际宽高、效果与费用需另行真实验收。

参考图保持原字节、顺序和重复项，转成带实际 MIME 的 Data URL。当前接收预算为单图 25 MiB、合计 32 MiB、序列化 JSON 45 MiB；这些是传输预算，不宣称为模型能力。张数沿用 Toonflow 的 64 张请求上限，不套用视频的 30 张限制。普通生成不转码、不压缩、不强制 PNG，也不补放大；按原图文件头保存扩展名。

## 中断和恢复

- 文生图提交到 `POST /v1/images/generations/async`，参考图编辑提交到 `POST /v1/images/edits/async`。
- 在网络提交之前，保存独立 UUID、原始入口及序列化请求。幂等编号、参数、图片和原密钥身份均固定，恢复不受后来参考图修改或删除影响。
- 回执带 `request_id` 后，只查询 `GET /v1/images/tasks/{request_id}`。保存合法同源 `poll_url`，查询使用原站点的规定路径；不向其他站点转发查询凭据。
- 未收到编号时，按文档允许的方式，使用原入口、原 Key、原 `Idempotency-Key`、原始请求字节确认回执。每次恢复最多发送一次，整个操作最多三次；仍无法确认时保留记录，联系渠道核查，不更换编号或退回同步接口重投。
- `accepted/queued/submitting/processing/reconciling/settling` 都不是完成。只有 `completed` 后的 `result.data[]` 才用于保存；404、超时和未知状态不被当作未生成。
- `error/failed` 为明确失败；`expired` 或 410 表示结果缓存过期，不表示失败或退款。过期后用户主动再次生成会创建新任务并另行计费。
- 「停止本地等待」只中断本地等待，不保证取消订单或费用。重新打开节点会跟踪已有编号，点击恢复会按原参数继续；同节点未完成任务阻止新操作。
- `Retry-After` 和服务端 `retry_after` 的等待期限持久化，快速点击或重启不能绕过。
- 完成回执先保存在项目内，再保存原图。URL 下载失败保留回执；下载完成后把原字节缓存到本地，后续落盘恢复不再依赖临时 URL。只有同源图片下载才附带 Bearer，外部图片 URL 不带渠道密钥，不自动跟随认证重定向。

渠道结果缓存自完成起仅保留 **3 小时**，外部图片 URL 另有有效期。长时间关闭应用可能错过取图期限，请及时恢复。宿主沿用单张输出 100 MiB 上限，不偷偷压缩超限图片。

生成文件位于 `assets/<节点 ID>/`；任务索引、请求原文、完成回执和原图快照位于 `.toonflow/imageTasks/<输出目录摘要>/`。任务文件不保存 API Key，但含提示词和参考素材，应随项目一起保管。完整快照原子写入；同名结果若与原内容不同则停止，保留用户文件。

局部重绘继续使用 Toonflow 的参考引导与本地蒙版合成，严格保留选区外像素，没有假定这些模型都支持原生 mask。其渠道原图保存在节点的 `inpaint/` 子目录，恢复后使用原节点蒙版合成；重绘结果为本地合成 PNG，原始渠道图片另行保留。打光、多角度、全景的生成仍使用现有图片子节点。

## 验证

按任务要求使用 Bun 自带模拟测试，没有新增依赖或测试框架。图片模拟测试覆盖八个型号的文生图和图生图、参数映射、原字节与 MIME、参考顺序、错误脱敏、幂等回执确认、并发阻止、状态区分、下载恢复、文件冲突及真实子进程重启。

```powershell
$taskBun = 'D:\rubbish\zhongjian\envs\toonflow\bun1.3.14\bun-windows-x64\bun.exe'
$env:TEMP = 'D:\rubbish\zhongjian\temp\toonflow\laoliImageIntegration'
$env:TMP = $env:TEMP
$env:BUN_RUNTIME_TRANSPILER_CACHE_PATH = 'D:\rubbish\zhongjian\caches\node\bun\transpiler'
$env:TOONFLOW_TEST_DIR = Join-Path $env:TEMP 'imageTests'
& $taskBun test apps/server/verification/laoliImage.test.ts --timeout 30000
```

本轮图片模拟结果：48 项通过，421 个断言。服务端、供应商、Web 和图片生成节点类型检查通过；服务端、Web、图片节点和媒体工具构建通过。Web 仍有上游已有的体积提示和 Vite 配置加载提示。

通过 Chrome DevTools 在隔离的临时工作区验证了八个模型选项、普通生图的停止与刷新恢复，以及局部重绘的停止与刷新恢复。两次主动生成共两个渠道任务，恢复没有增加 POST；重绘的 8×8 像素样本左侧选区为蓝色，右侧非选区保持原图红色，最终 PNG 已写入画布输出。

此次接入还修复了 Bun 1.3 下已有错误响应处理的正文读取问题：在访问原响应的 `body` 前先复制响应，避免供应商流式读取错误正文时拿到空内容。明确拒绝、限流期限与缓存过期均通过专项检查。

视频回归首轮 61 项通过；共享错误响应修复后的一轮为 60 项通过、1 项续传哈希不一致。异常文件在续传起点的部分字节变成 HTTP 连接头内容，其后针对续传的三轮、共 6 项复测全部通过。根因尚未确认，保留失败样本，不把复测通过当作已修复；本轮未修改视频下载算法。此项需在视频真实验收前继续核查。

本机验收使用 D 盘独立临时目录，测试服务与端口已核查退出，临时 Chrome 页面已关闭。独立 Web 验收环境的设备互联探测曾返回“不支持共享后端”403，图片生成与恢复接口正常；本次未修改设备互联功能。

真实渠道权限、各型号实际出图尺寸、质量和扣费尚未验证；真实生成需先确认内容和费用。
