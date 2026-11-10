# 转写 provider：aliyun-asr

`media.transcribe.provider` 为 `aliyun-asr` 时使用。通过阿里百炼 Paraformer v2 文件转写 API 处理本地音频。默认转写工具仍为 `mlx-whisper`；只有选中本 provider 才会上传到阿里云。

`execution` 为 `program`，支持 `timed-transcription` 和 `word-timestamps`。需求使用通用的 `file`、`language`、`require`；无专属 `options`。

## 配置

先开通百炼并取得对应地域 API Key，把密钥单独写到本机文件第一行。文件及配置不能提交。

```json
{
    "media": {
        "transcribe": {
            "provider": "aliyun-asr",
            "apiKeyFile": "/path/to/private/dashscope-key",
            "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
            "model": "paraformer-v2",
            "language": "zh"
        }
    }
}
```

| 设置 | 环境变量 | 说明 |
| --- | --- | --- |
| `apiKeyFile` | `DASHSCOPE_API_KEY_FILE` | 必填，读取第一行，密钥不进入命令行和诊断输出 |
| `baseUrl` | `DASHSCOPE_BASE_URL` | 默认北京旧域名，仍可使用；包括 `/api/v1`，不能带查询参数 |
| `uploadUrl` | `DASHSCOPE_UPLOAD_URL` | 可选，默认 `<baseUrl>/uploads` |
| `model` | — | 当前仅支持 `paraformer-v2` |
| `language` | — | 可选 `zh`、`en`、`ja`、`yue`、`ko`、`de`、`fr`、`ru`；命令的 `--language` 优先 |

切换到北京业务空间域名时，可以把 `baseUrl` 设为 `https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api/v1`，同时将 `uploadUrl` 设为 `https://dashscope.aliyuncs.com/api/v1/uploads`。新加坡配置使用对应地域地址和对应地域密钥。地址必须使用 HTTPS。

## 使用

```bash
node cli/remake.js media:doctor --task transcribe
node cli/remake.js media:prepare --task transcribe --request <request.json> --json
node cli/remake.js media:transcribe <slug> --from <audio.wav> --language zh --require word-timestamps
```

- `doctor` 仅检查本地设置与密钥文件是否可读，不调用云端、不验证余额或配额、不代表真实转写已可用。
- `prepare` 仅检查本地需求与能力，不上传文件。
- 只有执行转写时才上传音频并提交可能计费的云端任务。请求固定识别第 0 音轨，开启时间戳校准；不启用额外音轨。
- 适配器自动获取临时上传凭证、上传本地文件、提交任务、每 3 秒查询状态、下载结果，整个流程最多等待 30 分钟。不会自动重复提交任务。
- 输出为秒制 `segments` 和真实 `words`，保留词后标点，兼容现有字幕流程。`--require word-timestamps` 会验证返回数据，缺失时失败，不伪造词级时间。
- 结果写入 `productions/<slug>/assets/<id>.transcript.json`，来源为 `aliyun-asr`；下一步沿用 `captions` 命令。

## 范围与限制

当前采用百炼的**临时 OSS 上传**，支持本地文件，无需用户手工提供公网 URL。适配器上传限制为非空且不超过 1 GB；格式、时长还需符合 Paraformer 要求。文件采用随机名称，不上传本机原文件名。

官方临时存储仅用于开发测试，有效期 48 小时，由服务自动清理，不提供本适配器可调用的删除接口；不适用于生产、高并发或压测。正式生产接入需要后续增加稳定 OSS 存储方式。不要声称已经支持生产存储，也不要把临时上传替换成公共读存储。

任务提交后遇到超时、网络故障或结果解析失败，错误会保留任务 ID。先按该 ID 查询云端状态再决定是否重新提交；本机停止等待不等于云端任务取消。结果下载链接也有有效期，应及时处理。

当前仅完成模拟验证，尚未使用真实密钥进行上传或转写；诊断不消耗转写额度。

## 官方依据

- [本地文件临时上传](https://help.aliyun.com/zh/model-studio/get-temporary-file-url)：上传凭证、OSS 表单和临时资源解析请求头。
- [Paraformer 文件转写 HTTP API](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api)：异步任务、分段/词级结果、毫秒时间。
- [异步任务查询](https://www.alibabacloud.com/help/en/model-studio/manage-asynchronous-tasks)：使用 `GET /api/v1/tasks/{task_id}` 查询；中文 Paraformer 页中的部分 POST 示例与统一查询接口文档不一致，适配器遵循 GET 查询接口。
