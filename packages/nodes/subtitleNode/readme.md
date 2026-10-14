# 字幕

连接一个视频或音频，使用本地官方 OpenAI Whisper 转录。Python 环境须安装 openai-whisper 和 PyTorch，FFmpeg 由宿主提供；可在插件配置中指定 Python 路径和默认模型，节点可选择模型与语言（留空自动识别），首次使用某个模型时会下载模型权重。

生成与导入 SRT 只更新草稿。分段表使用 `HH:MM:SS,mmm` 时间格式，可修改时间和文本、添加或删除分段。点击“保存字幕”后写入节点目录的 subtitle.srt 并更新 STRING 输出；未保存的草稿保存在画布中。导出仅导出成功保存的字幕，草稿有修改时须先保存。

Agent 使用 generateSubtitle 启动后台任务，按需查询 getGenerationStatus，确认后调用 saveSubtitle；setSubtitle 解析并保存给定 SRT。cancelGeneration 请求取消本地任务。重新打开节点可恢复已有任务的查询，失效任务需重新生成。保存冲突会保留草稿及旧输出，请保留草稿并刷新节点后处理磁盘版本。
