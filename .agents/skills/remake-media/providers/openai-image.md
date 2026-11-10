# 图片 provider：openai-image

通过官方 Images API 直接调用，支持文生图和参考图编辑。默认工具仍是 codex-image；本适配器需要独立 API Key，不读取 ChatGPT 登录凭据。

## 配置

替换 `media.image` 整个对象：

```json
{"provider":"openai-image","apiKeyFile":"~/path/to/key","model":"gpt-image-2.5-sunburst"}
```

- `apiKeyFile`：环境变量 `OPENAI_IMAGE_API_KEY_FILE`，读取文件第一行。
- `baseUrl`：`OPENAI_IMAGE_BASE_URL`，默认 `https://api.openai.com/v1`，必须 HTTPS，不带查询参数或凭据。
- `model`：`OPENAI_IMAGE_MODEL`，默认 `gpt-image-2.5-sunburst`；覆盖后需自行确认该模型支持当前 Images 协议。

环境变量优先；路径支持 `~/`，相对路径按工作区解析；密钥和本机配置不提交。

## 调用与限制

`media:image --intent ... [--image ...] [--size auto|宽x高] [--image-quality auto|low|medium|high] [--out ...]`。

使用 `/images/generations` JSON 文生图，或 `/images/edits` multipart 编辑。参考图最多 16 张，每张不超过 20 MB；本适配器接受 PNG/JPEG/WebP，实际尺寸限制由模型检查。固定 `n=1`、`output_format=png`，解码 `data[0].b64_json`。`options` 只接受 `quality`；不支持会话参数，不实现 mask 或批量图片。

`doctor` 只检查本地 URL 和密钥文件。必须获得真实生图授权后才执行 `media:image`；失败不自动重试。结果来源为 `openai-image.generate` / `openai-image.edit`，使用 `media:land` 登记。默认临时文件、输出上限、覆盖保护与超时规则见 [统一说明](../../../../docs/media-providers.md)。

2026-11-10 已通过第三方兼容接口完成一次真实文生图测试：`gpt-image-2`、低质量、1024×1024 PNG，返回 Base64 并成功落地。图片编辑仍仅通过模拟测试；该结果不代表所有第三方接口都兼容。[官方协议](https://developers.openai.com/api/docs/guides/image-generation)。
