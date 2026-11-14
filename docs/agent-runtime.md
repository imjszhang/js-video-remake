# Agent 执行

本项目通过 `js-agent-runtime` 调用本机 Agent CLI，记录任务输入、执行结果和日志。当前锁定本仓 `vendor/` 中的 `0.2.3-mcp.1` 本地打包版本，包含显式 MCP 接入接口，尚未发布到 npm；`npm ci` 从锁文件和仓内包复现安装。Node.js 要求为 22.15.0 或更新版本；DeepSeek Harness `@deepseek-ai/dsh@0.2.1-rc.2` 已作为项目依赖锁定，`npm ci` 会安装到本项目 `node_modules/.bin/dsh`。Codex 和 Claude Code 仍需在本机单独准备。

## 配置与首次运行

在项目根目录执行：

```bash
npm ci
cp agent-runtime.example.json agent-runtime.json
```

编辑本机 `agent-runtime.json`，选择目标并设置 `enabled: true`。示例的四个目标默认全部禁用，缺省目标为 `deepseek-flash`，模型为服务端提供的 `deepseek-flash`。本机配置已加入忽略规则，不提交 git；配置中只放环境变量名称，不放 API key。

将本项目的 `DEEPSEEK_API_KEY` 保存在根目录 `.env.agent.local`，格式为 `DEEPSEEK_API_KEY="你的密钥"`，文件权限设为 `600`。该文件已忽略 Git；不要使用指向其他项目的符号链接。`agent:run` / `agent:doctor` 仅在当前进程没有设置所选目标的 `apiKeyEnv` 时，从这个文件读取对应的一个密钥，不导入其他环境设置，也不修改进程全局环境。`agent:plan`、`agent:config` 和历史记录命令不读取密钥文件。

启用默认目标并保存密钥后，可直接运行：

```bash
npm run agent:doctor
npm run agent:run -- --instruction '只读检查本项目并报告结果'
```

无需额外 `--env-file` 或其他项目路径。npm 会将本项目 `node_modules/.bin` 放到 PATH；本机配置也可以直接将 `harness.executable` 设为本项目 `node_modules/.bin/dsh` 的绝对路径。本项目包装层和 runtime 不加载普通 `.env`，但 DeepSeek Harness 自身可能读取工作目录中的 `.env`。

| 示例目标 | 本机 CLI / 认证方式 | 模型与上下文 |
| --- | --- | --- |
| `codex-native` | `codex`，使用 CLI 已有的 ChatGPT 登录 | `gpt-6.1-sol` |
| `claude-local` | `claude`，使用 CLI 的用户配置及认证 | `configured`，由本机设置选择模型；`contextMode: project` |
| `deepseek-flash` | 本项目的 `dsh`，从环境变量或 `.env.agent.local` 取 `DEEPSEEK_API_KEY` | `deepseek-flash`；Messages 根地址 `https://api.deepseek.com/anthropic`；`contextMode: project` |
| `codex-api` | `codex`，从 `OPENAI_API_KEY` 取密钥 | `gpt-6.1-sol`；Responses 地址 `https://api.openai.com/v1` |

先在对应 CLI 完成本机登录，或设置相应 API key 环境变量 / `.env.agent.local`。`harness.executable` 可以改为本机 CLI 的绝对路径。四个示例的权限均为 `workspace-write`；现有本机配置保留用户选择的权限。

```bash
npm run agent:config
npm run agent:doctor -- --target codex-native --check-login
npm run agent:plan -- --target codex-native \
  --instruction '阅读项目说明，检查制作流程并提出改进建议'
npm run agent:run -- --target codex-native \
  --instruction '阅读项目说明，检查制作流程并提出改进建议'
```

`doctor` 检查 CLI 能否返回版本信息；`--check-login` 额外检查本机登录元信息。API 目标检查所需模型密钥能否从环境变量或本机文件取得，不发送模型请求。显式启用项目 MCP Hub 时，还会读取设备令牌并检查 Hub 工具与远端 ComfyUI，不提交生成。检查通过不能证明模型端点、账号额度或生产工作流就绪。禁用目标仍可检查配置、执行 `doctor` 和预览 `plan`，只有 `run` 要求显式启用。

## 配置字段

配置查找顺序为 `--agent-config FILE`、`VIDEO_REMAKE_AGENT_CONFIG`、项目根目录的 `agent-runtime.json`。相对配置路径以项目根目录解析。文件不存在、字段拼错或目标配置无效时直接报错，不自动创建或回退到其他目标。

| 字段 | 约定 |
| --- | --- |
| `schemaVersion` | 必须为 `1` |
| `defaultTarget` | 可选，必须对应已有目标；命令行 `--target` 优先 |
| `timeoutMs` | 默认 `600000`，整数范围 `1000–86400000` |
| `mcp.projectHub` | 可选布尔值，默认 `false`；`true` 时仅载入项目配置的 `comfy-hub` |
| `targets` | 目标数组，每个目标的 `name` 必须唯一 |
| `targets[].enabled` | 布尔值，省略为 `false` |
| `targets[].harness` | `adapter`、`executable`、`permission`，以及可选的 `contextMode` |
| `targets[].backend` | 认证、模型与 API 协议等，按 runtime 对应 adapter 校验 |

