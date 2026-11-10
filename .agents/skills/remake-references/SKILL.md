---
name: remake-references
description: 在 video-remake 项目查询已绑定对标视频、来源和关联制作，解释本地导入、SOURCE.json 与 referenceIds 的连接方式。用于“有哪些对标”“分别关联哪些制作”“项目怎么连接原片”等查询。
---

# 对标视频与制作关联查询

在 video-remake 仓库根目录执行。每次读取当前本地数据，不沿用聊天中的清单或数量。

## 查询依据

- `catalog.json` 的 `references` 是已登记参考，`productions` 是已登记制作。
- 对每条参考读取 `<reference.dir>/SOURCE.json`，取得 `title`、`channel`、`canonicalUrl`、`durationSec`、`quality` 和原片路径（`videoPath` 为绝对路径，`relVideo` 为相对 `assetRoot` 的路径）。
- 用 `production.referenceIds.includes(reference.id)` 关联，不根据 slug、标题或目录名猜测。一条参考可关联多个制作，一个制作也可关联多条参考。
- 单独报告没有制作关联的参考、没有参考关联的制作，以及指向不存在参考 ID 的制作。读取失败的 SOURCE 保留该参考并注明缺失或损坏。
- 统计参考数和去重后的制作数；不要把多对多关系条数当成制作总数。
- 优先用 `remake reference:list --json` 读取参考清单、原片可读状态和关联制作；台账不存在时返回空列表。`remake list` 同时列出相同的参考信息与制作清单，`remake get <id>` 对参考会一并返回 SOURCE。这些查询均只读，不创建缺失的台账。需要制作的完整信息时也可直接读取 `catalog.json`。

## 输出

用中文表格列出对标标题（有 canonicalUrl 时链接到原始页面）、时长、参考状态、关联制作名及制作状态。多个实验版本可合并展示，但保留可辨认的完整命名和数量。标题可能被数据源截断，不自行补全。

参考状态映射：`bound` 为已登记（导入或 `bind` 写入）；`understanding` 为理解中，是手动标记，重新登记时保留。原片可读状态和参考台账状态分开显示。

制作状态映射：`commissioned` 为已建项（`start` 写入），`delivered` 为已交付（`deliver` 写入）；`drafting` 为草稿制作中，是手动标记，代码不会写入。

其他状态保留原值或依据代码解释。说明这些是台账状态，不能据此断言磁盘上没有成片或成片已验证。时长为 null 时显示未登记。

`reference:list` 会检查已登记原片是否为可读文件；缺失或损坏的 SOURCE 也保留条目并报告原因。可读不代表通过解码或质量检查。清单查询无需请求网关、下载素材或遍历全部制作文件。

## 解释连接方式

需要解释连接或导入流程时，核对 `README.md`、`src/config.js`、`src/sources/`、`src/references.js`、`src/reference-scan.js`、`src/downloads/`、`src/ingest.js`、`src/bind.js` 和 `src/start.js`。本机值从 `video-remake.json` 读取，环境覆盖规则以代码为准，不输出 token 或凭据。

默认链路：本地视频 → `reference:import <文件>`，或 manifest → `reference:import --manifest <清单>` → 保存 `references/<平台>-<视频ID>/SOURCE.json` 并登记台账 → `reference:list` 查看 → `start` 在制作的 `referenceIds` 中保存参考 ID。

默认 provider 为 `local`，直接读取本地 catalog 和 SOURCE 快照。文件导入只保存原片指针，不复制、不移动原片；manifest 的文件路径仍相对 `assetRoot`，并检查路径边界。现有网关参考的 SOURCE 可直接使用，原片目录必须继续可读，不需要网关在线。

扫描已有视频：`reference:scan <目录> [--recursive]` 只读列出候选及已关联参考；用户选择后，用 `--import --select <相对路径>` 登记，`--select` 可重复。明确导入全部候选时使用 `--import` 而不加 `--select`。扫描不跟随软链接，跳过隐藏项；已登记的真实路径不重复导入，不重写已有元数据。

链接下载使用独立入口 `reference:download <URL> [--quality 720|1080]`，由 `download.provider`（默认 `yt-dlp`）执行，成功后登记为本地参考。`download:doctor` 只检查本机工具；普通清单查询不运行下载，也不自动安装工具。`source.provider` 继续保持 `local`，下载文件留在配置的私有下载目录。操作和配置边界见 `docs/local-references.md`。

可选网关仍可用 `ingest <URL> --source-provider gateway-video` 或 `bind <ID> --source-provider gateway-video`；也保留 `bind <ID> --source-provider manifest --source-manifest <清单>`。这些旧入口不会隐式转用下载适配器。配置中显式 provider 会覆盖程序默认值，实际配置优先级以代码为准。

这项查询本身只读。用户另行要求导入、下载、绑定或创建制作时，再按明确授权执行对应命令。
