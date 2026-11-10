# 方法配方与独立制作

AI 复刻实验把制作知识与制作产物分开。方法配方保存分析方法、约束、自检和修复流程；通用素材单独管理。执行模型从空工程生成本次场景、布局、动画和镜头，再接受外部验收。

模型、Agent Harness 和方法配方分别选择。高阶与低阶是实验角色，不根据模型名字推断能力。历史完整工程模板仍可查看和显式回放，其成绩不计入从空工程独立生成。

## 边界

| 对象 | 保存内容 | 不应包含 |
|---|---|---|
| 任务与参考 | 原片、输入、语言、画面目标、参考测量、冻结验收条件 | 教师已经求解的场景实现 |
| 方法配方 | 制作步骤、构图及运动方法、约束、自检、修复流程、通用示例 | 本片场景代码、完整布局或可直接运行的镜头轨迹 |
| 通用素材包 | 独立人物、道具、字体、纹理及来源记录 | 目标场景组合、绑定原片时间轴的动画、教师成片 |
| 空工程 | 锁版依赖、空入口、渲染接口、通用工具 | 目标视频的人物摆位、分镜和相机路径 |
| 执行工程 | 执行模型本次生成的分析、场景、镜头、派生素材 | 未声明的教师实现和高阶代写 |

“拉远后打印机位于画面中部”可以是任务的可观测约束；完整相机坐标数组属于实现。方法、素材、Skill 附件和工具都不能成为隐藏实现的通道。文件类型和哈希检查能发现已知违规，不能替代对内容语义的审查。

## 配置模型与执行环境

先运行 `npm ci`。Node.js 至少 22.15，媒体检查需要 FFmpeg/ffprobe。模型目标与凭据沿用 [Agent Runtime 配置](agent-runtime.md)。

本地 `reproduction-workflow.json` 把角色映射到 `agent-runtime.json` 中的 target：

```json
{
  "schemaVersion": 2,
  "roles": {
    "teacher": "high-capability-target",
    "extractor": "high-capability-target",
    "executor": "economical-target",
    "reviewer": "review-target"
  },
  "policy": {
    "maxAttempts": 3,
    "maxCalls": 48,
    "maxDurationMs": 5400000,
    "maxToolCalls": 600,
    "maxRenderCalls": 64,
    "allowTeacherAssistance": false,
    "renderProvider": "local",
    "reviewSamples": 2
  },
  "execution": {
    "protocol": "video-remake.staged-execution@1",
    "feedbackMode": "independent",
    "maxStageRevisions": 2,
    "maxFinalSubmissions": 3,
    "maxPreviewJobs": 48,
    "reviewerTimeoutMs": 600000,
    "reserveOverheadMs": 120000,
    "prototypeRequirements": ["character-interaction", "complex-motion"],
    "minPrototypeShots": 2
  }
}
```

`extractor` 未配置时跟随 `teacher`。`--workflow FILE` 与 `--agent-config FILE` 可以指定另一份本地配置。认证留在本机配置或环境变量中，不进入方法配方、素材包或导出的工程。

```sh
node cli/remake.js repro:config
node cli/remake.js repro:doctor --check-login
```

配置与环境检查不调用模型。真实运行冻结目标、工作流、任务、输入、方法、素材、脚手架和工具身份；同一实验不能静默换模型。实际模型名没有返回时保持未知，不能用请求名称代替已观察身份。

本机渲染提供方使用固定的 HyperFrames 0.8.191，传入 `inputs/values.json`，不自动执行候选工程任意声明的 npm、shell 或准备脚本。渲染和阶段预览在出片前先核对素材，并以 `--strict` 渲染，HyperFrames lint 错误直接挡住出片。入口在 `src/index.html` 的复刻工程不跑 `hyperframes check`（它把所给目录当站点根目录，按工程根目录写的脚本路径会 404）；入口在工程根目录时，阶段预览只对当前镜头窗口跑 `check --range`。执行模型需在提交前生成所需源码和派生素材。`renderProvider: agent` 仅适用于 Harness 实际允许浏览器、端口和媒体处理操作的环境；渲染内部调用的完整计数受 Harness 可观察性限制。

## 创建方法与空工程

从教师制作提炼时，教师工程只作为研究输入，方法输出从空目录开始。提炼结果不得复制场景源码、成片或专用相机轨迹。已有经过审查的方法目录和素材目录也可分别冻结：

```sh
node cli/remake.js repro:asset-freeze <asset-directory> --name common-assets --version 1
node cli/remake.js repro:method-freeze <method-directory> --name explainer-method --version 1
node cli/remake.js repro:list
```

方法使用独立类型与版本空间。`AGENTS.md` 提供入口，`.agents/skills/{reproduce,validate,repair}` 保存权威 Skill，方法文档描述分析、搭建、检查与修复。素材版本和内容哈希由配方声明及运行锁定；字体、模型等素材的来源、许可、尺寸和依赖应记录在素材清单中。

