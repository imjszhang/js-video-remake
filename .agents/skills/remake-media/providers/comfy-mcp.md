# 出片 provider：comfy-mcp

`media.video.provider` 为 `comfy-mcp`（本项目默认）时使用。`execution` 为 `agent`，Agent 直接调已注册的 MCP 工具，支持 MCP Hub 和原有 Comfy MCP 直连两种方式。生成结果取得本地文件后，落到制作目录的 assets。

先运行 `node cli/remake.js media:doctor --task video --json`，按当前配置选择分支：

- **Hub。** `media.video.hubUrl` / `hubTokenFile`，或环境变量 `COMFY_MCP_HUB_URL` / `COMFY_MCP_HUB_TOKEN_FILE`，必须成对配置。地址是完整服务端点，例如 `http://hub-host:8899/mcp/comfyui`。令牌使用项目独立设备令牌，写入本机忽略的 `.secrets/comfy-hub.token`，权限为 `0600`，不使用管理员密钥。doctor 会初始化 MCP、检查工具目录并调用 `server_info`，核对生成所需工具和远端在线状态。失败不回退直连，不代表模板或模型已就绪。
- **直连兼容。** 没有 Hub 字段时，doctor 只检查 `COMFYUI_URL` / `media.video.url` 指向的 ComfyUI，不检查 MCP 是否注册。网关要求密钥时，配置 `media.video.apiKeyFile` 或 `COMFYUI_API_KEY_FILE`，探活会带上 `Authorization`。直连 Comfy MCP 只转发主机和端口，拒绝带路径的地址；实际出片以 MCP 自己的 `COMFYUI_URL` 为准，不要把 `/services/...` 或 Hub 的 `/mcp/...` 地址写进去。

适合：口播 Take、B-roll、镜头运动。
静帧走出图 provider。用户点名 Comfy 出图时用 `generate_image`，再 `media:land --kind image --provider comfy.generate_image`。

## 需求交接

先用 `media:prepare --task video --request <request.json> --json` 检查需求。通用输入是 `intent`、`images`、`audio`、`referenceVideo`、`duration`、`aspectRatio` 和 `require`，完整格式见 [素材 provider 文档](../../../../docs/media-providers.md)。当前适配器不接受非空 `options`。把输出的参考文件和意图映射到下面的模板输入；不要把模板名写成通用能力。

声明能力为 `text-to-video`、`image-to-video`、`audio-driven-video`、`pose-reference-video`、`multi-reference-video`。这表示适配器可以按下述规则寻找合适的工作流，不保证每个模板支持全部能力或任意组合。需求检查不联网；提交前还要核对目标、模板、节点、模型、时长和画幅限制。声明了文生视频也不改变下文对 t2v 模板的使用限制。

## Agent 环境差异

