# 素材生成 provider

出图、出片、转写三项任务各自选择一个 provider。制作流程描述素材需求，provider 负责转换工具参数、执行调用和交付结果，项目负责能力检查、结果检查及素材落地。选择和本机参数写在 `video-remake.json` 的 `media` 段；没写时使用本项目的默认选择。

默认图片工具为 `codex-image`，由当前 Agent 调用内置生图。显式配置仍优先于默认值；不迁移已有制作、素材台账或转写文件。

| 任务 | 默认 provider | 执行方式 | 已验证版本 |
| --- | --- | --- | --- |
| 出图 `image` | `codex-image` | Agent 调当前会话的内置生图工具 | 以当前会话工具为准 |
| 出片 `video` | `comfy-mcp` | Agent 通过 ComfyUI MCP 调非 API MiniMax H3 模板；CLI 做需求准备和探活 | comfy-mcp 0.10.0，ComfyUI 0.41.0 |
| 转写 `transcribe` | `mlx-whisper` | `remake media:transcribe` 调已部署的 OpenAI 兼容转写端点 | whisper-large-v3 |

`remake media:doctor` 显示当前选择、执行方式、支持能力、探测到的版本、是否就绪和对应的 Agent 指南。`--task image|video|transcribe` 只检查一项，未就绪时以非零退出。JSON 中的 `execution` 为 `program` 或 `agent`，分别表示程序调用和 Agent 执行；保留 `agentOnly` 字段以兼容已有调用方。

## 需求准备与能力检查

### 默认图片工具：codex-image

将本机 `media.image` 整段设为 `{"provider":"codex-image"}` 即可选择；不需要配置安装目录或 API Key。若使用 `VIDEO_REMAKE_MEDIA_IMAGE=codex-image` 临时选择，也需要确保文件配置的 `media.image` 不残留其他 provider 专属字段，否则配置检查会报错。

执行方式是 `agent`，支持 `text-to-image` 和 `image-edit`。准备入口返回指南和需求；`media:image` 会明确返回 `MEDIA_AGENT_REQUIRED`，不会自动调用 API 或切换其他适配器。`media:doctor` 返回 `ready: false` 并提示 CLI 无法验证会话工具、登录和额度；限定 `--task image` 时返回 `DOCTOR_FAILED`，由 Agent 按指南继续核对真实工具可用性。这不是已经确认工具不可用，也不是出图授权。

需求 `options` 只接受布尔值 `transparentBackground`。尺寸放在 `size`，质量和画面要求写入 `intent`；尺寸是提示要求，需要检查实际输出。图片文件由 Agent 从工具实际输出取得，按 `codex-image.generate` 或 `codex-image.edit` 通过 `media:land` 登记。若没有可读取的输出文件或图片数据，明确报告交付受阻，不伪造素材路径。

详细调用、参考图检查、透明背景和文件交付说明见 [codex-image 指南](../.agents/skills/remake-media/providers/codex-image.md)。2026-11-09 已通过当前会话完成一次真实文生图并登记 PNG 素材；参考图编辑尚未实测。不读取登录凭据、不新增 API 调用、不自动切换计费渠道。

### 可选图片工具

默认仍为 `codex-image`。另有四种程序适配器，均通过 `media:image` 调用，输出本地文件后再 `media:land` 登记。不会自动切换工具或复用 ChatGPT 登录凭据。

| provider | 文生图 / 参考图编辑 | 默认模型或配置 | 指南 |
| --- | --- | --- | --- |
| `openai-image` | 两者支持，官方 Images API | `gpt-image-2.5-sunburst` | [配置与限制](../.agents/skills/remake-media/providers/openai-image.md) |
| `gemini-image` | 两者支持，Gemini generateContent | `gemini-3.1-flash-image` | [配置与限制](../.agents/skills/remake-media/providers/gemini-image.md) |
| `aliyun-image` | 两者支持，百炼万相同步接口 | `wan2.7-image` | [配置与限制](../.agents/skills/remake-media/providers/aliyun-image.md) |
| `comfyui-image` | 需分别配置对应工作流 | API 工作流与输入/输出节点绑定 | [配置与限制](../.agents/skills/remake-media/providers/comfyui-image.md) |

