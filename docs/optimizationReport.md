# 优化方案执行汇总

日期：2026-10-14。方案来源：`D:\learning-continuing\toonflowOptimizationPlan.md`。基线：`lboverfys` / `8f31517`。改动分支为 `codex/optimizationPlan`。本文记录开发验证结果，提交及推送状态以 Git 记录为准。

31 项均已处理到明确状态：26 项已实现，T23 完成性能分析并保留现有算法，3 项部分完成，T31 仅完成设计。这里的“已实现”表示相应代码已落地，不代表每项人工验收均已完成。本文已纳入用户指出 FFmpeg 已安装、Chrome DevTools MCP 恢复可用后的补充工作。

## 主要结果

| 指标 | 基线 | 当前 | 测量口径 |
| --- | ---: | ---: | --- |
| Web 入口及预加载 JavaScript | 7,208,200 字节 | 833,188 字节 | 构建 HTML 直接引用的入口及 modulepreload，当前共 34 个脚本，减少 88.44%。未计 CSS、字体、后续动态加载，也不是浏览器网络录制。 |
| 独立构建耗时 | 37.586 秒 | 22.920 秒 | 同一环境的串行、并行各一次测量；用于观察本次变化，不是稳定性能基准。 |
| 8 个节点插件总大小 | — | 合计约减少 0.71 MB | 外置 Zod 前后近似比较；分析构建带 sourcemap 引用，存在少量构建标记差异。未扣除宿主共享 Zod 的体积。 |
| 五画布切换平均耗时 | 121.56 ms | 85.11 ms | 同一页面交替启停后台 content-visibility，各 10 次；含切换保存与两个动画帧，减少约 30%。单次本机对照，不代表所有项目。 |

## 逐项状态

