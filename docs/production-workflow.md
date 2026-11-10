# 制作工程、渲染与交付

[返回项目说明](../README.md)。本页面向通过命令行或 Agent 编写视频工程的使用者；已有 `.video` 模板时，可直接使用[网页模板流程](video-template.md#网页填写预览与合成)。

## 从参考建立制作

先把示例原片路径替换为本机真实文件路径，再在项目根目录运行：

```bash
node cli/remake.js reference:import /path/to/reference.mp4 --id demo --title '参考视频'
node cli/remake.js start local-demo --as my-video
node cli/remake.js video:new my-video --width 1080 --height 1920 --fps 30 --duration 10
```

`start` 建立 `BRIEF.md`、`TREATMENT.md`、`PROGRESS.md`、`assets/`、`drafts/` 和空的 `videos/`；同一参考可创建多份制作。`video:new` 另建代码视频包，默认从 `code-v1` 开始。创建目录和包不会自动分析或复刻原片；接下来需要自己或让 Agent 编写场景、动画和时间轴，并准备素材。参考理解笔记 `ANALYSIS.md`、`TIMELINE.md`、`transcript.json` 写在参考目录，CLI 不代写，不写回原片目录。

素材流程为：生成或准备文件 → `media:land` 登记到制作 → `video:add` 复制进包 → 在场景中使用，详见[素材生成](media-providers.md)。字幕需要先有转写结果，才能执行 `captions`；这些是按需操作，不是创建包后必须依次执行的步骤。

## 检查、预览与登记

完成包内源码和素材后，在项目根目录运行：

```bash
node cli/remake.js check my-video
node cli/remake.js studio my-video
node cli/remake.js timeline my-video --json
node cli/remake.js video:render my-video
node cli/remake.js video:import my-video
```

`video:import` 将渲染结果登记为草稿，随后可在网页「成片放映」查看。上面示例按制作中只有一个包编写；有多个包时用 `--video <名字>` 选择版本。`studio` 打开交互预览，`timeline` 查看时间轴，两者都不是渲染的前置步骤。

`check` 先核对包内素材，再使用包自己锁定的 `hyperframes check`：缺失素材和 lint/运行时错误会挡住渲染；不在整数帧上的时间和低对比度只记警告，因为复刻时常常要照搬参考片的时长和配色。

按需使用的辅助命令（均接在 `node cli/remake.js` 后）：

| 命令 | 用途与前置条件 |
| --- | --- |
| `captions <slug> --from <转写.json>` | 从已有 Whisper JSON 生成字幕，写入包内 `captions/` |
| `normalize <slug> --id <素材ID>` | 将已登记静帧转成带 BT.709 标签的 H.264；透明素材可用 `--alpha keep` 保留 ProRes 4444，或 `--alpha flatten` 铺黑底，普通视频不转码 |
| `deliver <slug> --from <成片.mp4>` | 将已审阅成片复制为正式交付版本，写入 `deliverables/<slug>/vN/` |
| `get <slug>` | 查看制作及最新交付、对比记录 |
| `paths` | 查看工作区、素材根目录、本机工具和素材 provider |

## 代码视频包

代码视频包是独立的 HyperFrames 工程，和本仓解耦：将完成的包复制到具备 Node.js、FFmpeg 和 HyperFrames 浏览器的环境，安装包内依赖后即可构建和渲染；有 `build` 脚本时先构建。约定如下：

- 位置是 `productions/<slug>/videos/<名字>-vN/`，名字以 `-vN` 结尾，例如 `code-v1`。
- 包内有 `package.json`、`package-lock.json`（锁定 HyperFrames）、`video.json`（画幅、帧数、入口、输出、来源）、入口 HTML、`assets/`。`npm run check` 和 `npm run render` 调用包内依赖，渲染输出写到包内的 `renders/`。
- 包内不出现 `../` 或绝对路径，也不引用原片。制作素材用 `video:add` 从台账复制进包；和原片的对比由包外的 `compare` 完成。

本仓负责驱动和记录：

| 命令 | 作用 |
| --- | --- |
| `video:new <slug> [--as 名字]` | 生成新包并运行 `npm install`；名字默认 `code-vN` |
| `video:fork <slug> [--video 来源 --as 名字]` | 复制成下一个版本（不含 `node_modules`、`renders/` 和缓存），在 `video.json` 记下来源版本和它的源文件哈希，再运行 `npm ci` |
| `video:render <slug>` | 有 `build` 脚本时先运行它，再运行 `npm run render`；在 `drafts/.renders/` 记下这次渲染对应的源文件哈希 |
| `video:import <slug>` | 把渲染结果复制到 `drafts/<名字>/`，写 `MANIFEST.json`（包名、源文件哈希、时长、帧数、SHA-256），并更新 `catalog.json` 的草稿指针，项目的「成片放映」随即可见 |
| `video:add <slug> --id <素材>` | 把台账素材复制到包内 `assets/<类型>/`，输出可贴进入口 HTML 的片段 |
| `video:list <slug>` | 列出各版本是否已安装、已渲染、已导入 |
| `video:pack <slug> [--video 名字 --out x.video]` | 把模板包打成 `.video`，默认写到 `deliverables/` |
| `video:unpack <文件.video> [--as 制作标识]` | 导入外部模板并新建制作，默认使用模板 id；不安装依赖、不执行模板脚本 |
| `video:generate <slug> --video 包名 --title 名称 --prompt 描述 [--target Agent --mode derive\|revise]` | 用提示词调用 Agent；默认创建独立模板 v1，revise 迭代同一模板，并检查、生成静态预览 |
| `video:remix <slug> --title 名称 [--video 包名 --style 样式.json]` | 低层复制与公共样式兼容命令，恢复默认输入并保留原包 |

导入时要求成片来自 `video:render`，且渲染后源文件和成片都没变；否则拒绝，确有需要时加 `--force`，并在清单中标为未验证。包一旦导入草稿就冻结：之后源文件有改动，再导入会被拒绝，需要用 `video:fork` 开新版本。这样通过验证的包内草稿可对应到登记时的源码和成片。`compare` 也接受包外 MP4，记录的是输入文件哈希；`deliver` 记录来源路径与交付时间，不验证或记录源码哈希。冻结的包可以删掉 `node_modules`，需要时用 `npm ci` 按锁文件恢复。

每个包锁定与根依赖相同的 `hyperframes@0.8.191`。根依赖里的 HyperFrames 用于本仓对比片、字幕导出和复刻渲染，制作工程使用包内依赖。升级时同时更新根依赖和各代码视频包；`npm test` 检查版本一致，并拒绝制作中 `videos/` 以外的 HyperFrames 工程。渲染需要本机 FFmpeg 和 HyperFrames 浏览器；对比标签字体 `@fontsource-variable/inter`、`@fontsource-variable/noto-sans-sc` 随根 npm 依赖安装。

模板包的填写、合成和分发约定见 [.video 模板](video-template.md)。

## 竖屏对比预览

每次预览生成后，用 `compare` 将新版放上方、固定基准放下方，生成 1080×1920 的竖屏对比视频。它复用现成 MP4，由锁定的 HyperFrames 合成；两段画面完整适配，不裁切人物、字幕和动效。输出帧率沿用上方视频，深色背景与标签填充横屏画面外的空间，只播放指定的一条音轨，默认上方。

首次明确指定两个输入。以下沿用上面的 `my-video` 制作，假定 `code-v1` 已渲染并登记；将原片路径替换为真实文件，`--duration` 不得超过任一输入的剩余时长。相对路径按工作区解析：

```bash
node cli/remake.js compare my-video \
  --top productions/my-video/drafts/code-v1/code-v1.mp4 \
  --bottom /path/to/reference.mp4 \
  --duration 10 \
  --top-label '复刻 v1' \
  --bottom-label '参考原片'
```

后续每次仍明确指定新版视频，省略 `--bottom` 即复用最近一次对比记录中的固定基准；CLI 会校验基准文件的 SHA-256，文件变化时需重新明确指定 `--bottom`。例如用 `video:fork` 开新版本，完成修改、渲染并登记 `code-v2` 后：

```bash
node cli/remake.js compare my-video \
  --top productions/my-video/drafts/code-v2/code-v2.mp4 \
  --duration 10 \
  --top-label '复刻 v2'
```

`--top-start`、`--bottom-start` 指定各输入从第几秒开始，默认均为 0，按输出帧率对齐到最近帧并在 manifest 记录实际范围。两段剩余时长不同时必须用 `--duration` 指定共同播放的秒数，不自动补帧或改变播放速度。`--audio top|bottom|none` 选择上方、下方或静音；静音版本仍封装一条静音音轨。

每次生成保存到 `productions/<slug>/drafts/comparisons/vN/`，其中 `comparison.mp4` 是成片，`MANIFEST.json` 记录输入路径和 SHA-256、截取范围、布局、标签、音轨和 HyperFrames 版本，并保留可重建的 `composition/index.html`。这里的 `vN` 是对比视频自己的版本号，与输入预览版本独立。导出校验成功后，`catalog.json` 的 production 条目更新独立的 `comparison` 指针；制作状态和正式交付记录保持原值。用 `remake get <slug>` 可查看最新对比结果。

生成失败时保留该次目录与 `FAILED.json`，最新可用版本的指针不变。输入文件只读；已记录的输入必须继续保留，才能用版本目录中的 `composition/index.html` 重建。磁盘上旧的 SVML 对比目录保持原样，不迁移、不重渲。

常规流程为：生成新版预览 → `remake compare` → 检查同步、构图和声音 → 查看并分享对比视频。历史目录保留，每次生成新增版本。

## 目录

```text
references/{platform}-{videoId}/SOURCE.json
productions/<slug>/{BRIEF,TREATMENT,PROGRESS}.md
productions/<slug>/assets/{image,video,audio}/, ledger.json, <id>.transcript.json
productions/<slug>/videos/<名字>-vN/{package.json,package-lock.json,video.json,index.html,assets/,renders/}
productions/<slug>/drafts/<名字>-vN/{<名字>-vN.mp4,MANIFEST.json}
productions/<slug>/workflows/<名字>-vN/        该版本的研究资料：测量脚本、对照截图、检查日志（不进包）
productions/<slug>/drafts/comparisons/vN/{comparison.mp4,MANIFEST.json}
deliverables/<slug>/vN/{film.mp4,MANIFEST.json}
catalog.json
```

`SOURCE.json` 同时记录 `assetRoot` + `relVideo`（相对 library）和绝对 `videoPath`。代码视频包不引用原片，和原片的对比由 `compare` 在包外完成。
