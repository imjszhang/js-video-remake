# .video 模板格式

`.video` 是可分发的视频模板：一个代码视频包加上模板声明，打成 zip。拿到的人放进自己的人物视频、口播、音乐、个人信息和字幕文字，在包里一条命令合成成片，不需要安装 video-remake。

## 分层

| 层 | 内容 | 谁改 |
|---|---|---|
| 模板 | 场景、时间轴、人物窗、字幕时间、默认配乐、构建和渲染脚本、锁定的 HyperFrames | 模板作者 |
| 输入 | `inputs.json` 和 `inputs/`：人物视频、口播、音乐、个人信息、字幕文字、画面文字 | 使用者 |
| 输出 | `video.json` 的 `output` | 构建生成 |

时间轴固定：使用者按模板生成的录制稿 `SCRIPT.md` 录口播。人物视频与成片等长，在人物窗里静音播放（第 N 秒的窗口播第 N 秒）；成片的声音只来自 `voice` 和音乐。

## video.json 的 template

模板包的 `video.json` 是 `video-package@1`，另有 `template` 字段：

```json
{
  "template": {
    "format": "video-template@1",
    "summary": "一两句话说明模板",
    "inputs": {
      "presenter": { "kind": "video", "duration": "film", "muted": true, "objectPosition": "50% 30%", "placeholder": "frame", "note": "…" },
      "voice":     { "kind": "audio", "duration": "film", "note": "…" },
      "music":     { "kind": "audio", "duration": "film or longer", "note": "…" },
      "identity":  { "kind": "fields", "fields": { "name": { "default": "你的名字", "note": "…" } } },
      "captions":  { "kind": "json", "count": 95, "note": "…" },
      "texts":     { "kind": "json", "count": 745, "note": "…" }
    },
    "fixed": ["使用者不能换的部分"],
    "pack": { "exclude": ["index.html", "slots.json", "SCRIPT.md", "assets/audio/", "inputs.json", "inputs/"] }
  }
}
```

- `inputs` 是给人和 agent 看的输入说明，也是 `inputs.json` 的默认值来源。
- `pack.exclude` 列出不进 `.video` 的路径：生成文件和本制作自己的素材。以 `/` 结尾的是目录。`inputs.json`、`inputs/` 总是排除。

## 包内约定

模板包除了普通代码视频包的文件，还提供：

| 文件 | 作用 |
|---|---|
| `inputs.json` | 使用者的输入（不分发）。`null` 或缺省用模板默认 |
| `npm run inputs` | 检查输入：文件、时长、编码、构图、identity 占位、字幕条数和密度、口播是否落在每句时间窗里。有错误时退出码 1；`--json` 机器可读；`--init` 生成 `inputs.json`；`--init-captions` 导出字幕原稿 |
| `npm run compose` | 检查 → 构建 → 渲染；`--no-render` 只构建 |
| `npm run preview` | 改过画面文字的场景截图（`--at` 任意时刻，`--all` 全部场景） |
| `src/data/texts.json` | 画面文字的默认值，见下节 |
| `SCRIPT.md` | 录制稿，由构建按当前字幕生成 |
| `README.md` | 使用说明 |
| `AGENTS.md`、`CLAUDE.md` | 给 agent 的规则，指向 skill |

依赖只有包内锁定的 npm 包、Node.js 和 FFmpeg。

## 画面文字

画面上要能替换的文字，在场景源码里写成 `{{t:<键>}}`，默认值放在 `src/data/texts.json`：

```json
{
  "b-06-upgrade.01": { "scene": "b-06-upgrade", "ctx": "html", "raw": "全部升级", "text": "全部升级" },
  "a-01-opener.12":  { "scene": "a-01-opener", "ctx": "js", "quote": "'", "raw": "AI 时代", "text": "AI 时代" },
  "a-13-wordmark.06": { "scene": "a-13-wordmark", "ctx": "js", "quote": "'", "raw": "VIDEO", "text": "VIDEO", "plain": true },
  "chapter.01":      { "scene": "hud", "ctx": "html", "raw": "01 — 开场", "text": "01 — 开场", "at": 0 }
}
```