切换时替换本机 `video-remake.json` 的 `media.image` 整个对象，不混用其他工具的字段。例如 OpenAI：

```json
{
  "provider": "openai-image",
  "apiKeyFile": "~/path/to/openai-key",
  "model": "gpt-image-2.5-sunburst"
}
```

所有新适配器的 `media:doctor --task image` 都只做本地配置检查，不联网、不调用生成。`ready: true` 不代表模型、远端节点、服务权限和额度已验证。ComfyUI 的 prepare 会额外读取本地工作流，检查需求对应的配置和绑定；不会上传图片或提交任务。已有 `comfy-mcp` 视频接口保持不变。

使用示例（以下生成命令会真实调用所选服务，必须先获得授权）：

```bash
node cli/remake.js media:doctor --task image
node cli/remake.js media:image --intent "办公室人物半身照" --out /tmp/portrait.png
node cli/remake.js media:image --intent "保留人物，背景换成办公室" --image reference.png --out /tmp/edited.png
```

`--size` 按工具支持的格式填写，不会静默忽略：OpenAI 为 `auto` 或像素 `宽x高`，Gemini 为画幅比例（如 `16:9`），万相为 `1K` / `2K`，ComfyUI 为像素 `宽x高` 且必须绑定宽高节点。未传时使用服务或工作流默认值。只有 OpenAI 新适配器接受 `--image-quality`。

每次交付一张图片。输入支持本地 PNG/JPEG/WebP（具体模型限制见指南），输出检查文件签名、大小和扩展名；不把错误正文保存为图片。未传 `--out` 时创建独立临时目录，按实际格式命名；已有输出文件会在提交前拒绝覆盖。若输出格式与指定扩展名不符会报错，模型实际格式不确定时建议省略 `--out`。下载不自动携带云端 API 密钥，响应错误不回显密钥或签名下载链接。生成、轮询和下载总超时默认 10 分钟，不自动重提任务；ComfyUI 提交后的错误包含任务 ID 供排查。

四种新增图片适配器均通过模拟 HTTP 和本地文件测试；其中 OpenAI 图片适配器已通过一次第三方兼容接口的真实文生图测试，其余新增图片接口及图片编辑尚未实测。不会安装 ComfyUI 节点、下载模型、创建云资源或消耗生成额度来做检查。

### 可选视频生成工具

默认保持 `comfy-mcp`（Agent 通过 MCP 调用），新增三个官方 API 程序适配器：

| provider | 本版接入模型 | 支持的需求 | 指南 |
| --- | --- | --- | --- |
| `aliyun-video` | 万相 2.7 文生 / 图生视频 | 文本、单张首帧图片 | [配置和限制](../.agents/skills/remake-media/providers/aliyun-video.md) |
| `runway-video` | Runway Gen-4.5 | 文本、单张首帧图片 | [配置和限制](../.agents/skills/remake-media/providers/runway-video.md) |
| `minimax-video` | MiniMax Hailuo-2.3 | 文本、单张首帧图片 | [配置和限制](../.agents/skills/remake-media/providers/minimax-video.md) |

这些是各产品能力的一部分，不代表已经接入平台全部模型或功能。新增适配器均不支持本地驱动音频、姿态参考视频、多参考图、首尾帧和视频续写；缺少能力会在提交前失败，不自动回退到其他工具。模型自带生成音轨不等同于接收用户的驱动音频。Comfy MCP 既有能力和调用方式保留。

切换时替换 `video-remake.json` 的 `media.video` 整个对象。例如：

```json
{"provider":"runway-video","apiKeyFile":"~/path/to/runway-key","model":"gen4.5"}
```

`VIDEO_REMAKE_MEDIA_VIDEO` 可覆盖 provider；专属字段不能混用。新增工具的 doctor 只检查本地配置和密钥文件，不提交任务、不联网验证账号或额度。默认 comfy-mcp doctor 仍保留原来的服务探活。

准备 `video-request.json`：

```json
{
  "intent": "固定镜头，树叶在微风中缓缓摇动",
  "images": ["reference.png"],
  "duration": 6
}
```

