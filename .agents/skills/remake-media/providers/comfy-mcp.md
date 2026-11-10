# 出片 provider：comfy-mcp

`media.video.provider` 为 `comfy-mcp`（本项目默认）时使用。`execution` 为 `agent`，Agent 直接调 Comfy MCP，不要再包一层 CLI。出的是成片文件，落到制作目录的 assets。

`remake media:doctor --task video` 只检查 `COMFYUI_URL` / `media.video.url` 指向的 ComfyUI 是否可达，不检查 MCP 是否已注册。

适合：口播 Take、B-roll、镜头运动。
静帧走出图 provider。用户点名 Comfy 出图时用 `generate_image`，再 `media:land --kind image --provider comfy.generate_image`。

## 需求交接

先用 `media:prepare --task video --request <request.json> --json` 检查需求。通用输入是 `intent`、`images`、`audio`、`referenceVideo`、`duration`、`aspectRatio` 和 `require`，完整格式见 [素材 provider 文档](../../../../docs/media-providers.md)。当前适配器不接受非空 `options`。把输出的参考文件和意图映射到下面的模板输入；不要把模板名写成通用能力。

声明能力为 `text-to-video`、`image-to-video`、`audio-driven-video`、`pose-reference-video`、`multi-reference-video`。这表示适配器可以按下述规则寻找合适的工作流，不保证每个模板支持全部能力或任意组合。需求检查不联网；提交前还要核对目标、模板、节点、模型、时长和画幅限制。声明了文生视频也不改变下文对 t2v 模板的使用限制。

## Agent 环境差异

- **工具名。** MCP 工具名按 Comfy MCP 自身的名字写。Cursor 通过 `GetDynamicTools` / `CallDynamicTool` 调用（服务名 `user-comfy-mcp`）；Claude Code 中直接出现为 `mcp__<server>__<tool>`，例如 `mcp__comfy-mcp__server_info`；Codex 在当前可用工具中查找对应操作。按实际 schema 调用，参数名以下文为准。当前环境没有 Comfy MCP 时说明缺失的连接并停下，不编造工具名。
- **注册 MCP。** 需要接入时让用户自行注册，例如 Claude Code：`claude mcp add comfy-mcp --scope local -e COMFYUI_URL=<…> -- <comfy-mcp 可执行文件>`。本机路径和地址只放在本地配置，不写进仓库。
- **需确认的操作。** `install_node`、`confirm_spend` 等需要用户确认的操作，即使当前环境没有弹出确认，也先问用户。

## 路由

1. `server_info`。看 `comfy_target`。通过 ComfyUI MCP 的 `COMFYUI_URL` 配置目标地址，并核对返回的目标与配置一致。
2. 本机 `server.running` 为 false 没关系。不要为了出视频去 `launch_comfyui`。
3. 根据实际 GPU 能力配置本机或远程执行。`generate_image` / `run_template` 在配置 remote 时会提交到对应目标。
4. 图里有 Partner / `API` 节点：先问用户。同意之前不要 `confirm_spend`。先 `auth_status`；`signed_in` 或 `registration_env_key_present` 即可，不要催重登。
5. **MiniMax H3 只走非 API 模板。** 搜 `search_templates(query="MiniMax H3", type="video", exclude_api=True)`，再确认行上 `api` 为 false。允许的 `name`：`video_minimax_h3_*`，以及蒸馏线 `video_fastvideo_fasth3_*`。同名的 `api_minimax_h3_*`、H3 Max、H3 Max Turbo 一律不用，即使标题一样。不要为 H3 传 `confirm_spend`。

按任务选图，不要只认名字前缀：

| 情况 | 模板 |
| --- | --- |
| 口播带原片声道 | `video_minimax_h3_r2v`（参考图 + 音频） |
| 要跟原片口播的姿态 / 动作 | `video_minimax_h3_fun_controlnet_union`（吃姿态参考视频；标题是 Fun ControlNet Union，tags 只有 `ControlNet`，搜 MiniMax 时别漏） |
| 定妆 / 多角度锁身份 | `video_minimax_h3_multiframe_reference` |

不要用 `video_minimax_h3_i2v` 对原片口播（只吃图，会自己生声音）。t2v、continuation、FastH3 只有用户点名或 R2V / ControlNet 明显不合适时再用。

## 出片

慢任务不要 `wait=true`：

1. `run_workflow` 或 `run_template`，`wait=false`。
2. 用返回的 `prompt_id` poll `job`（`status` / `wait`）。
3. `fetch_outputs` 收到本地文件。
4. 落地：

```bash
node cli/remake.js media:land <slug> --kind video \
  --from <fetched-mp4> \
  --intent "<description>" \
  --provider comfy.run_workflow
```

`provider`：工作流用 `comfy.run_workflow`，模板用 `comfy.run_template`，只取回文件时用 `comfy.fetch_outputs`。

参数名按 MCP：输入工作流是 `workflow_path`，输出目录是 `out_dir`，任务句柄是 `prompt_id`。不要猜 `path` / `workflow`。

## 对齐

Comfy 片段没有词级时间。要对齐口播，落地后再走转写 provider（`remake media:transcribe`）。不要指望 `build` 直接吃 Comfy 任务。

复刻原片光线时，Pose Control 只传姿态关键点，不会保留原片照明。先把定妆图与同机位原片帧并排比较主光方向、鼻影、耳根和颈侧暗部，以及背景的明暗关系；明显不符时先修定妆，不用全局调色代替缺失的光型。视频落地后再抽查每个镜头的开头、中间和结尾，确认说话或转头时光位与阴影保持一致，再进入合成。

## 停

- 搜到 MiniMax H3 但 `api: true` 或 `name` 以 `api_` 开头：丢掉，另找 `video_minimax_h3_*` 或 `video_fastvideo_fasth3_*`。不要改走 LTX / Kling / Seedance 充数，除非用户点名换模型。
- 有原片人像动作要跟、却没用 ControlNet：先看 `video_minimax_h3_fun_controlnet_union`，不要因为 tags 没有 MiniMax 就丢掉。
- 远程 `host` 不是 loopback、也不是你能确认的那台机：先问用户，不要当成本机。
- 缺节点 / 缺模型：`validate_workflow` → 需要时 `workflow_deps` / `install_node`（安装要用户确认）→ `restart_comfyui`。远程装包装在远程，不要只在本机下模型。
- 同一 `prompt_id` 超时只 poll，不要重提任务。
