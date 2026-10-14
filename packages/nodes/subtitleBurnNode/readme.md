# 字幕烧录

连接一个视频与一个已保存的 SRT 字符串，点击“烧录字幕”生成带字幕的 MP4。使用宿主 FFmpeg 的 subtitles 滤镜和 libx264 编码器，字体由本机 FFmpeg/libass 选择。音轨存在时转为 AAC，无音轨也可生成。

每次生成使用独立素材目录，成功后更新视频输出，可预览和下载；失败或取消保留旧视频，只清理本次目录。清理失败会显示目录和错误，不自动重试。

`burnSubtitles({})` 立即返回 `{ status: "generating" }`。通过 `getGenerationStatus({})` 按需查询，`succeeded` 才表示本次输出成功；`cancelGeneration({})` 请求取消。生成会在后台继续，不需要循环等待。刷新节点前需结束任务，删除节点会先等待取消完成。