- `ctx` 是文字所在位置：`html` 标记里的文本节点，`js` 脚本里的字符串（`quote` 是它的引号），`js-html` 脚本拼出的 HTML 里的文本。`plain` 表示脚本用 `textContent` 显示，不做 HTML 转义。
- `raw` 是源码里原样的写法，`text` 是显示出来的文字。没有替换时构建原样输出 `raw`，所以默认成片和改造前逐字节一致。
- 使用者的替换写在 `inputs.json → texts` 指向的文件里：`{ "键": "文字" }`，或 `--init-texts` 导出的按场景分组的格式。构建按 `ctx` 转义，替换值里的引号、尖括号、`&` 都安全。
- 安全检查（不用随机数、计时器）在填入文字之前对模板源码做，使用者的文字不会触发也绕不过检查。
- 动效依赖文字长度时要按实际长度计算。
- `npm run inputs` 报告未知的键和比原文宽很多的替换；版面是否放得下，用 `npm run preview` 的截图判断。

## .video 文件

- zip（deflate），UTF-8 文件名，只有一个顶层文件夹 `<id>-vN/`，解压不会散在当前目录。
- 包含：包源码、`package-lock.json`、字体等模板素材、`inputs/README.md`、agent skill（`.agents/skills/video-template/` 和 `.claude/skills/video-template/` 各一份）。
- 不包含：`node_modules`、渲染结果、缓存、`pack.exclude` 里的路径、使用者输入、符号链接。
- `video.json` 里写入 `packed`：`format: "video-pack@1"`、`contentHash`（包内文件的 SHA-256 汇总）、文件数、打包时间；去掉 `source.forkedFrom`。
- 打包时扫描文本文件，发现本机用户目录、内网地址或疑似密钥就拒绝打包。

## 打包

```bash
remake video:pack <slug> --video <名字>              # → deliverables/<id>-vN.video
remake video:pack <slug> --video <名字> --out x.video --force
```

`video:pack` 要求 `video.json` 有 `template.format: "video-template@1"`。打包不修改包本身，也不受冻结规则限制。`deliverables/` 是本机私有目录，不提交；要公开分发时由用户自己决定。

## 使用

### 导入本项目

在「制作工作台」点击「导入模板」，选择下载的模板文件。制作标识可留空（使用模板 id），或填写新的小写字母、数字、连字符标识。同一模板可用不同标识创建多份制作，已有制作不会被覆盖。

命令行等效入口：

```bash
node cli/remake.js video:unpack ./example.video --as my-template
node cli/remake.js video:list my-template
```

导入新建 `productions/my-template/`，包含 `BRIEF.md`、`TREATMENT.md`、`PROGRESS.md`、`assets/`、`drafts/` 和 `videos/<id>-vN/`；台账记录原包 SHA-256、导入时间和包名，不复制参考原片，也不自动绑定包内来源链接。导入本身不安装依赖、不运行包内脚本。模板包内容保持原样。

导入支持 `video-package@1` + `video-template@1`，顶层目录须为 `<id>-vN`，包内须有 `package.json`、`package-lock.json`，HyperFrames 必须与工作区锁定版本一致，并提供 `inputs`、`build`、`compose`、`render` 脚本。压缩文件最多 100 MiB，解压后最多 512 MiB、单项最多 128 MiB、条目最多 10000 个；损坏包、路径越界、符号链接、文件名冲突、安装产物和缓存会被拒绝。校验失败不创建项目，落地失败清理本次目录。

进入导入后的包目录，运行 `npm ci`、`npm run inputs -- --init`、`npm run build`，按 `SCRIPT.md` 准备素材并填写 `inputs.json`。运行 `npm run inputs` 通过后，回到工作区：

```bash
node cli/remake.js video:render my-template
node cli/remake.js video:import my-template
```

这样成片带有工作区的渲染记录，登记后可在「成片放映」播放。`video:import` 是成片入库，不能接收 `.video` 文件。也可直接使用下方网页制作工作台完成准备、预览和合成。

网页接口是 `POST /api/templates/import?slug=<可选制作标识>`，请求体为模板原始字节，需 `Content-Type: application/octet-stream` 和 `X-Remake-Action: import`。成功返回 201 与制作标识、包目录等信息，重复返回 409，上传过大返回 413；不接受跨站请求。

### 网页填写、预览与合成

导入后，项目页分为「模板工作台」和「成片放映」。前者用于改造模板、填写素材和合成；后者只播放已经合成入库的视频。模板版本和成片版本分别标注，选择一个尚未合成的模板不会让已有成片变成该版本。

在「模板工作台」选择当前模板版本，再按「改造模板」「填写素材」「预览与导出」切换步骤。无需改造时可以直接填写素材；当前版本是否已有可播放成片会单独提示。