| 编号 | 状态 | 实际结果 |
| --- | --- | --- |
| T01 | 已实现 | 删除 CORS 与 urlencoded，全局校验 Origin；经设备互联网关认证的请求保留原通道。 |
| T02 | 已实现 | 独立 server 默认监听 127.0.0.1，地址、端口、Host 白名单可配置；处理监听失败及 MCP 初始化失败。Docker 与开发文档同步。 |
| T03 | 已实现 | 供应商执行、保存和节点管理接口限制本机请求，补齐前端工作区请求头。 |
| T04 | 已实现 | 拆分无词条核心，20 种非简体中文词条及 Element Plus、dayjs 语言按需加载；处理切换竞态与加载失败。服务端保留全量词条入口。 |
| T05 | 已实现 | 拆出轻量模型缓存入口，FFmpeg 提示面板异步加载，TDesign provider 放到实际使用区域。实测修复 provider 包裹根节点使 v-show 失效、两个对话同时显示的回归。 |
| T06 | 已实现 | 删除画布多余的 flowData v-model，远端节点类型直接从当前节点读取。 |
| T07 | 已实现 | 原子写入在替换前执行文件 sync/fsync；保留独占创建、错误传播和原文件权限行为。 |
| T08 | 已实现 | 缓存设备互联、MCP 和语言回退配置，配置变化时失效；设备配置避免原地修改。 |
| T09 | 已实现 | compshare 使用 Buffer 处理 Base64；轮询等待正常结束时移除取消监听。 |
| T10 | 已实现 | 修改本次扫描发现的组件短横线属性与事件，统一小驼峰，并修正事件回调类型。 |
| T11 | 已实现 | 删除画布同步中不跨 await 的重复全量比较，保存传递 dirty 结果，减少重复克隆；保留独立基线及跨 await 冲突校验。多人实测发现并修复已有的文本运行态输出被远端重命名清空问题，只应用持久字段的实际变化。 |
| T12 | 已实现首阶段 | 增加统一 Axios 实例，迁移设置 Store、语言模型列表、媒体模型列表三处。保留工作区文件专用入口，未全仓迁移。 |
| T13 | 部分完成 | webFetch 默认拒绝内网并固定已校验 IP；browser 对 HTTP 请求做 DNS 检查。浏览器重绑定及其他旁路风险尚未完整封闭，未完成浏览器实测。 |
| T14 | 已实现 | 工具增加原始参数、滤镜允许列表和路径校验，输入限制协议；配对设备禁止原始参数与滤镜。已使用安装的 FFmpeg 6.1.1 完成裁剪、拼接、转码、字幕及 FFprobe 实测，修复默认探测传入 index: undefined 导致 Invalid input index 的回归。媒体内部间接 I/O 仍非沙箱。 |
| T15 | 已实现 | 完成节点 sourcemap 体积分析，仅外置 Zod；旧宿主缺少能力时明确报错。Three addons 分析后保留各插件打包，避免引入大量宿主子路径契约。 |
| T16 | 已实现 | 临时对话、A2A 等待输入上下文空闲 30 分钟回收，执行中的任务保留；浏览器无会话 1 分钟后关闭。已验证会话关闭及 404，未实等全部空闲周期。 |
| T17 | 已实现 | 剪贴板使用统一文件入口，文件及直接图片读取受累计 100 MB 上限约束。 |
| T18 | 已实现 | 默认 JSON 上限 10 MB，需要大载荷的接口保留 100 MB；带哈希静态资源缓存一年，HTML 保持及时更新。 |
| T19 | 已实现 | 路由复用 localOnly；本机 socket、Host 和完整同源判断复用公共逻辑，保留各网关必要差异。 |
| T20 | 已实现 | 独立构建的插件组最多并行 4 个任务且不超过可用 CPU 数，失败收集日志；Docker 增加 BuildKit 依赖缓存。Docker 未在本机执行。 |
| T21 | 已实现 | CI 增加全仓类型检查与依赖缓存；六类第三方 Action 固定为官方仓库核实的提交 SHA。未触发远程 CI。 |
| T22 | 部分完成 | Android 发布构建接入专用签名、轮换 lineage、Secrets 和凭据清理；缺少真实密钥、lineage、SDK 和真机，未签发发布 APK，未完成升级验证。 |
| T23 | 已完成分析 | 在 217 个文本节点上录制拖动、批量移动与远端改名，填满 100 步结构历史并验证撤销重做。拖动 INP 为 31 ms，最终多画布状态下另一次为 49 ms；未测出应改写深监听和历史合并的直接依据，保留现有算法，修复同步导致节点崩溃的根因。 |
| T24 | 已实现 | 后台画布增加 content-visibility: hidden，保留组件实例；五画布对照切换更快，布局稳定后位置及尺寸一致、无零尺寸节点。后台文本保存和远端同步正常。 |
| T25 | 部分完成 | 在 useCanvasSave、插件详情弹窗之外，继续拆出 useDocumentNodes、useRemoteNodes 和 useMessageList。画布主文件由基线约 1354 行降至 960 行；文档读写与节点加载已复测。剪贴板/快捷键、发送流与输入框、市场管理剩余块未全部拆分。 |
| T26 | 已实现 | Markdown 内容与扩展逻辑移到 nodeShared，通过公开子路径供文本节点和 Markdown 扩展复用；差异类型留在插件。 |
| T27 | 已实现 | 三种生成节点复用模型加载、输出替换及工具注册，统一销毁后保护；有差异的轮询与样式保留。 |
| T28 | 已实现 | 供应商侧栏与详情外壳抽成 providerPicker，公共样式集中到现有 providerList.scss。 |
| T29 | 已实现 | compshare 删除重复类型、信号封装与手写 multipart，复用宿主类型和 FormData/Blob；参考素材最多 64 MB，下载按流计量，禁止自动重定向。 |
| T30 | 已实现 | 默认版本号来自根 package.json，允许构建环境覆盖；web/server 不再导入桌面 SDK，构建文档补齐扩展插件。 |
| T31 | 仅完成设计 | 已记录调用边界与迁移设计。同步图片对象、流式响应、FFmpeg 句柄和宿主文件对象需要专门协议，缺少跨平台及真实供应商验证，未实施子进程迁移。 |

T31 设计见 `D:\learning-continuing\toonflow\docs\providerSandbox.md`。当前供应商执行仍是 node:vm，不能将本次改动解释为已完成进程或操作系统隔离。

## 已执行验证