任务与参考独立提供，不由方法配方携带一套已完成场景：

```sh
node cli/remake.js repro:generate explainer-method@1 \
  --as learning-method-trial \
  --ref youtube-nFRYgfitomc \
  --spec task.json \
  --inputs inputs.json
node cli/remake.js repro:run learning-method-trial
node cli/remake.js repro:judge learning-method-trial
```

`repro:generate --run` 在创建后立即执行。`repro:instantiate` 与 `repro:trial` 只接受新方法配方，分别对应创建和创建后执行；不再隐式复制历史完整工程模板。任务规格必须显式给出，文件输入使用工作区内相对路径。已有参考来自本项目 source provider，yt-study-archive 仍只是可选数据源实现。

空工程记录初始文件清单、脚手架和素材来源。起点只有中性占位画面；执行模型负责生成本次分镜、场景、布局、动画及镜头。首次实验和全新重试从空起点生成，同一次实验的自修复可以继续使用该执行模型自己的产物。

## 分阶段制作

新运行冻结独立的执行协议、阶段检查策略、反馈方式、检查器和预算身份。工作流配置使用 `schemaVersion: 2`；阶段运行使用 `video-remake.reproduction-run@3`。已有 v1 配置文件和旧运行按原协议读取，不自动升级，也不补造阶段材料或通过记录。未配置工作流的新空工程生成默认使用分阶段流程；有 v1 文件时，先在工作台保存为分阶段配置或显式提供 v2 工作流，再创建新运行。

| 阶段 | 执行者交付 | 宿主检查及阶段意义 |
|---|---|---|
| 冻结与准备 | 空工程与固定任务 | 环境、素材、方法、工具和预算可用；记录起点 |
| 参考分析 | 有来源时间点的观察和镜头表 | 时间覆盖、必查锚点、结构和不确定项齐备；观察仍是执行者声明 |
| 关键镜头验证 | 人物交互、复杂运动等关键镜头实现 | 宿主生成对照证据，执行者检查实际预览；确认材料与自检完成 |
| 分镜制作 | 每镜头场景、动作和镜头路径 | 按镜头保留源码身份、宿主预览和自检；不以模型自报替代质量验收 |
| 全片整合 | 全时间线、字幕、声音和衔接 | 检查首尾、切镜前后、字幕边界及整片材料 |
| 提交检查 | 固定源码检查点与最终成片 | 技术合同、冻结输入、来源审计以及阶段证据新鲜度 |
| 最终双评审 | 同一成片的两份完整报告 | 沿用原有五项标准，每项两票通过才满足验收 |

默认关键镜头策略要求至少两个镜头，并覆盖人物交互与复杂运动。若参考确无某类风险或只有一个镜头，应在创建新运行前通过 `execution.prototypeRequirements` 和 `minPrototypeShots` 显式冻结适用策略，不能在执行中临时放宽。

阶段状态中的“材料检查完成”只证明宿主检查和执行者自检记录齐备。工具可以验证文件、哈希、时间范围、实际渲染和采样；人物动作是否忠实、构图是否接近仍由最终独立评审判断。自报测量、仅有截图文件或自报通过，不是客观视觉质量证明。

`run` 推进合法阶段；`--step` 仅执行下一阶段操作，`--until` 在指定阶段后停止。这些参数不能跳过前置检查。`--stage` 和 `--shot` 用于明确作用范围：

```sh
node cli/remake.js repro:run learning-method-trial --step
node cli/remake.js repro:run learning-method-trial --until prototypes
node cli/remake.js repro:check learning-method-trial --stage shots --shot shot-02
node cli/remake.js repro:repair learning-method-trial --stage shots --shot shot-02
node cli/remake.js repro:status learning-method-trial --json
```

修改镜头表会使依赖它的阶段证据失效；共享场景、相机工具或未知依赖变化按保守原则使相关镜头、整合与最终评审失效。最终提交要求所有必需镜头的证据与当前源码匹配。旧快照和旧评审保留供追溯，不能作为新提交通过的依据。

阶段调用、阶段提交和整片提交分别计数。`maxStageRevisions` 限制局部修订，`maxFinalSubmissions` 限制整片验收提交；全局调用、工具、渲染和时间预算始终累计。`maxAttempts` 保留给历史流程的整片尝试语义，不代表只允许执行若干阶段。创建和推进时须为两份最终评审及必要开销预留预算，不足时保存当前材料并停止，不自动扩容。宿主预览有独立计数；任意原生 shell 内部的渲染调用仍可能不可完全观察。