去掉 `images` 为文生视频。`aspectRatio` 按工具支持范围填写；万相图生和 MiniMax 不接受该字段，避免静默忽略画幅。所有本地路径（包括 JSON 中的 `outPath`）以工作区为基准。`--out` 优先于 JSON 的 `outPath`。以下后两个命令会真实调用 API，执行前必须已有用户授权；代码和测试阶段不执行：

```bash
node cli/remake.js media:prepare --task video --request video-request.json
node cli/remake.js media:video --request video-request.json --out /tmp/clip.mp4
node cli/remake.js media:video --task-id <已有任务ID> --out /tmp/clip.mp4
```

`media:video` 不带制作 slug，交付本地文件、素材来源和 `taskId`，之后沿用 `media:land <slug> --kind video --from ... --intent ... --provider ...`。选中 comfy-mcp 时返回 `MEDIA_AGENT_REQUIRED`，不会把 MCP 包成云 API，也不会自动选择其他工具。

三个新适配器每次只提交一次任务，默认每 15 秒查询，提交到下载总超时 30 分钟。失败、断线或下载异常不自动重提；已取得的任务 ID 会出现在错误信息中。保持相同 provider、账号和区域，通过 `--task-id` 继续查询/下载（不会重新生成），不要同时传 `--request`。服务端任务可能仍在运行，本机超时不等于取消；本版没有持久化任务队列、后台任务管理或自动取消。若提交响应丢失、尚未取得 ID，应先在服务端核对，不能假定提交失败。

下载不携带 API 密钥、不记录签名链接。只接收 HTTPS 直链，重定向会报错；输出上限 512 MiB，流式下载到同目录临时文件，成功后以不覆盖方式发布为 `.mp4`。已有输出在提交前拦截，下载中断会清理半成品；未指定输出时使用独立临时目录。检查的是 MP4 容器头和文件大小，不等于验证编码、实际时长或画面质量，真实生成后仍需播放/探测确认。

新增三套接口目前仅做模拟 HTTP、文件与完整 CLI 链路测试，未实际生成视频或验证真实账号。

### 通用准备入口

```bash
node cli/remake.js media:prepare --task video --request request.json --json
```

`media:prepare` 读取本地 JSON 需求，按当前配置选择 provider，解析文件路径，检查输入和所需能力，返回 `provider`、`guide`、`execution`、`capabilities`、`ledgerProviders` 和标准化后的 `request`。参考图片、音频和视频必须是已存在的本地文件；输出路径不要求文件已存在。它不联网、不提交生成任务、不写素材或台账；成功只表示本地需求检查通过，不代表远程服务就绪、模板已安装或已经取得生成授权。

需求 JSON 的通用字段如下。所有相对文件路径按工作区解析，包括 `--request` 本身；不以需求 JSON 所在目录为基准。

| 任务 | 必填字段 | 可选字段 |
| --- | --- | --- |
| `image` | `intent`：生成或编辑意图 | `images`：参考图片路径数组；`size`：尺寸；`outPath`：输出路径；`options`；`require` |
| `video` | `intent`：片段意图 | `images`：参考图片路径数组；`audio`：驱动音频；`referenceVideo`：姿态参考视频；`duration`：秒数；`aspectRatio`：画幅；`outPath`：视频输出路径；`options`；`require` |
| `transcribe` | `file`：待转写音频路径 | `language`；`options`；`require` |

`options` 是所选 provider 的专属选项对象，不能用它替代通用需求。没有实现专属选项校验的 provider 只接受空 `options`。`require` 是额外能力要求的字符串数组；即使没有填写，项目也会从任务和参考输入推断基本要求。当前 provider 的配置、专属选项和支持能力不会被自动搬到另一家工具。视频 `duration` 必须是大于 0 的数字，`aspectRatio` 是正整数比例，如 `9:16`；工具实际支持的范围仍按专属指南检查。

例如，人物口播需求只描述素材和意图，不写 Comfy 模板名：

```json
{
  "intent": "保持参考人物身份，按照录音自然说话",
  "images": ["productions/demo/assets/image/look.png"],
  "audio": "productions/demo/assets/audio/speech.wav",
  "require": ["audio-driven-video"]
}
```