1. 在「填写素材」填写名字、账号等模板声明的个人信息；上传人物录像、口播或背景音乐。人物录像可同时作为口播声音。网页把文件保存到当前包的 `inputs/uploads/`，支持恢复默认。影音单文件最多 1 GiB，字幕和文字 JSON 最多 2 MiB。人物画面起点和取景位置可单独调整。
2. 点击「准备录制稿」。首次操作自动运行锁定依赖的 `npm ci`，初始化尚不存在的输入配置并构建录制稿；已有填写内容不会被初始化覆盖。展开录制稿可查看每句时间安排。
3. 点击「检查素材」，查看错误、提醒和检查结果。缺少可选人物素材时沿用占位画面，缺少口播时只有配乐；模板报告的错误会阻止预览和合成。
4. 在「预览与导出」生成画面截图，默认抽取三处画面；也可填写最多 12 个预览秒数。这是静态预览，不是可播放的视频；页面不直接执行或嵌入模板 HTML。中英字幕可在「填写素材」逐句修改并保存后预览；画面文字仍可上传 JSON 替换。字幕继续使用模板的固定条数与时间轴。
5. 点击「合成可播放视频」，自动保存当前填写内容、检查输入、构建、渲染并登记为草稿。任务在后台运行，页面显示当前阶段，支持取消；刷新页面可恢复查看进度，服务重启会将未完成任务标为中断。完成后可进入「成片放映」播放或下载对应版本。

字幕编辑区提供「下载字幕原稿」，下载的是模板原始中英字幕及参考时间，不包含之后填写的替换字幕。逐句编辑器显示每句固定时间窗，并分别编辑中文和英文；首次打开会读取当前已保存或已上传的字幕。保存后保留其他素材设置，清除过期静态截图，再通过「保存后预览」构建新截图。字幕保存不会自动修改口播声音，若更换了内容，还需要上传对应录音。

字幕不可增删或修改时间，中文不能留空，英文可留空，每条每种语言最多 2,000 字。若另一页面已保存更新，会提示重新读取，避免覆盖别人的修改。已合成版本仍可查看字幕和下载原稿，编辑前需「复制为新版本继续编辑」。目前内联编辑识别 `src/data/captions.json` 中的标准 `[开始秒数, 结束秒数, 中文, 英文]` 原稿；没有可识别原稿的外部模板会说明不支持，仍可使用 JSON 上传入口。

导出 `.video` 得到的是可复用模板包，和合成视频是两个独立操作。仅完成 Agent 改造、静态预览或模板导出，都不会自动生成可播放成片。

准备、检查、预览和合成均会运行模板自己的代码，只对已选择的模板执行固定操作；导入和只读查看不会运行代码。处理期间锁定该模板的填写与上传，避免成片和输入不一致。已登记草稿的包不可修改，可点击「复制为新版本继续编辑」创建新的可编辑版本。

工作台接口前缀为 `/api/projects/<slug>/templates/<包名>`：`GET /editor` 读取声明、输入、录制稿、Agent 可用状态与任务；`PUT /inputs` 保存 `{inputs}`；`GET /captions` 读取原稿、当前字幕、固定时间窗和修订标识，`GET /captions/original` 下载原始字幕 JSON；`PUT /captions` 保存 `{rows:[{zh,en}], revision?, inputs?}`（提供修订标识时检测过期更新），不会更改时间轴；`POST /assets?kind=...&filename=...` 上传原始字节；`POST /jobs` 启动制作操作 `{action: prepare|check|preview|compose|fork, at?: [秒数]}`，也支持下文的 `generate` 和 `export`；`GET /jobs/<id>` 查询进度，`POST /jobs/<id>/cancel` 取消；`GET /preview/<图片名>` 只读取校验后的预览图片。写操作需要 `X-Remake-Action: template`，JSON 请求需要 `Content-Type: application/json`，素材上传需要 `application/octet-stream`。网页不接受包外绝对路径或符号链接素材。

### 独立使用

见 `.agents/skills/video-template/SKILL.md`（也随每个 `.video` 分发）。简要：

```bash
unzip xxx.video && cd <id>-vN
npm ci
npm run inputs -- --init && npm run build     # inputs.json + SCRIPT.md
# 按 SCRIPT.md 录口播，填 inputs.json
npm run inputs && npm run compose
```

## 用提示词生成新模板

填写人物素材是使用现有模板；改变模板的场景、布局、视觉风格或动画是模板创作。网页通过提示词调用已配置的 Agent 来完成后者，由 Agent 理解当前包并修改源码，不把用户要求转换成有限的样式预设。