默认 `feedbackMode: independent` 只使用执行者自检与宿主工具证据。若有高阶模型或人员中途给出针对性制作指导，应记录为 guided/assisted，并与独立试跑分开统计。最终两位评审仍完整判断同一成片，不把其中一位改为中途导演或来源审计员。

## 制作、修复与恢复

```sh
node cli/remake.js repro:status learning-method-trial --json
node cli/remake.js repro:logs learning-method-trial
node cli/remake.js repro:check learning-method-trial --evidence
node cli/remake.js repro:repair learning-method-trial
node cli/remake.js repro:judge learning-method-trial
```

旧整片流程在模型执行成功后自动渲染并进行技术检查。分阶段流程先收集相应阶段证据，在提交阶段生成最终成片。手动 `repro:render` 用于制作已完成、渲染设施失败后的重试，不替代模型制作。`repair` 由同一执行角色依据失败证据修复；主持代理直接编辑产物会构成外部协助。配方改进必须形成新版本与新实验，不能偷偷更改正在执行的冻结输入。

`repro:retry` 保留旧尝试，重新创建起点。`repro:resume` 仅恢复内容未变的检查点。`repro:recover` 核对异常退出和持久化记录，不调用模型；无法证明的计费用量保持不完整，不能根据残留成片推断完成。显式恢复创建的新检查点可能标为 assisted，不能因此取得独立生成认证。

预算累计记录模型调用、工具调用、渲染、耗时以及已知 token/费用。超时、环境阻塞、预算耗尽和质量失败分别保留，不把中断转为成功，也不通过自动扩充预算隐藏失败。未知费用不是零费用。

## 独立性与验收

三个检查分别记录：技术检查、制作来源与独立性检查、两份完整质量评审。质量通过不自动等于独立生成通过。

技术检查针对公开输出合同，包括必需文件、实际媒体格式、尺寸、时长、音轨、冻结输入和执行完成状态；不得依赖旧场景的对象名、变量名或代码组织方式。

生成检查核对起始工程、冻结输入、产生或修改的制作文件、素材来源、执行记录及外部介入。源码有改动不能单独证明独立性；没有人工协助也不能把工程回放变成独立生成。

当前原生 Harness 的新上下文和工作目录不构成操作系统级读隔离。只有运行环境实际限制读取并经过探测，才能标记读取隔离已验证。其余运行最多标为“过程审计通过，读取隔离未验证”。用户级设置、文件访问和网络权限以具体 Harness 实现为准；目录或配置文件的存在不证明限制已经生效。

`policy.reviewSamples: 2` 让两个独立上下文比较同一冻结原片、成片、标准和证据。每个评审完整判断全部标准，不把其中一个改成独立性审核。ChatGPT 学习视频仍使用场景覆盖、视觉构图、镜头运动、英文字幕和声音五项标准。逐项两票全部通过才满足双评审要求。

评审记录结构化的观察状态、证据 ID 和 `pass` / `fail` / `unobserved`。未充分观察不能通过；自然语言里的否定表达不单独决定报告有效性。运动判断需要连续阶段，声音判断需要音频证据。证据记录计划时间、实际 seek 及回退信息；seek 不冒充测得的帧 PTS。

有效失败不反复抽签。无效报告可在预算内重试并保留原始记录；成片变化后必须生成新证据并重新进行两份评审。缓存绑定视频、证据、规格、协议实现和评审配置，避免把旧结论用于新产物。协议升级会形成新身份，不覆盖历史结果，也不声称消除了所有主观波动。

## Web 入口：AI 复刻实验

`npm start` 后，从左侧「高级功能」展开进入「AI 复刻实验」。页面地址仍为 `/repro`，网关挂载时为 `/remake/repro`。这里用于模型自动复刻、评审与方法配方实验，支持角色和预算配置、教师制作、选择方法从空工程生成、运行与修复、双评审、证据浏览及方法验证记录。

日常添加原片使用「参考视频」，创建或继续自己的制作使用「制作工作台」；在其左侧「我的制作」选择项目后，进入项目内部的「模板工作台」或「成片放映」。这些操作不需要进入 AI 复刻实验。

创建方法试跑时必须选择配方、参考视频并提供独立任务规格。历史模板单独列出，不再作为默认创建入口。详情分别显示制作方式、请求与实际模型、Harness、外部协助、生成检查、读取隔离和逐项评审票。分阶段运行还显示当前阶段、镜头卡、宿主检查、执行者自检及过期证据。操作按钮由服务端允许的动作与阻塞原因驱动；直接请求 API 也不能绕过阶段约束。阶段媒体通过哈希登记，只能读取当前运行证据目录中的普通文件。

Web 与 CLI 共用工作流。工作台仅接受本机、同源 JSON 请求，不提供任意 shell 或任意文件读取接口。保存配置只改变项目默认工作流，不影响已冻结运行；外部工作流文件只读展示。

## Skill、素材能力与 MCP