顶层和目标对象拒绝未知字段；harness/backend 也由 runtime 校验。Codex 的 API 目标使用 `responses`，Claude Code / DeepSeek Harness 的 API 目标使用 `anthropic-messages`。API 目标通过 `apiKeyEnv` 指定环境变量名。

没有 `--target` 或 `defaultTarget` 时，只有配置中恰好一个目标才会自动选择；多个目标必须明确选择。`permission` 支持 `read-only`、`workspace-write`；`bypass` 仅适用于 runtime 支持的 Claude 本机配置或 DeepSeek Harness 组合，应按任务需要自行配置。

## 在 Agent 任务中使用 MCP Hub

先按[素材服务说明](media-providers.md#通过-mcp-hub-连接-comfyui)配置项目 `media.video.hubUrl` / `hubTokenFile`，沿用已有设备令牌；令牌需要访问指定 ComfyUI 服务。然后在本机 `agent-runtime.json` 的顶层添加以下字段，保留已有目标和其他设置：

```json
{
  "mcp": {
    "projectHub": true
  }
}
```

省略或设为 `false` 时，任务继续隔离 MCP，不读取 Hub 令牌。设为 `true` 时，包装层只从当前项目的 `media.video.hubUrl` / `hubTokenFile` 提供一个名为 `comfy-hub` 的 HTTP MCP 服务；不继承全局 MCP，也不读取 `.mcp.json`、`.codex/config.toml` 或 `.cursor/mcp.json` 的服务列表。`codex`、`claude-code`、`deepseek-harness` 三种 adapter 均支持，`contextMode: project` 本身不会打开 MCP。

`agent:run` 不需要先执行 `scripts/configure-mcp-hub.mjs`；该脚本仍用于直接打开的 Codex、Claude Code、Cursor 会话。两种启动方式使用同一个项目 Hub 地址与设备令牌，但各自决定如何加载连接。

工具范围同时受任务权限和 Hub 设备权限限制，目录展示和实际调用都会检查。Codex 使用原生 HTTP 连接；Claude Code / DeepSeek Harness 由运行器内置的连接桥转发到固定的项目 Hub，仍以 MCP 工具方式调用：

- `harness.permission: "read-only"` 只提供 9 个只读工具：`server_info`、`search_templates`、`get_template`、`nodes`、`validate_workflow`、`list_workflow_slots`、`list_workflow_notes`、`job`、`list_assets`。
- 其他受支持的任务权限最多提供 Hub 的 17 个 ComfyUI 工具；设备令牌的 `read` / `generate` 权限与服务工具范围继续生效，不因为启动 Agent 而扩大授权。生成仍需要当前任务授权，文件与任务流程见 [ComfyUI 指南](../.agents/skills/remake-media/providers/comfy-mcp.md)。

```bash
npm run agent:plan -- --instruction '仅检查 comfy-hub 的服务状态，不生成素材' --json
npm run agent:doctor
npm run agent:run -- --instruction '仅调用 comfy-hub 的 server_info，报告远端状态，不生成素材'
```

`plan` 只记录不含令牌的连接请求描述，不读取令牌、不访问 Hub，也不创建 MCP 文件。`doctor` 和 `run` 会验证既有设备令牌与远端服务；配置或连接无效时直接报错，不改用直连或加载其他 MCP。`run` 会实际调用选定模型执行指令，上面的示例只检查服务状态。

Hub 令牌只在执行时通过子进程凭据环境传入，不拼入 prompt 或命令参数。需要 MCP 临时配置时，文件中只保存环境变量引用，退出时清理；项目包装层和 runtime 都对已知凭据脱敏，运行记录与日志不保存令牌明文。

## 指令与项目上下文

`plan` 和 `run` 必须提供 `--instruction TEXT` 或 `--instruction-file FILE`，二选一。两者会收集相同类型的上下文，但 `run` 每次都会重新读取文件并建立计划，不执行之前输出的 plan 文件。

默认载入项目根目录存在的 `AGENTS.md` 和 `README.md`。`--production SLUG` 可选：它从台账中定位制作，载入 `BRIEF.md`、存在的 `TREATMENT.md` / `PROGRESS.md`，以及绑定参考的 `SOURCE.json` 和存在的 `ANALYSIS.md` / `TIMELINE.md`。

例如将 `my-face` 换成已有制作的 slug：

```bash
npm run agent:plan -- --target claude-local --production my-face \
  --instruction-file productions/my-face/NEXT_TASK.md \
  --input productions/my-face/REVIEW.md \
  --input references/youtube-VIDEO_ID/ANALYSIS.md \
  --skill .agents/skills/remake-media/SKILL.md \
  --timeout-ms 900000 --json
```

`NEXT_TASK.md`、`REVIEW.md` 和示例参考路径需替换为实际存在的文件。`--input`、`--skill` 可重复；`--skill` 会把指定技能文件文本加入任务，不自动附带它引用的其他文件。所有输入使用项目内的相对路径，必须是 UTF-8 普通文本文件，单文件最多 256 KiB，指令与收集的输入总计最多 1 MiB；不接受符号链接、越界路径、`.env`、已知凭据文件、本机配置或依赖目录。

`--timeout-ms` 覆盖本次执行时限，范围与配置中的 `timeoutMs` 相同。`--json` 可查看完整 prompt、执行参数和输入哈希。`plan` 只读项目输入，不执行 CLI、读取 API key 或 Hub 设备令牌、创建运行目录或修改项目；启用项目 Hub 时只包含无令牌的连接请求描述。

## 执行范围

运行的 cwd 是实际项目根目录。Agent 直接读写本项目，权限由所选 CLI 按 `harness.permission` 实施。输入哈希用于记录当次读取内容；本项目不创建 staging 工作区，也不把输入列表当作文件访问沙箱或冻结快照。

runtime 默认收紧自动技能发现。需要技能时可用 `--skill` 明确传入；Claude Code 的 `claude-config` 和 DeepSeek Harness 可通过 `contextMode: project` 使用其支持的项目上下文。外部 CLI 不继承发起方的对话、附件、已连接 MCP 工具或插件能力；需要的资料应作为项目文件传入。MCP 默认关闭，仅在 `mcp.projectHub: true` 时由包装层提供当前项目的 `comfy-hub`，不导入其他全局或项目 MCP。

任务提示要求保留已有制作、草稿和交付版本，但这是一条提示约定，不是文件覆盖保护。包装层不会在成功后自动导入产物、发布、重试或恢复任务；任务本身仍按用户指令执行。

## 状态、日志与取消

`run` 在前台执行并生成唯一 run ID；普通输出模式在启动时显示 ID，结束时输出状态、记录路径和 Agent 结果。`--json` 模式保持单一 JSON 结果，运行期间可在另一个终端用 `status` 查看 ID。同一项目及同一存储目录下，同一时间只允许一个运行任务。

```bash
npm run agent:status
npm run agent:status -- RUN_ID
npm run agent:logs -- RUN_ID --stream stdout --lines 100
npm run agent:logs -- RUN_ID --stream stderr --lines 100
npm run agent:logs -- RUN_ID --stream events --lines 200
npm run agent:cancel -- RUN_ID
```

把 `RUN_ID` 换成 `status` 返回的 ID。状态包括准备中 `preparing`、运行中 `running`、成功 `completed`、失败 `failed`、取消 `cancelled`、超时 `timed_out`；原执行进程已消失时显示 `interrupted`。失败、取消或超时会返回非零退出码，并保留已有记录。

`cancel` 写入取消请求，由当前执行进程接收并终止其子进程；返回 `cancel_requested` 后，可用 `status` 确认最终状态。在运行终端按 Ctrl+C 也会请求取消。已经结束的任务返回当前状态，不重新执行。

日志默认读取 stdout 最后 100 行；`--stream` 可选 `stdout`、`stderr`、`events`，`--lines` 范围为 `1–10000`。每次最多读取日志末尾 1 MiB，不持续跟随。已知 API key、含认证信息的代理地址及常见敏感字段会经过脱敏处理后保存。

记录默认放在 `~/.local/state/video-remake/agents/<workspace-hash>/`。设置 `XDG_STATE_HOME` 后改为其下的 `video-remake/agents/<workspace-hash>/`；`VIDEO_REMAKE_AGENT_HOME` 可直接指定存储根目录。该目录必须与项目目录分离，不能等于、包含或位于项目内。每次运行下有 `run.json`、`task.json` 和 `runtime/` 的日志与结果。

`status`、`logs`、`cancel` 不加载 Agent 配置，因此配置被修改或移除后仍可查看或取消已有运行；使用同一项目及同一存储目录即可。

## 验证

```bash
npm run agent:test
npm test
```

自动化 Agent 测试使用模拟 CLI 验证真实 runtime 的调用、状态、脱敏、超时和取消流程，不调用真实模型。

## 依赖覆盖

`package.json` 的 `overrides` 只匹配精确的旧版本，用来修复锁定依赖带入的审计告警，不跨主版本升级：

| 依赖 | 原版本 | 覆盖为 |
| --- | --- | --- |
| `@modelcontextprotocol/client` | `2.2.0` | `2.3.0` |
| `fflate` | `0.8.2` | `0.8.3` |
| `undici` | `8.11.2` | `8.12.2` |
| `zod` | `4.4.3` | `4.6.7` |

上游依赖升级后，这些旧版本不再出现在锁文件中时，对应条目可以删除。修改后运行 `npm ci`、`npm audit`、`npm ls --all` 和 `npm test`。
