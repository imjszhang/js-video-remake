# 语音合成 provider：qwen-tts

`media.speech.provider` 为 `qwen-tts` 时使用。向兼容接口 `POST /v1/audio/speech` 提交台词和一段参考声音，取回 WAV。未单独配置时，项目默认使用 `macos-say`。选中本 provider 后不会自动切换到系统语音。

`execution` 为 `program`，能力是 `text-to-speech`。参考音频、参考台词和要念的文本属于需求；服务地址、密钥和模型属于配置。当前适配器没有额外的 `options`。

## 配置

| 设置 | 环境变量 | `video-remake.json` |
| --- | --- | --- |
| 服务根地址 | `QWEN_TTS_BASE_URL` | `media.speech.baseUrl` |
| 健康检查 URL | `QWEN_TTS_HEALTH_URL` | `media.speech.healthUrl` |
| Bearer 密钥文件（读第一行） | `QWEN_TTS_API_KEY_FILE` | `media.speech.apiKeyFile` |
| 模型 | — | `media.speech.model`（默认 `qwen3-tts`） |
| 默认语言 | — | `media.speech.language` |

环境变量优先。本机地址和密钥不要提交。项目若配置了顶层 `proxy`，非本机请求会经该 SOCKS5 代理发出。

健康检查需要返回 `{"status":"ok"}`。未配置 `healthUrl` 时，doctor 只核对地址和密钥文件是否存在，不访问服务。

## 合成

参考音频必须是 16-bit PCM WAV，时长 1–30 秒，文件不超过 12 MiB。台词 `text` 和参考台词 `referenceText` 各为 1–2000 个字符。参考台词要和参考音频里的原话一致。这个模型用参考音频定音色，不接受 `--voice`。

```bash
node cli/remake.js media:speech --text "要念的台词" \
  --reference productions/demo/assets/audio/ref.wav \
  --reference-text "参考音频里的原话" \
  --language Chinese --out speech.wav
```

语言可以不填，由服务使用自己的默认值。已确认能通过语言检查的值包括 `auto`、`Chinese`、`English`、`Japanese`、`Korean`、`German`、`French`、`Russian`。请求固定发送 `response_format=wav`。单句遇到 HTTP 502、503 或 504 时，同一句最多再请求四次，间隔 3、8、15、30 秒。`template:voice` 会把已成功的句子留在视频包 `.work/speech-cache/`，失败后重跑不重复请求这些句子。

同一段参考音可以先保存，以后不用每次再传文件和原话。后保存的音色成为默认。`voices/` 和 `voices.json` 只留在本机。

```bash
node cli/remake.js voice:save --from ref.wav --text "参考音频里的原话"
node cli/remake.js media:speech --text "要念的台词" --language Chinese --out speech.wav
```

已保存音色也可以按模板字幕逐句念稿，并对齐到原来的时间窗。网页里的「根据字幕生成口播」不使用它。

```bash
node cli/remake.js template:voice <slug> --video <包名> --lang zh
```

结果是本地 WAV。登记到制作：

```bash
node cli/remake.js media:land <slug> --kind audio --from speech.wav --intent "口播" --provider qwen-tts.speak
```

## 不要做

- 不要把系统音色名称传给这个 provider。
- 不要在未获授权时合成。doctor 通过不等于已经可以消耗服务额度。
- 选中本 provider 时不要改去调用 `macos-say`。
- 模板工作台「根据字幕生成口播」在选中本 provider 时走这里：页面上传参考音频和原话，服务逐句返回 WAV，再按字幕时间窗对齐。不要在这条路径上改用系统音色。
