# 仪表盘复刻流程样例

使用 `REPRO_REFERENCE_ID` 指定自己已绑定的对标素材（需匹配 spec.json 中的画幅、时长和构图，或同步调整规格），验证同结构的品牌与四条标注替换。该样例不预填答案。

准备本机 `agent-runtime.json`（此文件被忽略提交），配置 `repro-teacher` 与 `repro-executor` 两个 target；`workflow.json` 只引用角色，不固定模型供应商。执行 `bash examples/reproduction-smoke/run.sh` 会调用真实模型和渲染器。每次使用新 slug 和方法名称。流程提炼制作方法，再让执行模型从空工程生成场景和镜头；不会复制教师源码。

`workflow.json` 使用分阶段流程（`schemaVersion: 2`）：参考分析、关键镜头验证、分镜、整合、提交检查，最后两份完整评审。这条参考只有一个仪表盘画面，没有人物，主要风险是粒子环运动，所以样例冻结 `prototypeRequirements: ["complex-motion"]` 和 `minPrototypeShots: 1`；默认策略要求覆盖人物交互的两个镜头，对这条参考无法满足。不修订时一次运行约需 11 次模型调用，教师和学生各自在 `maxCalls: 24`、90 分钟的预算内运行，两份评审的调用和时间会预先保留。换成其他参考时，按其镜头数和风险重新设定这两项。

样例默认 `policy.renderProvider: "local"`：模型负责工程、素材和输入预处理，阶段预览和提交阶段的最终成片由工作台调用固定版本的本机 HyperFrames 渲染；不会在宿主侧执行模型生成的 npm 或准备脚本。Harness 的文件写入权限仍应使用 `workspace-write`，不需要设为 `bypass`。若选择 `agent`，需要确保该 Harness 原生环境允许所需浏览器、端口和 FFmpeg 操作。

脚本先运行不调用模型的环境检查；任一阶段失败即停止并打印当前状态。支持通过 `VIDEO_REMAKE_AGENT_CONFIG`、`VIDEO_REMAKE_REPRO_WORKFLOW` 选择其他配置，`REPRO_TEST_NAME` 固定本次命名，`REPRO_REFERENCE_ID` 选择已有对标。`--check-login` 通过不代表实际模型、图片证据读取或视频复刻质量已经验证。

中断后先运行 `repro:status <slug>` 和 `repro:logs <slug>`：

- 模型已经完成源码，但本机渲染失败：修复环境后执行 `repro:render <slug>`；仍受原任务时间和渲染次数预算限制。
- 工程已经执行完成，但技术或主观验收失败：`repro:repair <slug>` 在保留当前工程的基础上进行有预算的修复，再检查和评审。人工改过源码会记录为协助。
- 宿主进程退出，记录仍显示执行中：`repro:recover <slug>` 整理确认已退出的执行记录，不重新调用模型、不认可残留成片。
- 已有内容未变的中断检查点：`repro:resume <slug>`；没有检查点或需要重新开始：`repro:retry <slug>`。重跑整个脚本会创建新任务，不代表继续原有任务。

上述命令需使用与脚本相同的配置环境变量。不要通过修改冻结规格、输入或预算文件使失败变成通过。

`teacher-inputs.json` 为开发输入；`student-inputs.json`、`long-inputs.json`、`chinese-inputs.json` 为不同变体。任何用于修订的输入都不再算未见测试。对照实验使用相同执行角色和预算创建 `--baseline` 运行。

新运行使用两份完整质量评审。脚本保存质量结果和过程审计，不自动发布严格独立生成认证；原生 Harness 的新目录不证明读取隔离。输入变体也不能仅凭哈希不同被称为未见参考视频。

完整说明见 [复刻项目文档](../../docs/reproduction.md)。