- **工具名。** Hub 的项目连接名使用 `comfy-hub`；客户端可能加自己的前缀。Cursor 按当前动态工具列表调用；Claude Code 使用实际出现的 `mcp__<server>__<tool>`；Codex 在可用工具中查找对应操作。先检查当前 `tools/list`，按该连接的实际 schema 调用，不从直连工具名推测 Hub 的参数。当前环境没有对应 MCP 连接时说明缺失并停下。
- **直接客户端注册。** 配置 `hubUrl` / `hubTokenFile` 后运行 `node scripts/configure-mcp-hub.mjs`，按项目设置生成 `.codex/config.toml`、`.mcp.json`、`.cursor/mcp.json`，服务名为 `comfy-hub`，再重开直接使用的客户端。脚本支持 `--workspace DIR`、`--url HTTP_MCP_URL`、`--token-file PATH`；不改全局配置、不连接 Hub，任何非本脚本生成的非空 Codex TOML 都会保留并报错，需手动合并。令牌和连接文件必须在项目内、已被 Git 忽略且不是符号链接；连接文件含设备令牌，以 `0600` 权限保存。Hub 连接使用 Streamable HTTP 与 `Authorization: Bearer <设备令牌>`，不打印令牌。原有直连仍可本地 stdio 注册，例如 Claude Code：`claude mcp add comfy-mcp --scope local -e COMFYUI_URL=<…> -- <comfy-mcp 可执行文件>`。本机路径和地址不写进仓库。
- **agent:run。** 在本机 `agent-runtime.json` 顶层设置 `"mcp": { "projectHub": true }` 后，Codex、Claude Code、DeepSeek Harness 任务仅从项目 `media.video.hubUrl` / `hubTokenFile` 加载 `comfy-hub`；不读取上述客户端文件，不继承全局 MCP，无需先运行注册脚本。默认 `false`，`contextMode: project` 本身不启用 MCP。`read-only` 任务只有 9 个查询工具，其他权限最多 17 个，均受既有设备令牌限制。`agent:plan` 不读令牌、不连接 Hub；`agent:doctor` / `agent:run` 会检查令牌和远端状态。执行方式与凭据边界见 [Agent 执行](../../../../docs/agent-runtime.md#在-agent-任务中使用-mcp-hub)。
- **需确认的操作。** `install_node`、`confirm_spend` 等需要用户确认的操作，即使当前环境没有弹出确认，也先问用户。

## 路由

1. `server_info`。Hub 模式检查 `bridge` 与 `remote.online`，远端目标由 Hub 管理员配置；当前设备令牌也必须能访问所需生成工具。直连模式看 `comfy_target`，核对 MCP 自己的 `COMFYUI_URL` 与预期目标一致。
2. 直连的本机 `server.running` 为 false 不代表远端不可用。不要为了出视频去 `launch_comfyui`；Hub 首版不开放远端启停。
3. 按实际 GPU、节点与模型能力选择工作流。Hub 的 `generate_image` / `run_template` / `run_workflow` 提交到服务配置的 ComfyUI，不在客户端执行。
4. 图里有 Partner / `API` 节点：先取得用户同意，同意之前不要 `confirm_spend`。Hub 不提供 `auth_status`，凭据或额度问题由管理员处理；直连有该工具时，`signed_in` 或 `registration_env_key_present` 即可，不要催重登。
5. **MiniMax H3 只走非 API 模板。** 搜 `search_templates(query="MiniMax H3", type="video", exclude_api=True)`，再确认行上 `api` 为 false。允许的 `name`：`video_minimax_h3_*`，以及蒸馏线 `video_fastvideo_fasth3_*`。同名的 `api_minimax_h3_*`、H3 Max、H3 Max Turbo 一律不用，即使标题一样。不要为 H3 传 `confirm_spend`。

按任务选图，不要只认名字前缀：

| 情况 | 模板 |
| --- | --- |
| 口播带原片声道 | `video_minimax_h3_r2v`（参考图 + 音频） |
| 要跟原片口播的姿态 / 动作 | `video_minimax_h3_fun_controlnet_union`（吃姿态参考视频；标题是 Fun ControlNet Union，tags 只有 `ControlNet`，搜 MiniMax 时别漏） |
| 定妆 / 多角度锁身份 | `video_minimax_h3_multiframe_reference` |

不要用 `video_minimax_h3_i2v` 对原片口播（只吃图，会自己生声音）。t2v、continuation、FastH3 只有用户点名或 R2V / ControlNet 明显不合适时再用。

## Hub 出片

Hub 的文件位于服务端。客户端的 `workflow_path` 或 `out_dir` 不能交给 Hub，Hub 返回的素材 ID 也不是本地路径。

1. 将本机工作流、图片、音频和参考片上传到 Hub，取得返回的 `id`（素材 ID）。JSON 工作流的素材 ID 即 `workflow_id`；直接调用 `fetch_template(name=...)` 也可得到当前设备专属的 `workflow_id`。小文件可用 `put_asset(filename=..., content_base64=...)`，上限 8 MiB；大文件走 Hub 素材 HTTP 接口，上限 512 MiB。
2. 工作流用 `validate_workflow(workflow_id=...)` 检查，必要时用 `list_workflow_slots`、`set_workflow_slot` 修改。槽位覆盖使用 `{"address":"6.text","value":"..."}`，修改会返回新的 `workflow_id`，原素材保留。参考文件先通过 `upload_file(asset_ids=[...])` 传入远端 ComfyUI，再把返回的远端文件名填入工作流或模板参数。
3. 调用 `run_workflow(workflow_id=..., request_id=...)` 或 `run_template(name=..., params=..., request_id=...)`。Hub 已固定异步提交，不传 `wait`。为一次逻辑生成保留一个唯一 `request_id`，重试同一提交时复用，不换 ID 重提。用户点名出图时，`generate_image(prompt=..., request_id=...)` 使用同样的任务流程。
4. 保存返回的 `task.id`。使用 `job(task_id=..., action="status")` 查询；`action="wait"` 每次最多等 15 秒。`task.prompt_id` 用于远端核对，Hub 的 `job` / `fetch_outputs` 接受的是 `task_id`。若提交为 `uncertain`，保留任务信息，先核对远端队列，不重复生成。
5. 用 `fetch_outputs(task_id=...)` 取回结果到 Hub，得到 `assets` 与每项的 `download_path`。用同一设备令牌下载到当前项目所在设备；不要给任意第三方 URL 转发令牌。确认文件实际存在、格式正确，再落地。

文件传输使用项目脚本，默认读取 `hubUrl` / `hubTokenFile`，不会调用生成工具：

```bash
node scripts/mcp-hub-files.js upload ./reference.png
node scripts/mcp-hub-files.js download <asset-id> --out ./result.mp4 --sha256 <返回的sha256>
```

上传返回的素材 ID 用于步骤 1–2；下载 ID 来自步骤 5 的 `assets`。推荐始终提供返回的 `sha256`；响应没有文件长度时必须提供，校验失败不会保存文件。下载目录须已存在，已有文件不会覆盖。可用 `--workspace DIR`、`--url HTTP_MCP_URL`、`--token-file PATH` 覆盖连接；密钥从 `0600` 权限的普通文件读取，不用符号链接，也不把值写入命令。

## 直连出片（兼容）

未选择 Hub 时保留原来的 Comfy MCP 参数：`run_workflow(workflow_path=..., wait=false)` 或 `run_template(..., wait=false)`，用返回的 `prompt_id` 查询 `job`，再 `fetch_outputs(prompt_id=..., out_dir=...)`。这里的文件路径属于运行 Comfy MCP 的机器；如果它不在客户端，还需把结果下载到本机。不要把直连参数用到 Hub 工具上。

## 本地落地

两种连接取得本地文件后，都通过同一入口登记：

```bash
node cli/remake.js media:land <slug> --kind video \
  --from <fetched-mp4> \
  --intent "<description>" \
  --provider comfy.run_workflow
```

`provider`：工作流用 `comfy.run_workflow`，模板用 `comfy.run_template`，只取回文件时用 `comfy.fetch_outputs`。

`--from` 必须是客户端可读取的真实文件，不能填 Hub `asset_id`、`download_path` 或 MCP 那台机器上的路径。工具参数以当前连接的 schema 为准。

## 对齐

Comfy 片段没有词级时间。要对齐口播，落地后再走转写 provider（`remake media:transcribe`）。不要指望 `build` 直接吃 Comfy 任务。

复刻原片光线时，Pose Control 只传姿态关键点，不会保留原片照明。先把定妆图与同机位原片帧并排比较主光方向、鼻影、耳根和颈侧暗部，以及背景的明暗关系；明显不符时先修定妆，不用全局调色代替缺失的光型。视频落地后再抽查每个镜头的开头、中间和结尾，确认说话或转头时光位与阴影保持一致，再进入合成。

## 停

- 搜到 MiniMax H3 但 `api: true` 或 `name` 以 `api_` 开头：丢掉，另找 `video_minimax_h3_*` 或 `video_fastvideo_fasth3_*`。不要改走 LTX / Kling / Seedance 充数，除非用户点名换模型。
- 有原片人像动作要跟、却没用 ControlNet：先看 `video_minimax_h3_fun_controlnet_union`，不要因为 tags 没有 MiniMax 就丢掉。
- 目标或 Hub 服务无法与当前配置对应：先确认，不要当成本机；不会为了继续任务自动切回直连或换服务。
- 缺节点 / 缺模型：先 `validate_workflow`。Hub 首版不开放 `workflow_deps`、`install_node`、`restart_comfyui`，交由服务管理员处理；直连提供这些工具时，安装或重启仍须取得对应授权。远程依赖应安装在远程，不只在客户端下模型。
- 同一 Hub `task_id` 或直连 `prompt_id` 超时只继续查询；Hub 重试提交保留原 `request_id`，不要另起生成。
