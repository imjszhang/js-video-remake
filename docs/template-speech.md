# 模板字幕生成口播

「根据字幕生成口播」使用 `video-remake.json` 里当前的 `media.speech`。

- `macos-say`：macOS 系统音色，不把字幕发给外部服务。音色列表只显示已安装的中文和英文音色。
- `qwen-tts`：按参考音频克隆音色。页面上传 1–30 秒参考声音，并填写这段声音里的原话；台词提交到已配置的语音服务。参考文件若还不是 16-bit PCM WAV，会先用本机 FFmpeg 转换。

两种都需要本机 FFmpeg 和 ffprobe。输入是当前模板的有效中英字幕、固定的起止时间和已填写的个人信息。生成中文时使用 `zh`，生成英文时使用 `en`。`qwen-tts` 会把它们换成服务接受的 `Chinese` / `English`。`{{name}}`、`{{badge}}` 等身份占位符会替换为个人信息中的实际值，未填写的变量会提示具体句号。所选语言的空句会跳过，其时间段保持静音；整份所选语言都没有文字时不会生成空口播。

系统逐句生成语音，并把每句放回原字幕时间窗。句间空白和结尾自动补齐静音，输出是与模板全片等长的 48 kHz、单声道 PCM WAV。某句略长时自动加速；加速上限为 3 倍，仍装不进时间窗时会指出具体句号，请缩短文字再生成。它不会修改字幕内容、字幕时间或模板源码。

生成过程支持逐句进度和取消。取消或失败后清理临时文本与音频，不留下半成品；输出使用新文件，不覆盖既有口播。系统语音把每句写进私有临时文件再交给 `say`；qwen-tts 把该句和参考音频提交给已配置的服务。两种都会去掉 `[[...]]` 定界符，避免字幕内容被当成语音控制指令。

命令行可以另用已保存的自己的音色念同一份字幕。先把语音合成 provider 设为 `qwen-tts` 并保存样本（见[素材生成](media-providers.md)），再运行：

```bash
node cli/remake.js template:voice <slug> --video <包名> [--lang zh|en] [--voice-id ID]
```

它仍按固定时间窗逐句对齐，加速规则与上面相同。每一句都会向语音服务发送台词和参考音频。这个命令会把生成的口播写入模板；网页里的「根据字幕生成口播」使用本次上传的参考音频；命令行使用保存的音色。


程序接口位于 `src/template-speech.js`：

- `speechOptions(config, deps)` 返回当前语音 provider、可用状态，以及系统音色或“需要参考音频”。这是只读检测。
- `synthesizeCaptionSpeech(config, {rows, identity, voice, language, duration, outputFile, reference, referenceText}, deps)` 生成整片口播。`rows` 包含 `start`、`end`、`zh`、`en`，`outputFile` 是尚不存在的绝对路径 WAV 文件，父目录由调用方准备。`qwen-tts` 使用绝对路径 `reference` 和 `referenceText`，不使用 `voice`。
- 子进程统一经 `deps.runSpeechCommand` 注入；`deps.signal` 负责取消，`deps.onProgress` 接收阶段、当前句号和进度。测试使用模拟语音与 FFmpeg，不调用真实生成。
