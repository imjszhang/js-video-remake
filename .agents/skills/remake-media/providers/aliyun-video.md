# 视频 provider：aliyun-video

阿里百炼万相 2.7 官方异步接口。只接文生视频和单张首帧图生视频，未接入平台所有生成模式。

## 配置

```json
{
  "provider":"aliyun-video",
  "apiKeyFile":"~/path/to/key",
  "textModel":"wan2.7-t2v",
  "imageModel":"wan2.7-i2v-2026-04-25",
  "resolution":"720P"
}
```

放在 `media.video`。`apiKeyFile` 对应 `DASHSCOPE_API_KEY_FILE`，读取第一行；`baseUrl` 对应 `DASHSCOPE_VIDEO_BASE_URL`，默认 `https://dashscope.aliyuncs.com/api/v1`。可改成业务空间和区域对应的 HTTPS `/api/v1` 地址，账号、模型与地域必须匹配。配置和密钥不提交。

`textModel` 支持 `wan2.7-t2v` / `wan2.7-t2v-2026-06-12`；`imageModel` 固定支持上面版本；`resolution` 为 `720P`（适配器默认）或 `1080P`。其他版本不能直接套用该协议。

## 需求与执行

- `intent` 最多 5000 字符，`duration` 为 2–15 整数，默认 5 秒。
- 文生 `aspectRatio` 可用 `16:9`（默认）、`9:16`、`1:1`、`4:3`、`3:4`。
- 图生传入一张本地 `images`，不要设置 `aspectRatio`，由首帧控制画幅。支持 PNG/JPEG/WebP、≤20 MB，经 Base64 data URL 提交，无需公共文件存储。平台另要求宽高 240–8000、比例 1:8–8:1，PNG 无透明通道；这些属性由服务校验。
- 不接本地驱动音频、首尾帧、视频续写和多参考；不能因为平台支持就绕过适配器能力声明。模型可能生成自身音轨，不代表本版支持用户音频驱动。
- 无专属 options；固定关闭 prompt_extend，保留用户提示词。

提交 `/services/aigc/video-generation/video-synthesis`，带 `X-DashScope-Async: enable`。首帧使用新版 `input.media: [{type:"first_frame",url:...}]`，不要混用旧版 img_url。查询 `GET /tasks/<id>`，成功后下载 `output.video_url`。

获得授权后执行 `media:video --request <需求.json>`；异常保留 ID，用 `--task-id <ID>` 恢复查询，别重新提交。任务和链接有有效期（官方当前为 24 小时），应及时保存。输出来源 `aliyun-video.generate`，统一 `media:land` 落地。

仅模拟验证，未真实生成。doctor 不联网验证权限/额度。文件与超时限制见 [统一说明](../../../../docs/media-providers.md)。

官方来源：[文生接口](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference)、[图生接口](https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference)。
