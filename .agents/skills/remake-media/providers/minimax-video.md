# 视频 provider：minimax-video

MiniMax Hailuo-2.3 官方视频 API，与默认 comfy-mcp 使用的非 API MiniMax H3 模板是两条独立接入。不会自动从默认工具切换到付费 API。

## 配置

```json
{"provider":"minimax-video","apiKeyFile":"~/path/to/key","model":"MiniMax-Hailuo-2.3","resolution":"768P"}
```

放在 `media.video`：`apiKeyFile` / `MINIMAX_API_KEY_FILE` 读取第一行；`baseUrl` / `MINIMAX_VIDEO_BASE_URL` 默认 `https://api.minimax.io/v1`。使用其他地域时按账户官方端点配置，不能假定全球密钥通用。`model` 本版只支持 Hailuo-2.3；不接 H3 V2 协议。

## 需求与执行

- 文生视频或一张本地首帧 `images`；提示词 `intent` 最多 2000 字符。
- `duration` 为 6（默认）或 10 秒；`resolution` 为 `768P`（默认）或 `1080P`，1080P 只允许 6 秒。
- 接口没有明确画幅参数，本适配器拒绝 `aspectRatio`，不会将要求静默丢弃。图生通过首帧控制，文生使用模型默认画幅。
- 首帧 PNG/JPEG/WebP，严格小于 20 MB，经 Base64 data URL 提交；平台要求短边 >300px、比例 2:5–5:2，像素条件由服务检查。
- 不支持音频驱动、姿态参考、多图、首尾帧和 options。固定 `prompt_optimizer=false`。

提交 `POST /video_generation`，轮询 `GET /query/video_generation?task_id=...`；`Success` 后取 `file_id`，再调用 `GET /files/retrieve?file_id=...` 获取下载地址。每次业务响应检查 `base_resp.status_code`，不将 HTTP 200 的业务失败当成功。下载不携带 API Key。

获得生成授权后执行 `media:video --request <需求.json>`；已有任务使用 `--task-id` 继续，不新建任务。来源 `minimax-video.generate`，后续沿用 `media:land --kind video`。

仅模拟验证，未实际生视频。doctor 只检查本地配置；超时和文件交付规则见 [统一说明](../../../../docs/media-providers.md)。

官方来源：[文生接口](https://platform.minimax.io/docs/api-reference/video-generation-t2v)、[图生接口](https://platform.minimax.io/docs/api-reference/video-generation-i2v)、[任务查询](https://platform.minimax.io/docs/api-reference/video-generation-query)、[官方调用示例](https://github.com/MiniMax-AI/skills/blob/main/skills/frontend-dev/scripts/minimax_video.py)。
