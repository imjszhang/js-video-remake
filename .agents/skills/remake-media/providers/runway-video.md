# 视频 provider：runway-video

官方 Runway Gen-4.5 API 适配器。仅接入文生视频与单张首帧图生视频，默认工具仍是 comfy-mcp。

## 配置

替换 `media.video` 对象：

```json
{"provider":"runway-video","apiKeyFile":"~/path/to/key","model":"gen4.5"}
```

- `apiKeyFile` / `RUNWAY_API_KEY_FILE`：密钥文件第一行。
- `baseUrl` / `RUNWAY_VIDEO_BASE_URL`：默认 `https://api.dev.runwayml.com/v1`。
- `model`：当前只支持 `gen4.5`。认证头 `Authorization: Bearer`，版本头固定 `X-Runway-Version: 2024-11-06`。

配置解析遵循环境变量优先，文件路径相对工作区，支持 `~/`；本机配置和密钥不提交。doctor 只检查配置，不能证明账号权限或额度可用。

## 需求与执行

需求使用 `intent`、可选单张 `images`、`duration`、`aspectRatio`、`outPath`、`require`，无专属 options。

- 提示词最多 1000 UTF-16 字符。
- 时长为 2–10 的整数，默认 5 秒。
- 画幅本版支持 `16:9`、`9:16`，默认 `16:9`，分别映射 1280:720、720:1280；图生视频其他分辨率本版暂不接入。
- 参考图为本地 PNG/JPEG/WebP，原始文件不超过 3.5 MB，以 Base64 data URI 提交，为服务 5 MB data URI 限制留出余量。
- 不支持音频驱动、多图或姿态参考。先准备符合实际模型要求的图片，像素、内容等更细限制由服务检查。

程序按有无首帧调用 `/image_to_video` 或 `/text_to_video`；通过 `GET /tasks/<id>` 查询，成功读取第一条输出直链。失败、取消、未知状态不自动重提。

获得授权后使用 `media:video --request <需求.json> [--out clip.mp4]`；恢复用 `media:video --task-id <ID>`（选择相同 provider/账号）。来源 `runway-video.generate`，随后通过 `media:land --kind video` 登记。

超时、下载、文件保护和验证边界见 [统一说明](../../../../docs/media-providers.md)。仅模拟验证，未真实生视频。

官方来源：[API](https://docs.dev.runwayml.com/api/)、[输入规格](https://docs.dev.runwayml.com/assets/inputs/)、[官方 SDK 类型](https://github.com/runwayml/sdk-python/blob/main/src/runwayml/types/text_to_video_create_params.py)。