1. 在「模板工作台」先选择模板，再选择它的版本，进入「改造模板」，选择“创建新模板”或“迭代当前模板”，填写名称和修改要求。例如：「保留内容结构和时间轴，改成简洁的产品发布会风格，减少装饰，让标题有更多留白。」
2. 在「Agent Harness / 模型」中选择执行组合，例如 `Codex CLI · gpt-6.1-sol` 或 `DeepSeek Harness · deepseek-v4-pro`，再点击生成按钮。列表显示 Harness 和模型，不显示本机配置的内部名称。系统准备不含上一版个人输入和素材的副本，让 Agent 读取模板约定及源码后实施修改。原版本与已有成片保留，冻结版本也可以作为创作基础。
3. 查看生成进度。Agent 完成后，系统自动构建、检查并生成画面预览；检查失败时最多交给 Agent 修复一次。仍失败或用户取消时，不将未通过验证的版本作为生成结果。
4. 查看新版本的静态预览，按需展开修改说明。如需继续调整同一个模板，选择“迭代当前模板”，再填写下一条提示词；另做一种风格时选择“创建新模板”。满意后在「预览与导出」点击「导出 .video 模板」，下载可独立解压使用的源码包；需要播放时，先填写素材并执行「合成可播放视频」。

网页会提前检查 Harness 启动程序是否存在且可执行，不会为了这项检查调用模型。不可用选项会说明原因并禁用；若之前已选中该选项，保留选择并提示修复，不会自动更换模型。提交生成前会再次检查，缺少启动程序时直接提示安装或更新执行路径，不创建新模板副本。

模型设为 `configured` 时，网页明确显示“跟随 Harness 本机设置”，不会把它当作模型名称。新生成记录保存当时选用的 Harness 与模型，避免后续配置变化使历史说明失真。命令行 `--target` 仍使用配置中的内部名称来准确选择执行目标。

这条流程需要本机 `agent-runtime.json` 中至少有一个可用且启用的目标，凭据沿用现有 Agent 配置。未配置时页面会说明原因；不会悄悄改用其他模型，也不会用预设换肤冒充 Agent 生成。配置方法见 [Agent 执行说明](agent-runtime.md)。生成会实际调用模型；外部 Agent 不继承当前聊天或 MCP 插件，执行能力和权限由所选 Agent 的本机配置决定。

系统不把使用者的个人录像、口播、上传配乐或填写的个人信息交给 Agent。传入的是清理后的模板源码和本次修改要求；模板源码会由所选 Agent 及其模型服务处理。预览沿用模板默认素材，之后仍可在网页填写自己的素材并合成成片。生成新模板不会自动渲染完整视频或发布内容。

模板身份与版本分开管理：导入的 `example-v7` 保留原作者的 v7，它是来源模板；由它创建的“冷蓝发布会”拥有新的模板身份，从 v1 开始。另一款“森林绿”也有自己的 v1。只有迭代“冷蓝发布会”才产生该模板的 v2、v3，不把不同模板排在一条连续版本线上。来源模板不直接迭代，先创建衍生模板；填写素材和合成视频则是使用模板的制作过程。

每个衍生模板记录来源模板、来源版本，以及当前版本直接基于哪个版本创建。旧数据按已有来源与标题关系兼容显示，已有包路径、冻结源码和成片保持原样；导出时写入规范的模板身份、独立版本与来源记录，重新导入仍可辨认关系。

命令行使用同一生成流程：

```bash
node cli/remake.js video:generate my-template --video example-v1 \
  --mode derive --title "简洁发布会模板" \
  --prompt "保留内容结构和时间轴，减少装饰，增加标题留白，调整为简洁的产品发布会风格"
# 可用 --target 指定已配置并启用的 Agent
# derive 是默认模式：创建独立模板 v1。下文包名请替换为生成结果返回的名称。
# 迭代同一模板：保留模板身份，取该模板下一个版本号
node cli/remake.js video:generate my-template --video template-012345abcdef-v1 \
  --mode revise --title "简洁发布会模板" --prompt "保持当前风格，让开场标题更清晰"
node cli/remake.js video:pack my-template --video template-012345abcdef-v2
```

修改保存在新版本的模板源码中，导出后可独立构建，不依赖本机网页。包内的依赖锁定与模板接口仍须通过检查。提示词可以提出场景、布局或动画要求；能否完成取决于模板结构和 Agent 执行结果，不能仅凭 Agent 的文字回复认定成功。

