# 转写 provider：mlx-whisper

`media.transcribe.provider` 为 `mlx-whisper`（本项目默认）时使用。调用已部署的 **MLX Whisper 服务**（`whisper-large-v3`）。不会自动安装模型或切换其他转写工具。

参考片已有 VTT / `transcript.json` 时，不要重转。这条能力留给**新口播**。

`execution` 为 `program`，支持 `timed-transcription` 和 `word-timestamps`。通用需求使用 `file`、`language` 和 `require`；当前适配器没有额外的 `options`。`media:prepare --task transcribe --request <request.json> --json` 可提前做本地需求检查，不请求服务或写转写文件。

## 配置

| 设置 | 环境变量 | `video-remake.json` |
| --- | --- | --- |
| 健康检查 URL | `WHISPER_HEALTH_URL` | `media.transcribe.healthUrl` |
| 转写 URL | `WHISPER_TRANSCRIPTION_URL` | `media.transcribe.transcriptionUrl` |
| Bearer 密钥文件（读第一行） | `WHISPER_API_KEY_FILE` | `media.transcribe.apiKeyFile` |
| 部署目录（启停用） | `WHISPER_DEPLOY_DIR` | `media.transcribe.deployDir` |
| 模型 | — | `media.transcribe.model`（默认 `whisper-large-v3`） |
| 默认语言 | — | `media.transcribe.language` |

环境变量优先。这些本地值不要提交。

## 探活

```bash
node cli/remake.js media:doctor --task transcribe
```

未就绪时，先检查部署状态并询问用户是否启动服务。以下命令适用于提供 `manage.sh` 的部署，其他部署使用各自的启动方式：

```bash
cd "${WHISPER_DEPLOY_DIR:?请配置部署目录}"
./manage.sh start whisper-large-v3
./manage.sh status whisper-large-v3 --probe
```

## 转写

使用服务支持的音频格式（文件上限 64 MiB）；需要时可抽取 16 kHz mono wav，但 WAV 不保证比原文件小，超限时应压缩或分段。再转写：

```bash
node cli/remake.js media:transcribe <slug> --from <speech.wav> --language en
```

- 结果写到 `productions/<slug>/assets/<id>.transcript.json`。`<id>` 默认取音频文件名（先用 `media:land --kind audio` 落地的音频可以直接沿用它的 id），否则用 `--id` 指定。已有同名转写时报错，`--force` 覆盖。
- 没有提供语言时使用服务自身的默认值；原有部署默认是 **`zh`**，其他部署可能不同。英语口播显式 `--language en`，或在配置里设 `media.transcribe.language`。
- 命令固定请求 `response_format=verbose_json`；要求 `word-timestamps` 时额外发送 `timestamp_granularities[]=word` 和 `segment`。服务必须实际启用 MLX 的 `word_timestamps=True`，不能假定只设置输出格式就一定会返回词级时间。
- 需要逐词字幕时加 `--require word-timestamps`。项目会检查实际返回的词级时间；只有句子级时间时失败，不会把句子拆成伪造的词级时间。普通转写仍允许分段结果。
- 结果不走 `media:land`。来源记 `local-llm.whisper-large-v3`。

下一步把这份 JSON 做成字幕（命令输出会给出这一行）：

```bash
node cli/remake.js captions <slug> --from assets/<id>.transcript.json
```

命令会按整数帧分组，调用锁定的 HyperFrames 导出 SRT，并在代码视频包内写出可贴进 `#root` 的 `captions/<id>.html`（有多个包时加 `--video <名字>`）。中文按字分组时必须保留 `--preserve-cues`，这条命令已经带上。

## 不要做

- 不要把 OpenAI 兼容转写服务说成本项目的字幕时间轴格式。结果保持上面的 JSON。
- 选中 MLX 时不要擅自安装或切换 faster-whisper；显式选择其他 provider 后按对应指南执行。

## 本地部署边界

官方 `mlx-whisper` 是 Python 库和命令行工具，不自带本适配器依赖的 HTTP 服务或 `manage.sh`。部署时需另行提供上面的健康检查和 multipart 转写接口，将 `whisper-large-v3` 映射到实际模型（例如 `mlx-community/whisper-large-v3-mlx`），并返回以秒为单位的 `segments` / `words`。本项目没有在 doctor 或转写前自动部署服务。参见 [MLX Whisper 官方项目](https://github.com/ml-explore/mlx-examples/tree/main/whisper)。
