# 转写 provider：faster-whisper

`media.transcribe.provider` 为 `faster-whisper` 时使用。项目调用指定 Python 环境中的 `faster-whisper` 包，不需要另起 HTTP 服务。项目默认仍是 `mlx-whisper`。

支持 `timed-transcription` 和 `word-timestamps`，`execution` 为 `program`。通用需求使用 `file`、`language`、`require`；没有专属 `options`。已有原片字幕时不重复转写。

## 部署与配置

部署者需要单独准备 Python 环境、安装 `faster-whisper` 并准备 CTranslate2 格式模型（包括 `tokenizer.json`）。适配器不会安装依赖；默认仅使用本地模型或已有缓存，并对 Python 子进程开启 Hugging Face 离线模式，避免缺少 tokenizer 时另行下载。不要因为用户仅要求配置适配器就安装或下载模型。

| 设置 | 环境变量 | 默认值 / 说明 |
| --- | --- | --- |
| `python` | `FASTER_WHISPER_PYTHON` | `python3`；可填独立环境 Python 路径，不要附加命令行参数 |
| `model` | `FASTER_WHISPER_MODEL` | `large-v3`；支持模型名称或已转换模型的绝对目录 |
| `device` | `FASTER_WHISPER_DEVICE` | `cpu`；可选 `cpu`、`cuda`、`auto` |
| `computeType` | `FASTER_WHISPER_COMPUTE_TYPE` | `int8`；GPU 可按设备能力改为 `float16` 等 |
| `language` | `FASTER_WHISPER_LANGUAGE` | 未配置时自动识别；命令的 `--language` 优先 |
| `cacheDir` | `FASTER_WHISPER_CACHE_DIR` | 可选模型缓存目录 |
| `localFilesOnly` | `FASTER_WHISPER_LOCAL_FILES_ONLY` | 字符串 `"true"`；改为 `"false"` 后，真实转写可能从 Hugging Face 下载模型 |

这些字段位于 `video-remake.json` 的 `media.transcribe`，环境变量优先。`python` 支持 PATH 中的可执行文件名（如 `python3`），或独立环境的文件路径；路径支持 `~/`，相对路径按工作区解析。`model` 是模型名称或绝对目录，不展开 `~`。缓存目录使用路径字段，会按工作区解析相对路径。不要把本机配置提交到仓库。

```json
{
    "media": {
        "transcribe": {
            "provider": "faster-whisper",
            "python": "/path/to/venv/bin/python",
            "model": "large-v3",
            "device": "cpu",
            "computeType": "int8",
            "localFilesOnly": "true"
        }
    }
}
```

上游要求 Python 3.9+；音频解码使用自带 FFmpeg 库的 PyAV，无需为了该适配器另外安装系统 FFmpeg。标准 macOS 部署使用 CPU，不能把 Apple GPU 当作 CUDA。NVIDIA GPU 的 CUDA/cuDNN 版本必须与所装 CTranslate2 对齐，具体以对应版本的上游说明为准。

## 检查与调用

```bash
node cli/remake.js media:doctor --task transcribe
node cli/remake.js media:transcribe <slug> --from <speech.wav> --language zh --require word-timestamps
```

doctor 只检查 Python 能启动、包能导入和版本能读取，不创建模型、不下载权重、不做转写。`ready: true` 不代表模型缓存完整或设备支持指定的计算类型。缺包、缺 Python、离线模型缓存缺失或设备不支持时按错误修复部署，不回退其他服务。

每次转写启动一个独立 Python 进程，默认超时 30 分钟，输出上限 32 MiB；长音频超过限制时先分段。模型每次重新加载，适用于制作任务式转写，不是常驻低延迟服务。固定开启词级时间戳，遍历上游返回的生成器后才输出 JSON。所有时间单位是秒，不人为拆字伪造时间。

结果写到 `productions/<slug>/assets/<id>.transcript.json`，来源为 `faster-whisper.transcribe`，随后使用命令输出的 `captions` 指引生成字幕。已有同名文件需显式 `--force` 才覆盖。

## 验证范围与来源

已覆盖模拟子进程响应、配置传递、错误和超时、输出格式检查。尚未在真实 faster-whisper 环境运行模型，不承诺具体速度或准确率。

- [faster-whisper 官方安装与调用说明](https://github.com/SYSTRAN/faster-whisper)
- [WhisperModel 参数定义](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py)
- [CTranslate2 硬件支持](https://opennmt.net/CTranslate2/hardware_support.html)
