---
name: remake-media
description: 在 video-remake 项目中准备图片、视频和转写需求，按 media 配置选择工具、检查所需能力、生成素材并落到 productions/<slug>/assets/。工具的执行方式和专属操作以所选 provider 指南为准。成片和对比片用项目锁定的 HyperFrames 渲染。
---

# remake-media

生成器按配置选择，落地只有一条线。在仓库根目录执行命令。

## 先看配置

```bash
node cli/remake.js media:doctor
```

输出每项任务当前的 provider、执行方式、支持能力、版本、是否就绪和对应指南。先读 [landing.md](landing.md)，再读输出的 `guide`。`execution: program` 表示由项目程序调用；`execution: agent` 表示由 Agent 按工具指南执行，不代表项目命令已能直接调用该工具。

当前内置默认选择如下，具体执行以配置和命令输出为准：

| 任务 | 本项目选用 | 指南 |
| --- | --- | --- |
| 出图：定妆、静帧、产品图 | `codex-image` | [providers/codex-image.md](providers/codex-image.md) |
| 出片：口播、B-roll、镜头运动 | `comfy-mcp` | [providers/comfy-mcp.md](providers/comfy-mcp.md) |
| 转写：新口播、字幕、词级时间 | `mlx-whisper` | [providers/mlx-whisper.md](providers/mlx-whisper.md) |

配置、需求格式和接入说明见 [docs/media-providers.md](../../../docs/media-providers.md)。新增工具不需要修改本技能的通用流程。

图片默认使用 `codex-image`（[指南](providers/codex-image.md)），由当前 Agent 调用内置生图，支持文生图与参考图编辑，不需要 API Key。CLI 无法检查会话登录和额度时，按指南由 Agent 核对，不将未确认误报成就绪。

图片还可显式选择 [openai-image](providers/openai-image.md)、[gemini-image](providers/gemini-image.md)、[aliyun-image](providers/aliyun-image.md)、[comfyui-image](providers/comfyui-image.md)。按对应指南配置，生成前仍需授权；新适配器的 doctor 仅本地检查，不确认云端额度或 ComfyUI 运行状态。

视频默认保留 `comfy-mcp`。新增 [aliyun-video](providers/aliyun-video.md)、[runway-video](providers/runway-video.md)、[minimax-video](providers/minimax-video.md)，通过 `media:video --request <需求.json>` 执行文生或单张首帧图生视频；`--task-id` 只继续查询/下载。实际执行仍需当前任务的生成授权；新适配器 doctor 不调用服务。

转写默认保留 `mlx-whisper`。可选 [aliyun-asr](providers/aliyun-asr.md)、[faster-whisper](providers/faster-whisper.md)、[azure-speech](providers/azure-speech.md)，都通过同一个 `media:transcribe` 入口交付字幕来源 JSON。按当前选择的指南核对语言、部署和认证；本地检查通过不等于模型已缓存、云端权限或额度可用。不自动切换 provider、下载模型或重试收费任务。

## 先整理需求

把素材意图与工具参数分开：意图、参考文件、画幅、时长和所需能力属于需求；模型、服务地址、凭据属于 provider 配置；专属生成选项放在需求的 `options` 中，由所选 provider 校验。

需要提前检查，尤其是 Agent 执行视频任务时，准备需求 JSON：

```bash
node cli/remake.js media:prepare --task video --request <request.json> --json
```

它只读取本地需求、解析路径并检查能力，返回标准化的 `request`、所选 provider、`execution`、`capabilities`、`ledgerProviders` 和指南。不会联网、生成素材或写入台账，也不代表服务就绪或用户已授权。需求中的相对文件路径按工作区解析，不按 JSON 文件所在目录解析。

声明支持某项能力不代表任意输入组合都可执行。Agent 仍需按工具指南核对实际模板、节点、模型和限制。缺少能力时说明缺什么，不删去需求或擅自更换工具。

## 门禁

- 先确认制作 slug（`catalog.json` / `productions/<slug>/`）。没有就停，让用户 `remake start`。
- 先问再出图、出片。Brief 写了「不花额度」或未授权生成时，默认停。只查看或适配本 skill 不代表授权生成。已有明确授权时不必重复确认。
- 只用配置选中的 provider。所选 provider 不可用时说明缺什么并停下，不改用其他生成渠道凑数，除非用户点名。
- 只按所选 provider 的执行方式和指南调用，不用其他插件、工具或素材缓存替代项目的素材落地流程，除非用户点名。
- 原片只读。不复制、不 symlink `video.mp4`。
- 参考片已有 VTT / `transcript.json` 时，不要重转写。
- 落地后只打印接线。不改已有成片工程，除非用户说编进去。

## 流程

1. 整理需求与所需能力；需要时用 `media:prepare` 提前检查。`media:image` 和 `media:transcribe` 在执行前也会检查需求和能力，无需为了使用旧命令强制增加 JSON 文件。
2. 确认 slug 和用户授权，跑 `media:doctor --task <image|video|transcribe>`，按输出的指南执行。程序调用的图片、视频与转写结果由项目检查；Agent 调用的工具由 Agent 核对需求、取得实际文件，再交给统一落地入口。
3. 落地：

```bash
node cli/remake.js media:land <slug> --kind image|video|audio \
  --from <file> --intent "<description>" --provider <ledger provider>
```

4. 要编进片子时，用 `remake video:add <slug> --id <assetId>` 复制进代码视频包，把输出的片段贴进包入口 HTML 的 `#root`。静帧要进成片时，先用 `remake normalize <slug> --id <assetId>` 转成 BT.709 视频，再 `video:add` 转好的那条。
5. 新口播要字幕时，`remake media:transcribe <slug> --from <audio>` 写出 `assets/<id>.transcript.json`，再按输出提示运行 `remake captions`。需要词级时间时加 `--require word-timestamps`；工具声明和实际返回结果都要满足要求。渲染前用 `remake check <slug>`。

## 执行边界

- 实际工具名、参数和长任务查询方式按所选指南及当前工具 schema，不编造缺失的连接或接口。
- 长任务超时不等于失败；优先查询已有任务，避免重复生成和重复扣费。
- 安装依赖、额外付费等超出当前授权范围的操作先确认。本机路径、地址和凭据只放在本地配置。
- 默认 comfy-mcp 保留 Agent 执行方式；其他程序视频适配器通过 media:video 调用。没有统一后台任务队列，超时后按已取得的任务 ID 继续查询，不重复生成。

## 目录

本目录 `.agents/skills/remake-media/` 是唯一源文件。`.claude/skills/`、`.cursor/skills/`、`.codex/skills/` 下的同名目录都是指向这里的软链接，修改只在这里做。