工作台 `POST /jobs` 支持 `generate`，请求体包含 `action`、`title`、`prompt` 和可选 `target`、`mode`（`derive` 或 `revise`，默认 `derive`）。任务提供进度、结果或失败原因，并支持取消及刷新后恢复查看。`export` 继续负责打包下载。生成、素材修改和导出共用互斥保护。

旧的 `video:remix --style` 与 `PUT /style` 保留为低层兼容接口，用于已有公共样式配置；它们不是网页提示词创作流程，也不调用 Agent。网页已移除配色、字体、圆角等模板参数控件。

## 做一个模板

1. 从已有的代码视频包 `video:fork` 出新版本。
2. 把个人信息、人物视频、口播、音乐改成从 `inputs.json` 读取，人物视频静音，声音只用 `voice`。
3. 在 `video.json` 加 `template`，写清每项输入；把生成文件和本制作的素材列进 `pack.exclude`。
4. 把画面文字改成 `{{t:键}}` 加 `src/data/texts.json`（已有场景可以用脚本批量抽取：标记里的文本节点、脚本里显示用的字符串和拼出的 HTML 文本；抽完用默认值构建，和改造前逐字节对比）。
5. 补 `tools/inputs.mjs`、`tools/compose.mjs`、`tools/preview.mjs` 和对应的 npm 脚本，改写 `README.md`、`AGENTS.md`。
6. 用本制作自己的输入合成一次，确认和改造前一致；`video:pack` 后在临时目录解压，按 skill 走一遍。

## Web 打包与下载

打开 Web 项目库，选择制作，在「模板工作台」底部展开「全部模板包」，点击「打包 .video」。页面列出已声明 `video-template@1` 的代码视频包；打包完成后点击「下载 .video」保存。已有模板直接显示下载入口，不覆盖已有文件。也可以在当前模板的「预览与导出」步骤导出并下载该版本。打包沿用命令行的素材排除和隐私检查，失败原因显示在页面提示中。


### 网页中的执行配置与实际模型

选择执行配置时，网页显示 Harness、Provider 和模型。下方分别列出接口域名、配置模型、最近成功调用返回的模型及时间；Claude Code 使用本机配置时，只读取 Provider 与模型相关展示字段，不返回密钥、URL 中的认证信息、路径或查询参数。没有成功记录时明确显示“暂无成功调用记录”，不会把配置模型冒充实际结果。历史结果仅证明那次调用，Provider 或默认模型变化后，下一次结果可能不同。

新模板的改造记录保存当时的 Provider、配置模型和本次返回模型；旧记录缺少这些字段时不补造历史信息。查看配置不会发起模型请求。

网页生成区的「Agent 运行记录」是只读运行面板，可展开查看工具调用、输出、服务重试和最终结果。运行时每 1.5 秒刷新，查看较早输出时不会强制滚动到底部。任务记录随状态保存，刷新后可恢复；生成成功后也可以在新模板中查看来源任务记录。面板最多保留最近 200 条、约 64,000 字符，每条最多 2,000 字符；较早内容会提示已省略。原始协议和思考内容不会展示。此功能上线前启动的任务，在结束后会尝试从已保留的 Agent 日志恢复记录，并标明可能只包含末尾部分；没有保留日志时会明确提示。

任务由本地服务异步执行，刷新或关闭网页不会取消；再次打开同一个模板可以继续查看。点击取消、关闭本地服务或服务重启会中断任务，目前不支持服务重启后续跑。

生成新模板时，网页可以分别选择 Agent Harness、Provider 和模型 ID。Provider 来自项目已启用的连接配置，相同连接下的多个模型合并为候选列表，也可以输入该 Provider 支持的模型 ID。Harness 与 Provider 的认证方式、接口协议必须兼容；不兼容的选项会禁用。Claude 的 `configured` 表示使用本机默认模型。候选模型并不代表服务已经确认支持，实际是否可用及返回模型以运行结果为准。

网页选择仅作用于本次任务：服务端生成独立的临时执行配置，使用所选 Provider 的凭据，不改写项目或 Harness 本机默认设置。新 Provider 可以直接在网页的“管理 Provider · 新增 / 编辑”中保存，无需手动修改配置文件。


网页 Provider 管理支持名称、完整接口地址、接口协议、API Key 和可选模型（每行一个，第一个作为默认值）。支持 OpenAI Responses、Anthropic Messages 和 OpenAI Chat Completions，并按协议筛选兼容的 Harness。保存仅做本地校验，不发送模型请求，也不保证服务支持所有填写的模型。

