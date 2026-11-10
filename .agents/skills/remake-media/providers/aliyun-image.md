# 图片 provider：aliyun-image

通过阿里百炼万相 2.7 的同步多模态生成接口支持文生图和参考图编辑。与转写适配器使用相同的密钥文件环境变量，但图片配置独立。

## 配置

```json
{"provider":"aliyun-image","apiKeyFile":"~/path/to/key","model":"wan2.7-image"}
```

替换 `media.image` 对象：

- `apiKeyFile` / `DASHSCOPE_API_KEY_FILE`：读取第一行。
- `baseUrl` / `DASHSCOPE_IMAGE_BASE_URL`：默认 `https://dashscope.aliyuncs.com/api/v1`；也可配置业务空间对应地域的 `/api/v1` 根地址，密钥地域需一致。
- `model` / `DASHSCOPE_IMAGE_MODEL`：只接受 `wan2.7-image` 或 `wan2.7-image-pro`。

## 调用与限制

`media:image --intent ... [--image ...] [--size 1K|2K] [--out ...]`。无专属 options。

提示词最多 5000 字符，参考图最多 9 张，每张不超过 20 MB。本版接受 PNG/JPEG/WebP，以 Base64 data URL 提交，不上传公共存储。模型另要求参考图宽高 240–8000、宽高比 1:8–8:1，PNG 不支持透明通道；这些解码属性由服务检查，提交前自行准备合规素材。

固定单张输出、关闭可见 watermark，调用 `/services/aigc/multimodal-generation/generation`；下载返回的图片链接时不携带 API 密钥。仅接同步单张接口，不实现组图、框选或 4K。返回地址不写入素材结果或日志。

`doctor` 只本地检查，不验证地域、额度和权限。实际生成前须获授权。输出来源 `aliyun-image.generate` / `aliyun-image.edit`，随后 `media:land`。

仅模拟验证，未真实生图。通用限制见 [统一说明](../../../../docs/media-providers.md)。[官方万相接口](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference)。
