# video-remake

对标视频复刻工作台：绑定参考原片，建立制作，生成和落地素材，用锁定的 HyperFrames 渲染成片与对比片。用户说明见 [README.md](README.md)。

## 适用范围

本文件适用于仓库根目录的程序、测试和文档。`productions/` 和 `reproductions/` 下自带 `AGENTS.md` 的子工程（制作工程、复刻工程、方法配方）以它们自己的规则为准；复刻工程按其冻结规则执行，不读取本仓的教师工程或历史试跑。

## 命令

```bash
npm ci                    # 安装锁定依赖，不用 npm install 改锁文件
npm test                  # 完整回归，不访问网络
node --test test/<name>.test.js
node cli/remake.js --help
node cli/remake.js doctor
node cli/remake.js media:doctor
```

## 代码约定

- Node.js >= 22.15.0，ES modules，4 空格缩进，只用标准库和 `package.json` 已有依赖。
- CLI 结构：命令名登记在 `src/args.js` 的 `COMMANDS` 和 `HELP`，分发在 `cli/remake.js` 的 `execute`，人类可读输出在 `src/format.js`。错误用 `src/errors.js` 的 `appError(code, message)`。
- 配置统一由 `src/config.js` 的 `resolveConfig` 解析，取值顺序是命令行、环境变量、`video-remake.json`、默认值。
- 素材生成的 provider 在 `src/media/`，接入方法见 [docs/media-providers.md](docs/media-providers.md)。
- 已导入草稿的代码视频包不再修改；要改就用 `video:fork` 开新版本。
- 外部服务和子进程通过可注入的依赖（如 `deps.fetchImpl`、`deps.runFfmpeg`）调用，测试用模拟实现，不打真实服务。
- 代码视频包（`productions/<slug>/videos/<名字>-vN/`）自带 `package.json` 和锁文件，锁定与根依赖相同的 HyperFrames 版本，不引用包外文件；本仓只通过 `src/videos.js` 驱动它。制作里不再有其他形式的 HyperFrames 工程；不要用 `npx hyperframes@...` 另装版本。
- 文档和面向用户的提示用中文；修改行为时同步更新 README 或 `docs/` 中对应段落。

## 版本管理与发布

- 项目名为 `video-remake`，GitHub 仓库为 `imjszhang/js-video-remake`。版本规则见 [docs/versioning.md](docs/versioning.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。
- 日常修改将面向用户的变化记入 CHANGELOG 的“未发布”；仅提交日常修改不自动升版或创建 Release。发版时将这些内容整理到对应版本，记录日期、功能变化、已知限制及必要的迁移说明。
- 发版必须同步 `package.json`、`package-lock.json` 顶层与根包版本、README 版本徽章/说明/发布链接，以及 `docs/versioning.md` 的当前版本说明。可用 `npm version <版本> --no-git-tag-version` 同步包版本，再更新文档。
- 当前处于 `0.x` 测试阶段：补丁版本用于问题修复与小改进，次版本用于较大功能或兼容性调整；所有 `0.x` Release 默认标记为 Pre-release。项目版本、模板版本和 HyperFrames 版本分别管理。
- **先验证，再提交 GitHub**：完成发布修改后必须运行完整 `npm test` 和 `git diff --check`；失败时先修复并重新验证，不提交或推送失败的发布，不创建发布标签或 Release。记录通过、失败和跳过数量，不把模拟测试当作真实服务验证。
- 验证通过后提交并推送发布内容，在该发布提交上创建带说明的 `v<版本>` 标签，推送标签并创建同名 GitHub Release。发布说明包含主要变化、限制和测试结果；已发布标签不可移动或覆盖。
- 发布仅包含仓库源码与通用文档，不上传本地制作、原片、配置或密钥；保留 `private: true`，不发布到 npm。

## 数据与安全

- 原片只读：通过 `SOURCE.json` 指针引用，不复制、不 symlink `video.mp4`。
- `catalog.json`、`productions/`、`references/`、`deliverables/`、`assets/`、`reproductions/`、`video-remake.json`、`agent-runtime.json`、`.env*` 是本机私有数据，不提交，也不要把其中的本机路径、内网地址或密钥写进公开文件。
- `reference:list`、`list`、`get` 和默认的 `reference:scan` 为只读查询，不创建缺失的 `catalog.json`；`reference:scan --import`、导入或下载参考、创建制作等写操作才建立台账。
- 出图、出片会花费额度，需要用户在当前任务中明确授权。

## Agent skill

skill 只维护在 `.agents/skills/`：`remake-media` 负责出图、出片、转写和素材落地，`remake-references` 负责查询对标与制作关联，`video-template` 教 agent 使用 `.video` 模板（`video:pack` 会把它打进每个 `.video`，格式见 [docs/video-template.md](docs/video-template.md)）。`.claude/skills/`、`.cursor/skills/`、`.codex/skills/` 下是指向它的软链接，不要在那里单独修改。