- 全仓 `bun run typecheck` 通过，补充拆分与修复后再次通过。FFmpeg 包、工具及 providers 的现有 TypeScript 检查通过。
- 最后一次完整 `bun run build:server` 通过，包含 web、server、MCP、8 个节点、10 个工具和 5 个扩展。构建仍有部分 chunk 超过 500 kB 的提示。
- 路由生成器已执行；工作流 YAML 解析通过；`git diff --check` 通过。未新增测试模块、自检文件或测试依赖。
- 使用临时数据目录验证 HTTP：无 Origin 与同源首页返回 200；跨站 Origin、伪造 Host、缺工作区头或非本机代理标记返回 403；正确本机请求进入参数校验。
- 默认服务只监听 127.0.0.1。占用端口时第二个进程退出码为 1，不打印成功日志。
- 设置保存为英语后立即生效；外部原子修改临时设置为日语后，后续响应切换为日语，验证配置缓存失效。
- 工作区文本写入、读取成功；画布保存返回 200，旧 revision 对同字段的冲突返回 409 / ECANVASCONFLICT。
- 临时对话创建、关闭成功；关闭后访问返回 404 及重新打开提示。未使用付费模型生成。
- 11 MiB 普通 JSON 请求返回 413；保留大载荷的安装接口进入业务校验并返回 400。哈希静态资源带一年 immutable 缓存，HTML 的 max-age 为 0。
- 实际执行 webFetch：默认拒绝 127.0.0.1 和 169.254.169.254，公网 example.com 返回 200，允许内网后可访问本机页面。验证 IPv4 映射 IPv6 拦截及 Fake-IP 网段判断；未使用真实 Fake-IP 代理做联网验证。
- FFmpeg 参数校验：工作区字幕与 libx264 通过；额外 -i、字幕参数注入、ffprobe 对象中的 -i 被拒绝；工作区外绝对路径、上级目录及 file/http/concat 协议均被拒绝。
- 实际调用工具插件与宿主工厂完成媒体处理；FFprobe 回读确认：裁剪为 160×120 / H.264 / 1 秒，转码为 MPEG-4 / 2 秒，拼接为 H.264 / 2 秒，字幕输出为 320×240 / H.264 / 2 秒。默认探测和 count_frames 选项均成功；浏览器经实际 HTTP 桥接探测返回 200 和媒体结果。
- Chrome DevTools MCP 实际验证英语、日语、繁体中文、阿拉伯语切换；阿拉伯语设置 dir=rtl，页面无横向溢出。八种节点均加载成功，无节点运行错误。
- 文本节点 Markdown 标题、加粗、列表与链接渲染正常，通过浏览器编辑正文后保存、读回一致。三种生成节点的 getConfig/setPrompt 工具均成功，未触发付费生成。
- 通过应用现有接口创建 217 个文本节点和另外四个各 12 节点的画布；验证后台文本操作完成、切回位置尺寸、跨窗口改名、本机撤销保留远端修改和重做。最终构建重新加载后再次验证文档桥接与撤销重做。
- 文本和媒体供应商选择器实际打开，侧栏和详情尺寸正常，媒体厂商切换生效。对话区域始终仅有一个可见会话。

主要日志：

- `D:\rubbish\zhongjian\temp\toonflow\optimization20261014\allTypecheckFinal.log`
- `D:\rubbish\zhongjian\temp\toonflow\optimization20261014\standaloneDelivery.log`
- `D:\rubbish\zhongjian\temp\toonflow\optimization20261014\standaloneBefore.log`
- `D:\rubbish\zhongjian\temp\toonflow\optimization20261014\standaloneAfter.log`
- `D:\rubbish\zhongjian\temp\toonflow\optimization20261014\browserReview\typecheckReviewed.log`
- `D:\rubbish\zhongjian\temp\toonflow\optimization20261014\browserReview\buildReviewed.log`

过程中出现过 5 个事件参数的隐式 any，已修正并通过后续全仓检查；一次 Windows 生成 components.d.ts 时出现文件打开错误，后续 web 及完整构建均成功，未跳过检查或放宽断言。浏览器首次实测还暴露了对话 v-show、FFprobe 默认参数和远端同步清空文本输出三个问题，均已修复并复测。

MCP 的 Performance 录制与 Insights 已实际执行。指定 D 盘原始 trace 导出路径被工具自身的 workspace roots 检查拒绝，改用工具返回的录制分析结果；没有声称保存了原始 trace。大画布早期同步录制出现 368 ms 长任务，同时节点报错，因此不将这组数据与修复后的正常画布混作性能改善比例。105 次单节点移动的平均调用耗时为 65.34 ms，前后十次没有随历史填满持续增长；这不足以证明历史合并在所有场景都没有性能问题。

## 未完成验证与保留事项