已有连接首次通过网页编辑会建立项目内覆盖，不修改 Harness 本机设置，需要重新填写 API Key。网页保存的密钥不回显，留空表示保留；修改接口地址或协议时要求重新填写密钥。配置与密钥原子写入本机私有 `.env.agent.providers.json`（仅当前用户读写，已被 Git 忽略）；不进入模板包或任务记录。生成期间暂不允许修改 Provider，避免运行中更换连接。保存后立即可用，无需重启服务。

Provider 表单支持“测试连接”和“获取模型列表”，填写接口地址、协议和 API Key 后即可使用，不需要先保存名称或模型。编辑已保存的网页 Provider 时，API Key 留空会使用已保存密钥；接口地址或协议改变后需重新填写。测试请求模型列表接口，不调用模型生成；成功仅说明模型列表接口可访问，不保证推理权限或每个模型可用。获取成功后自动填入最多 50 个模型，服务返回分页或更多模型时会提示结果不完整，可调整后保存。失败不清空原有模型，也不会自动保存配置。

标准接口参考：[OpenAI 模型列表](https://developers.openai.com/api/reference/resources/models/methods/list)、[Anthropic 模型列表](https://platform.claude.com/docs/en/api/models/list)。地址应填写 API base URL，系统保留已有路径并追加 `/models`；根地址补 `/v1`，Anthropic 的未带版本号路径补 `/v1`。不跟随重定向，不把密钥发送到重定向目标；15 秒超时，并限制响应大小。401/403、404/405、429、服务错误或非 JSON 响应会分别显示提示。不提供模型列表接口的服务仍支持手动填写。

模板改造页按“修改要求 → 执行设置 → 创建”排列，生成方式和名称并排，Harness、Provider、模型集中选择。接口与实际模型详情、Provider 管理默认折叠；Provider 管理展开后分为连接信息、验证与模型、保存三个区域。检查失败仍自动展开，历史警告默认收起。窄屏自动改为单列。

在「改造模板」中可展开「新字幕原稿（可选）」，粘贴最多 30000 字的中文、英文或双语稿件，也可直接粘贴长文。它与修改要求独立保存，无需 JSON，不要求保持原模板的字幕条数。Agent 会依据新稿改造源码中的默认字幕、相关画面和逐句时序，重新分句并同步模板的字幕数量；默认保持原总时长和画幅，需要改变时应在修改要求中写明。要求 Agent 保留原稿内容与明确给出的台词，仅在修改要求授权精炼时删减；原时长无法容纳时应明确说明需要缩短原稿或允许调整总时长，单语稿要求补齐另一语言。此操作创建新模板版本，个人录像和口播音频不会带入。

新字幕原稿随网页草稿、任务状态和改造记录保存，可以在运行记录及新模板的改造记录中查看。命令行对应 `video:generate ... --subtitle-script '新的字幕原稿'`。这属于模板内容改造，与「填写素材」内保持原时间轴的逐句字幕编辑不同；系统仍会独立构建、检查和生成预览，再发布新模板。

### 根据字幕生成口播

「填写素材」的字幕编辑下方提供「根据字幕生成口播」。选择中文或英文和本机音色，点击「保存字幕并生成口播」，会先保存当前字幕与个人信息，再在后台生成全片音轨；完成后自动填入口播素材，可直接试听、下载或继续合成。不需要自行录音，原有上传录音入口仍保留。当前使用 macOS 系统语音，需要 FFmpeg / ffprobe，无需 API Key；[语音与时间对齐说明](template-speech.md)。

声音逐句对齐原字幕时间，保留开头、句间和结尾的空白。试听默认跳到第一句，下载的音频仍与全片等长。句子过长会适度加速，超过上限会明确提示缩短哪句；不会截掉整句或悄悄改字幕。再次修改字幕或个人信息，会提示旧口播需要重新生成。

生成与其他模板操作共用异步任务及取消机制，刷新或关网页不会中止，关闭本地服务会中止。失败或取消保留此前的口播，只有成功才替换当前设置。已合成版本需先复制成新版本。

接口：`GET /voice` 获取音色、可用状态及当前口播（含 `stale`）；`POST /jobs` 使用 `{action:"voice", voice:"音色 ID", language:"zh"}`，可带字幕 `revision` 防止使用过期稿；`GET/HEAD /voice/audio` 播放当前口播（支持 Range），加 `?download=1` 下载。路径均位于同一模板 API 下，音频与生成记录保存在该包的 `inputs/uploads/`，沿用模板的个人素材排除规则。