| 任务 | 当前能力标识 | 需求检查 |
| --- | --- | --- |
| 图片 | `text-to-image`、`image-edit` | 无参考图时要求文生图，有参考图时要求图片编辑 |
| 视频 | `text-to-video`、`image-to-video`、`audio-driven-video`、`pose-reference-video`、`multi-reference-video` | 根据图片、音频和姿态参考视频推断要求，并检查 `require` |
| 转写 | `timed-transcription`、`word-timestamps` | 基本要求是带时间的转写；需要逐词字幕时显式要求 `word-timestamps` |

视频有 `audio` 时要求 `audio-driven-video`，有 `referenceVideo` 时要求 `pose-reference-video`，有多张参考图时要求 `multi-reference-video`，这些要求可同时出现。只有都不适用时，才按有无参考图推断 `image-to-video` 或 `text-to-video`；例如“单张人物图 + 音频”要求音频驱动，不额外强求普通图生视频能力。显式的 `require` 与推断结果合并去重。

能力声明是适配器支持的范围。某个视频 provider 支持音频驱动和姿态参考，不代表所有模板都能同时接收这两类输入。`execution: agent` 时，Agent 必须继续按输出的指南核对实际模板、节点、模型和输入限制，再提交任务。项目不会把缺失能力降级成另一种生成方式，也不会自动切换 provider。

现有图片和转写命令继续使用，不强制先写需求 JSON。`media:image` 和 `media:transcribe` 会在执行前使用同一套需求检查。例如：

```bash
node cli/remake.js media:image --intent "办公室人物半身照" --image look.png
node cli/remake.js media:transcribe demo --from speech.wav --require word-timestamps
```

`--require` 可重复。`--image-quality` 转换为 `options.quality`，目前仅 OpenAI 图片适配器支持；`--session` 和 `--input-fidelity` 已移除。只有准备需求或检查代码不代表授权出图、出片。

## 结果与落地边界

- 程序出图交付 `{ path, sourcePath?, provider }`：`path` 必须是实际非空文件的绝对路径，提供 `sourcePath` 时也必须是绝对路径；`provider` 必须是所选适配器在 `ledgerProviders` 声明的素材来源名。项目检查结果后保留原命令输出；用户仍使用 `media:land` 登记素材。
- 程序出片通过 `media:video --request` 调用 provider 的 `generateVideo`，结果验证后交付本地 MP4，再用 `media:land --kind video` 登记；`--task-id` 调用 `resumeVideo` 只查询和下载已有任务。
- Agent 出片仍按工具指南取得实际视频文件，再使用 `media:land --kind video`。`media:prepare` 不会把 MCP 变成可直接执行的 CLI，也没有新增视频任务队列。
- 转写仍交付 `captions` 可读的 JSON：含 `segments`（可内嵌 `words`）或顶层 `words`，文字与起止时间以秒表示。项目检查结构和时间，保留原字段再写入 `assets/<id>.transcript.json`。明确要求 `word-timestamps` 时，还会检查实际结果是否满足词级时间要求；仅有句子级时间不能冒充词级时间。
- 模板名、HTTP 响应形状和工具专属日志由适配器处理。素材目录、台账字段、`video:add` 和后续合成流程不依赖这些细节。

## 配置

```json
{
  "media": {
    "image": { "provider": "codex-image" },
    "video": { "provider": "comfy-mcp", "url": "http://127.0.0.1:8188/" },
    "transcribe": {
      "provider": "mlx-whisper",
      "healthUrl": "http://127.0.0.1:<port>/health",
      "transcriptionUrl": "http://127.0.0.1:<port>/v1/audio/transcriptions",
      "apiKeyFile": "~/path/to/api-key",
      "deployDir": "~/path/to/deploy",
      "language": "en"
    }
  }
}
```

取值顺序：环境变量，然后 `video-remake.json`，然后默认值。

