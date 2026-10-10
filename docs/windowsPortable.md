# Windows 便携测试版

1. 将整个压缩包解压到 D 盘的可写目录，例如 `D:\toonflow`。
2. 双击 `toonflowPortable\toonflow.exe`。无需自行启动 Bun、Node 或本地服务。
3. 在设置中填写老李渠道的地址和密钥，再选择模型。交付包不包含密钥或用户数据。
4. 创建项目时选择 D 盘文件夹。关闭主窗口即可退出应用及其本地服务。

请完整保留目录结构，不要只复制 EXE，也不要直接在压缩包内运行。支持 Windows x64，需要本机已有 Microsoft Edge WebView2 Runtime 120 或更新版本。程序不自动安装系统组件，不注册卸载项、协议或快捷方式。

## 数据位置

- `data`：配置、供应商、插件和生成任务记录。配置中可能包含 API 密钥，请勿上传或分享。
- `profile`：窗口页面的持久状态与 WebView2 用户资料。
- 项目目录：创建项目时自己选择的位置，保存画布、分镜与生成素材。
- `cache`、`temp`：应用自身的缓存与临时文件。
- `runtime`：随包提供的运行文件，不需要全局安装开发环境。

这些目录相对于 `toonflow.exe` 创建，应用只修改自身进程的环境变量，不修改系统 PATH。移动便携包前先退出应用；外部项目目录不会随包移动，移动项目后需重新打开它。

便携测试版不执行在线更新。更换版本前备份 `data`、`profile` 和项目目录；新版本放在新目录，再迁移所需数据。不要用官方安装包覆盖此定制版。

首次真实生成需要另行确认内容和费用。视频选择完整型号 `特价2.5需要过人脸技术-可参考过人脸素材库`，建议先做 16 秒、720p、单角色、单场景。图片和文字模型各自收费；本轮交付只进行模拟验证。

## 从源码构建

复用项目锁文件要求的 Bun 与 Electrobun，先将 `TEMP`、`TMP`、`HUTCH_HOME`、Bun 缓存目录设置到 D 盘。依赖保留在项目 `node_modules`。

```powershell
bun run build:desktop
bun apps/desktop/scripts/packagePortableWindows.ts D:\rubbish\zhongjian\artifacts\toonflow\新的版本目录
```

第二步只使用第一步生成的本地归档，拒绝覆盖已有产物目录。编译器使用 Windows 现有 .NET Framework C# 编译器，解压缩使用 Windows 自带 tar；不调用 NSIS，不安装工具。

## Anthropic 对话修复版

本版本修复 `@earendil-works/pi-ai@0.85.1` 转换 Anthropic 工具参数时丢弃根定义的问题。补丁由 `patches/piAiAnthropicSchema.patch` 和 Bun 的 `patchedDependencies` 管理，保留 `definitions`、`$defs`、引用及原有约束，依赖版本不变。重装依赖时应使用锁文件，不能单独删除此补丁。

DeepSeek 使用 `https://api.deepseek.com/anthropic`、`anthropic-messages` 和 `deepseek-flash`；密钥仅在应用设置中填写。切换协议时须同时匹配地址：Chat Completions 使用根地址或 `/v1`，不保留 `/anthropic`。

更新已经使用的便携目录：

1. 关闭旧版 Toonflow，等待应用退出。
2. 将旧目录中的 `runtime` 改名为 `runtimeBackup`，保留回退副本；已有同名备份时使用新的备份名称。
3. 从新包复制 `runtime` 文件夹和 `toonflow.exe` 到旧目录。保留原来的 `data`、`profile` 和项目目录，不用新建空目录覆盖它们。
4. 双击旧目录中的 `toonflow.exe`，将文本供应商恢复为上面的 Anthropic 地址与协议，并保存。

只替换顶层 EXE 不会更新对话逻辑，必须同时更新 `runtime`。直接使用新包目录也可以，但该目录初始没有旧配置。

针对性模拟验证命令：`bun test apps/server/verification/anthropicSchema.test.ts --timeout 10000`。使用 SDK 的内存模拟响应，不读取真实密钥、不发网络请求、不写项目数据。覆盖三种协议的完整画布工具定义、默认与高推理参数、流式回复、工具结果回传、多轮对话、异常断流，以及 Anthropic 根约束与严格模式；14 项、303 条断言在 Bun 1.3.14 和包内同版 Bun 1.4.0 下通过。真实 DeepSeek 调用须另行确认。

修复版已从新 ZIP 解压启动，确认原生窗口响应正常，并通过 Chrome DevTools 操作同一桌面服务的界面。独立的本机 Anthropic 模拟接口接收 5 次请求，完成问候、高推理等级下的 `getNodeTools → nodeTools → 回复` 和下一轮对话；实际读取分镜的 16 秒设置，工具结果与对话记录正常保存，缺失定义错误为 0。验证使用单独的模拟配置，没有复制真实密钥，也没有调用生图、生视频。测试应用、模拟接口、监听端口和验证标签页均已关闭。

## 本次验证（2026-10-10）

- Windows x64、WebView2 154；包内 Bun 1.4.0。
- 桌面类型检查及构建通过；视频 62 项、图片 48 项现有模拟测试通过，共 802 条断言。两个测试文件须分别启动 Bun 进程，避免应用配置单例跨测试目录共享。
- 从 ZIP 解压出的 EXE 正常启停；同目录重复启动被阻止。保存的项目、画布和模拟模型配置在重启后保留。
- 桌面内置服务完成图片、视频任务中断恢复，未新增提交；图片原字节、视频原片校验一致。视频结果回填对应分镜。页面操作通过 Chrome DevTools 验证，另行确认了原生主窗口创建及响应。
- 在线更新被禁用；检查的卸载项、协议注册和 C 盘默认应用目录未新增。临时服务、端口与验证标签页已关闭。
- 未调用真实付费生成，未验证其他电脑或安装器；交付包不含验证数据。