Skill 承载制作知识，Harness 执行工具。配方只声明逻辑能力，例如 `reference.frames`、`asset.search`、`render.preview`，不固定某个服务器、主机路径或凭据。实际 HTTP/local 连接在本机能力配置中绑定；凭据使用环境变量引用。

MCP 可以作为能力传输方式，但当前运行库未启用原生 MCP；必需而不可用的能力应明确阻塞，不能仅写入配置就声称已经接通。素材生成能力同样需要真实探测。调用了其他图片、声音或模型生成服务时，应分别记录来源和成本，不把它们归为执行语言模型制作的素材。

## 历史迁移与旧入口

旧 `reproductions/templates/<name>/vN`、教师工程、历史试跑、评审、媒体和哈希保持原样。读取层将其标为 `project-replay`，新方法使用独立的 `method-generation` 类型和版本空间。v1–v6 不因迁移自动取得新的独立生成成绩。

```sh
node cli/remake.js repro:method-migrate sample-learning@6 --dry-run
node cli/remake.js repro:replay sample-learning@6 --as learning-history-replay --inputs inputs.json
node cli/remake.js repro:export sample-learning@6 --to reproductions/exports/learning-history
```

`method-migrate` 生成迁移清单，说明哪些是方法候选、素材候选和必须隔离的完整实现；它不是自动语义转换器，不直接把旧源码复制进新方法。新的方法提炼和素材准入仍须检查内容。历史回放须显式使用 `repro:replay`，可加 `--run`；回放不计为独立生成。

`repro:import` 只导入新方法配方；`repro:export` 支持新方法与历史工程导出。旧模板提炼、导入和旧自动循环不作为新建方法的入口。更早的 `packages/harnesses` 迁移语义不同，不能用来替代本次方法迁移。兼容读取与历史导出保留，历史记录不随旧默认入口清理删除。

## 方法修订循环

方法研发和单次制作分开。阶段失败及最终双评审可作为新方法版本的研发证据；正在运行的配方、素材和标准保持冻结。修订入口使用现有 extractor 角色，生成新的方法草稿并保留父版本、反馈运行、参考与输入来源：

```sh
node cli/remake.js repro:method-revise explainer-method@1 \
  --name explainer-method --version 2 \
  --feedback first-trial --feedback second-trial
```

`--feedback` 可以重复，也可以使用逗号分隔。工作台可选择同一冻结方法版本的多份已结束反馈记录，保留各次阶段提交和评审。修订仅输入方法文档及报告快照，不复制试跑源码或场景。草稿和归因记录保存在独立研发目录，费用单独记账。

草稿仍需内容审查与 `method-freeze` 冻结；从登记的草稿目录冻结时自动验证并继承父方法、反馈哈希、归因报告和提炼模型来源。冻结前只可更新 `contentReview` 声明；修改方法正文需要新的研发记录。不能因为创建了草稿就宣称方法已经改善。方法修订不得写入旧运行产物，失败运行也不会改写为成功。新方法必须创建新的空工程实验；Skill 继续使用 reproduce、validate、repair 三个入口，在其中组织阶段方法，不增加新服务或强制 MCP。

## 效果实验与测试

先比较“同一冻结方法＋原整片流程”与“同一冻结方法＋分阶段流程”，明确记录为 `workflow-ablation`。这种实验只估计流程变化，不称为方法配方提升。除执行协议、阶段策略和由协议带来的通用工程覆盖文件外，参考、任务、素材、基础脚手架、模型/Harness、工具、检查器、反馈方式、总预算与最终双评审都须一致；缺少可比身份的历史记录只能描述，不能计算提升。

流程验证后，再用相同分阶段流程比较方法 v1/v2，记录为 `method-version`；两组均应用方法，只有方法内容不同。方法有无的独立对照记录为 `method-presence`，无方法组保留同样的阶段基础设施与通用工具。一个报告不混合这些实验类型。基准定义在每个 case 中指定 `comparisonType`，沿用 baseline/template 字段引用两次独立运行。

公平对照使用相同参考、任务、通用素材、脚手架、模型/Harness、工具与预算，比较有无方法配方的空工程生成。旧完整工程回放成绩不能充当新方法的空工程基线。另一视频是否属于保留用例，要核对参考及提炼来源，不能只凭输入哈希不同判断。

`repro:benchmark` 汇总全部尝试及已知成本，分别展示质量成功、过程审计与严格独立生成资格。单条视频通过只说明该任务与执行组合成功；迁移能力需要未参与方法提炼的参考用例验证。

`npm run repro:test` 覆盖方法/素材边界、空工程生成、不可变输入、执行预算与恢复、独立性检查、双评审、历史兼容和 Web API；`npm test` 运行完整回归。模拟模型测试验证流程，真实试跑的成片与双评审验证制作效果，两者分别报告。