| 设置 | 环境变量 |
| --- | --- |
| `media.image.provider` | `VIDEO_REMAKE_MEDIA_IMAGE` |
| `media.video.provider` | `VIDEO_REMAKE_MEDIA_VIDEO` |
| `media.transcribe.provider` | `VIDEO_REMAKE_MEDIA_TRANSCRIBE` |
| `media.video.url` | `COMFYUI_URL` |
| `media.transcribe.healthUrl` | `WHISPER_HEALTH_URL` |
| `media.transcribe.transcriptionUrl` | `WHISPER_TRANSCRIPTION_URL` |
| `media.transcribe.apiKeyFile` | `WHISPER_API_KEY_FILE` |
| `media.transcribe.deployDir` | `WHISPER_DEPLOY_DIR` |

以上表格是默认工具的设置。MLX 的 `model`（默认 `whisper-large-v3`）和默认 `language` 只能写在配置文件里；单次转写仍可用 `--language` 覆盖语言。配置中的路径支持 `~/`，相对路径按工作区解析。未知 provider、未知任务名或不属于所选 provider 的设置会报 `CONFIG_INVALID`。`video-remake.json` 已被 gitignore；本机路径、地址和密钥只放在这里或环境变量中。`media:doctor` 的可公开设置由各 provider 的 `publicSettings` 声明，不打印密钥文件和安装路径。

### 可选转写工具

默认保持 `mlx-whisper`；新增适配器不会修改本机选择，不会自动回退、安装依赖或启动服务。四种工具都接收本地音频文件，使用相同命令：

```bash
node cli/remake.js media:doctor --task transcribe
node cli/remake.js media:transcribe demo --from speech.wav --require word-timestamps
```

| provider | 实际执行 | 语言 | 准备条件与限制 |
| --- | --- | --- | --- |
| `mlx-whisper`（默认） | 已部署的 HTTP 转写服务 | 如 `zh`、`en`，以服务为准 | 单文件 ≤64 MiB；官方 Python 包不等于 HTTP 服务；[指南](../.agents/skills/remake-media/providers/mlx-whisper.md) |
| `aliyun-asr` | 百炼 Paraformer：临时上传 → 提交任务 → 有界轮询 → 下载结果 | 如 `zh`、`en` | 百炼密钥及对应区域权限；临时上传仅适合开发测试；[指南](../.agents/skills/remake-media/providers/aliyun-asr.md) |
| `faster-whisper` | 指定 Python 环境中的本地进程 | 如 `zh`、`en` | 另行安装 Python 包并准备模型；默认 CPU/int8；[指南](../.agents/skills/remake-media/providers/faster-whisper.md) |
| `azure-speech` | Azure Fast Transcription，API `2025-10-15`，multipart 文件直传 | 完整 locale，如 `zh-CN`、`en-US`；兼容 `zh`、`en` 简写 | 支持该接口的区域及 S0 资源；F0 实时免费额度不适用于此接口；[指南](../.agents/skills/remake-media/providers/azure-speech.md) |

切换时替换 `media.transcribe` **整个对象**，不要混用上一个 provider 的字段。下面分别是该对象的示例（不是同时配置四套工具）：

百炼（默认中国内地北京端点；密钥区域须匹配）：

```json
{
  "provider": "aliyun-asr",
  "apiKeyFile": "~/path/to/dashscope-key",
  "model": "paraformer-v2",
  "language": "zh"
}
```

faster-whisper（Python 指向已经安装好包的独立环境；默认 `localFilesOnly: "true"` 只使用已准备好的模型，允许下载需显式设为字符串 `"false"`）：

```json
{
  "provider": "faster-whisper",
  "python": "~/path/to/venv/bin/python",
  "model": "large-v3",
  "device": "cpu",
  "computeType": "int8",
  "language": "zh"
}
```

Azure（示例区域必须替换为实际 Speech 资源支持的区域）：

```json
{
  "provider": "azure-speech",
  "endpoint": "https://eastus.api.cognitive.microsoft.com/",
  "apiKeyFile": "~/path/to/azure-speech-key",
  "language": "zh-CN"
}
```

新增工具的完整字段和环境变量见各自指南。云端 doctor 只检查本地配置和密钥文件，不调用转写，不代表账户权限、余额和区域已经验证；faster-whisper doctor 仅检查 Python 和包，不加载或下载模型。默认 MLX 有健康检查地址时继续探活。新增三套适配器目前仅通过模拟接口/进程测试，尚未做真实服务或模型的端到端验证。

