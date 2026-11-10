# 转写 provider：azure-speech

选中 `media.transcribe.provider: "azure-speech"` 时使用。通过 Azure Speech **Fast Transcription** REST `2025-10-15` 上传本地音频并同步获取转写；无需公开音频 URL，也不安装 Azure SDK。默认转写工具仍为 `mlx-whisper`。

`execution: program`；支持 `timed-transcription` 和 `word-timestamps`。通用需求使用 `file`、`language`、`require`，无专属 `options`。参考片已有字幕时复用已有结果。

## 账户和配置

需要支持 Fast Transcription 的区域中的 **Standard（S0）Speech 资源**。F0 的每月免费实时转写额度不适用于本适配器；不要把它当成免费实时接口。区域可用性以[官方区域表](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions)为准；层级限制见[官方配额说明](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)。

| 设置 | 环境变量 | `media.transcribe` 字段 |
| --- | --- | --- |
| 资源根地址 | `AZURE_SPEECH_ENDPOINT` | `endpoint` |
| 密钥文件（第一行） | `AZURE_SPEECH_API_KEY_FILE` | `apiKeyFile` |
| 默认语言区域 | `AZURE_SPEECH_LANGUAGE` | `language` |

例如本机私有 `video-remake.json`：

```json
{
  "media": {
    "transcribe": {
      "provider": "azure-speech",
      "endpoint": "https://your-resource.cognitiveservices.azure.com",
      "apiKeyFile": "secrets/azure-speech.key",
      "language": "zh-CN"
    }
  }
}
```

环境变量优先；配置与密钥均不提交。`endpoint` 是 HTTPS 资源根地址，不能填完整转写路径或附带凭据/查询参数。适配器固定补上 `/speechtotext/transcriptions:transcribe?api-version=2025-10-15`。本版支持资源密钥认证，暂未接 Entra ID。

`language` 可省略，让服务自动识别；兼容通用 `zh` → `zh-CN`、`en` → `en-US`，其他语言需提供完整区域代码，例如 `ja-JP`。命令行语言覆盖默认值，具体语言支持以云端为准。

## 检查和调用

```bash
node cli/remake.js media:doctor --task transcribe
node cli/remake.js media:prepare --task transcribe --request request.json --json
node cli/remake.js media:transcribe <slug> --from <speech.wav> --language zh --require word-timestamps
```

`doctor` 只验证本地地址、语言格式和密钥文件。`ready: true` **不代表密钥、区域、S0 权限和额度已验证**；不会发起云端请求。`prepare` 只检查本地需求。只有实际转写会上传音频并可能计费。

输入推荐 WAV/MP3/FLAC 等[官方支持格式](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create)。本适配器保守限制文件 **小于 250 MB**（按固定版本 REST 参考），并建议音频小于 2 小时；当前云端教程的上限可能更高，不代表本适配器已验证更大输入。大小在上传前检查，格式和时长由 Azure 校验。请求总超时 30 分钟；不会自动重复上传，连接超时后应先确认服务端处理情况。

## 结果与验证范围

- 使用 multipart `audio` 与 JSON `definition`；默认关闭 profanity 替换，以保留原文。Fast Transcription 官方响应自带词级条目，不套用 Batch Transcription 的参数格式。
- `phrases` 转成 `segments`，`offsetMilliseconds` 和 `durationMilliseconds` 换算为秒制 `start`/`end`；词文本映射为 `word`，保留标点。不会根据句子均分伪造词时间。
- `--require word-timestamps` 会核验实际结果；缺失完整词级时间时失败。
- 结果仍写入 `productions/<slug>/assets/<id>.transcript.json`，来源为 `azure-speech`；后续 `captions` 用法保持不变。
- HTTP 错误仅显示状态与排查方向，不把响应正文、音频内容或密钥写进错误；429/5xx 标记可重试，但不自动重试。
- 当前覆盖请求格式、时间转换、错误处理和本地检查的模拟测试，**尚未实测云端服务**。

协议依据：[Fast Transcription 使用说明](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create)、[2025-10-15 REST 参考](https://learn.microsoft.com/en-us/rest/api/speechtotext/transcriptions/transcribe?view=rest-speechtotext-2025-10-15)。
