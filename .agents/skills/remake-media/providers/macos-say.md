# 语音合成 provider：macos-say

`media.speech.provider` 为 `macos-say` 时使用。调用 macOS `/usr/bin/say` 把台词合成 WAV。不上传音频，也不使用参考声音。

`execution` 为 `program`，能力是 `text-to-speech`。只在 macOS 上就绪。

## 配置

| 设置 | 环境变量 | `video-remake.json` |
| --- | --- | --- |
| 默认音色 | `MACOS_SAY_VOICE` | `media.speech.voice` |

音色名用 `say -v '?'` 查看。命令里的 `--voice` 优先于配置。两者都空着时使用系统默认音色。

## 合成

```bash
node cli/remake.js media:speech --text "要念的台词" --voice Tingting --out speech.wav
```

台词为 1–2000 个字符。不要同时提供 `--reference` 或 `--reference-text`。输出必须是 `.wav`。登记方式与其他语音结果相同，来源名是 `macos-say.speak`。

模板工作台里按字幕时间轴生成整段口播的功能不走这个 provider，它仍使用自己的系统语音流程。
