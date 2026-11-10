# 图片 provider：gemini-image

使用 Gemini `generateContent` 接口，支持文生图和单轮参考图编辑，不维护对话状态。

## 配置

```json
{"provider":"gemini-image","apiKeyFile":"~/path/to/key","model":"gemini-3.1-flash-image"}
```

将上面对象放在 `media.image`：

- `apiKeyFile` / `GEMINI_IMAGE_API_KEY_FILE`：第一行密钥，通过 `x-goog-api-key` 请求头发送，不放 URL。
- `model` / `GEMINI_IMAGE_MODEL`：默认 `gemini-3.1-flash-image`，必须是支持图片输出的模型。
- `baseUrl` / `GEMINI_IMAGE_BASE_URL`：默认 `https://generativelanguage.googleapis.com/v1beta`。

## 调用与限制

`media:image --intent ... [--image ...] [--size 16:9] [--out ...]`。无专属 options，不能使用 会话或质量选项。

`size` 表示画幅比例，支持 `1:1`、`2:3`、`3:2`、`3:4`、`4:3`、`4:5`、`5:4`、`9:16`、`16:9`、`21:9`；不接受像素尺寸。省略时由模型决定。参考图为 PNG/JPEG/WebP，最多 14 张，原始字节总量保守限制 14 MB（预留 Base64 请求开销）。更大的图需先缩小，本版不使用 Files API。

请求 `responseModalities: [TEXT, IMAGE]`，读取首个候选中的非思考图片 `inlineData`；被拦截、只返回文字或未正常结束会报错，不伪造图片。不支持多轮编辑或持久化 thought signature。

`doctor` 仅本地检查；实际生成前须获得授权。输出来源 `gemini-image.generate` / `gemini-image.edit`，随后 `media:land`。输出实际格式由模型决定，建议省略 `--out`，由适配器按格式命名。

仅通过模拟测试，未实际生图。统一文件、超时和密钥规则见 [统一说明](../../../../docs/media-providers.md)。[官方图像指南](https://ai.google.dev/gemini-api/docs/image-generation)、[generateContent 接口](https://ai.google.dev/api/generate-content)。