- 用户解除 Chrome DevTools MCP 占用后，页面、节点、语言与画布验证已补上。产品内部 browser 工具的网络拦截、Worker/弹窗旁路及完整空闲回收未被这些页面验证覆盖，不能宣称网络沙箱完成。
- 更正此前的安装判断：FFmpeg/FFprobe 已存在于正在运行的便携版 `D:\learning-continuing\toonflow-l\toonflowPortable\data\ffmpeg\win32-x64`，版本均为 6.1.1。此前仅检查当前仓库和 PATH，漏查了这个运行实例。本轮直接复用，没有重新安装或修改便携版配置。
- Docker 构建、桌面安装包、macOS、Android 真机及设备互联没有完成本次实际运行验收。
- Android 的密钥、lineage 和远端 Secrets 未创建或配置。API 26–27 的升级仍需旧签名，不能据此宣称已消除公开旧密钥的影响。
- compshare 等供应商没有进行真实付费调用；轮询取消、FormData 上传和输出替换仍需真实业务验收。
- T25 当前交付五个分离部分；其余候选块仍保留在原组件，发送流、长消息列表、提及/拖拽与市场安装更新未完成整条业务链的真实验收，未宣称整个拆分任务完成。T31 仍只有设计。
- i18n 已补齐本次 7 条新增界面/接口提示的其余 20 种语言。运行现有提取器还带出了此前未抽取的源码文案及少量日志；当前中文目录有 322 个键尚无英文翻译。基线已有中文键在英文中缺失数为 0，未把这次提取暴露的缺口当作全量翻译工作扩展处理。
- 未删除既有测试文件，未引入 lint 框架，未修改 20 份多语言 README。部署变化集中写入现有开发文档。

配置缓存、前端请求归并和工具下载没有新增数据库查询，也没有增加按记录逐条发出的远程请求。用户实际数据规模未知；本轮画布规模为 217 节点及五画布合计 265 节点，另有一个八节点交互画布。DNS 只合并同域进行中的解析，供应商轮询保留必要的分次请求，未对线上数据库或服务执行压测。

## 环境、目录与收尾

复用 Bun 1.3.14：`D:\rubbish\zhongjian\envs\toonflow\bun1.3.14\bun-windows-x64\bun.exe`；Node 22.19.0：`D:\Code\nodejs\node.exe`。依赖仍位于项目 node_modules，包缓存使用 `D:\rubbish\zhongjian\caches\node`。没有升级依赖版本或安装全局工具。

临时文件及转译缓存分别使用 `D:\rubbish\zhongjian\temp\toonflow\optimization20261014` 与其 `transpilerCache` 子目录；构建输出沿用项目 `D:\learning-continuing\toonflow\build`。未生成新的安装包、EXE 或 APK。

以下为交付前目录现存文件的实测占用，不是净新增量；build 总量包含任务开始前已有的桌面、便携发布等产物，不能都算作本次生成：

| 目录 | 实测大小 |
| --- | ---: |
| build 全部 | 485.56 MiB |
| build/web | 29.33 MiB |
| build/server | 23.74 MiB |
| build/nodes | 3.26 MiB |
| build/tools | 12.36 MiB |
| build/ext | 0.08 MiB |
| build/mcp | 13.50 MiB |
| build/providers | 0.26 MiB |
| 本任务临时目录 | 97.75 MiB |
| 其中 browserReview 补充验证目录 | 17.53 MiB |
| 其中 mediaReview 六个媒体及字幕文件 | 0.15 MiB |

早期 Bun 在 `C:\Users\Administrator\.bun\install\cache\@t@` 意外生成或修改了 14 个转译缓存文件，合计 21.46 MiB，已说明并将后续转译缓存改到上述 D 盘目录。交付前检查这些文件最后修改时间仍为 02:35:50，未擅自删除。检查范围为相关已知缓存目录及任务指定路径，没有全盘扫描，也不声称排除所有工具内部写入。

本任务启动的 PID 75828、80512、88276 及补充验证的 PID 88472、50480 均已退出；3000、3010、10589、5173 均无监听。MCP 新建的独立上下文标签页 2、3 已关闭，确认仅剩连接时已有的 about:blank 页面 1；没有关闭共享浏览器实例。任务开始前已有的 MCP（PID 63796，127.0.0.1:10588）保留未动。无需用户手动停止本任务的验证服务。

本轮还只读检查了 Chrome MCP 既有 profile 的 Default/Cache 与 Default/Code Cache：总量属于已有缓存，补充验证开始时间 03:56:30 之后修改文件数均为 0；未移动或清理共享 profile。