所有适配器输出以秒为单位的 `segments` / `words`，云服务的毫秒字段在适配器内转换；仍由通用入口验证结果，再写 `assets/<id>.transcript.json`。指定 `--require word-timestamps` 后，缺少实际词级时间会失败，不伪造逐词时间或静默降级。云端任务提交后遇到超时/断线不自动重提，需先检查服务端任务状态，避免重复计费。

## 依赖的外部接口

升级外部项目时，先确认以下约定没有变化。

**ComfyUI MCP**

- Agent 侧工具：`server_info`、`auth_status`、`search_templates`、`run_template`、`run_workflow`、`job`、`fetch_outputs`、`validate_workflow`、`workflow_deps`、`install_node`、`restart_comfyui`、`generate_image`。参数名 `workflow_path`、`out_dir`、`prompt_id`。
- 模板：`video_minimax_h3_r2v`、`video_minimax_h3_fun_controlnet_union`、`video_minimax_h3_multiframe_reference`，以及 `video_fastvideo_fasth3_*`。
- CLI 探活读 ComfyUI 的 `GET <url>/system_stats`，从 `system.comfyui_version` 取版本。

**MLX Whisper 服务**

- `GET <healthUrl>` 返回 `{"status":"ok"}`。
- `POST <transcriptionUrl>`，multipart 字段 `file`、`model`、`language`（可选）、`response_format=verbose_json`；要求词级时间时增加 `timestamp_granularities[]=word` 和 `segment`；有密钥文件时带 `Authorization: Bearer <第一行>`。服务需实际开启 MLX 的 `word_timestamps=True`。
- 响应 JSON 含 `segments`（可带 `words`）或 `words`，`remake captions` 直接读取。请求体上限 64 MiB。

## 接入新的 provider

1. 在 `src/media/providers/<id>.js` 导出 provider 对象：`id`、`task`、`label`、`guide`、`ledgerProviders`、`testedVersion`、`execution`、`capabilities`、`publicSettings`、`fields` 和 `doctor(settings, deps)`。`execution` 选 `program` 或 `agent`；`capabilities` 只声明实际支持的上述能力；`publicSettings` 只列可公开的配置键。`fields` 中每项声明 `env`、`type: path|url|string|executable` 和可选 `default`。`executable` 用于可执行程序：裸命令保留 PATH 查找，带路径分隔符时按工作区解析并支持 `~/`。`deps` 包含环境、可注入的网络/子进程调用与等待函数，doctor 和 transcribe 都从通用入口透传，不为具体品牌添加分支。
2. 需要读取本地配置（如 ComfyUI 工作流）时可实现异步 `prepare(settings, request)`；通用准备与执行入口都会调用，必须保持离线且不修改文件。有专属选项或额外输入限制时，实现可选的同步纯校验 `validateRequest(request)`；校验失败时抛出 `appError`，不提交任务、访问网络或修改文件。不实现此方法时，项目默认拒绝非空 `options`。程序出图实现 `generateImage(settings, request, deps)`，程序出片实现 `generateVideo(settings, request, deps)`，都返回上述文件结果；可选 `resumeVideo(settings, taskId, request, deps)` 仅恢复查询和交付，不重新提交；程序转写实现 `transcribe(settings, request, deps)`，将服务返回转换成上述转写格式。输入中的参考文件路径已经按工作区解析，HTTP、子进程等外部调用通过 `deps` 注入，便于模拟测试。Agent 执行的适配器无需假装实现程序调用，在指南里写清如何交付文件。
3. 在 `src/media/config.js` 的 `PROVIDERS` 中登记。不为新 provider 在通用制作流程中增加产品名判断。
4. 在 `.agents/skills/remake-media/providers/<id>.md` 写专属指南，包括认证、选项、能力限制、执行步骤、长任务查询和素材来源名；主技能按返回的 `guide` 路由。
5. 在 `test/` 补模拟测试：同一素材需求按配置选择不同实现；缺少能力时在外部调用前失败；合规结果进入原落地流程；不合规结果在写入前失败。测试不访问真实服务。
6. 在本机 `video-remake.json` 中选择新 id 并配置该 provider 的设置。更改共享默认值是单独决策；增加适配器不会自动切换现有默认工具。
