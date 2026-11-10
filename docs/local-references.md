# 本地参考视频清单

项目默认从本地 `catalog.json` 和各参考的 `SOURCE.json` 获取视频清单。导入、查询和建立制作不依赖素材网关在线，也不要求安装下载工具。

## 网页管理参考视频

运行 `npm start`，从左侧日常导航进入「参考视频」（相对页面路径 `./references`）；另一个日常入口「制作工作台」用于管理自己的制作。页面与 CLI 共用本地台账和 SOURCE 记录，无需素材网关在线。

清单以封面卡片显示标题、来源、时长、原片可用状态和关联制作。点击封面上的「播放原片」可在页面内观看，支持暂停、拖动进度和全屏；关闭窗口会停止播放。没有封面时显示占位，原片不可读时禁用播放。清单支持搜索、筛选与刷新。文件不可用的记录仍保留，并显示原因；从可用记录点击「创建制作」，填写小写字母、数字及连字符组成的制作标识，即可建立关联制作，再点击「进入制作」打开制作工作台。已有制作可直接打开，也可在制作工作台左侧的「我的制作」中选择。

页面默认展示参考清单。点击「添加参考」再选择获取方式，完成后返回清单；标题、参考 ID 等选填项收在「更多设置」里，manifest 从添加窗口底部的「导入清单」进入。

支持以下获取方式：

- **本地文件**：填写视频文件路径，可选填标题和参考 ID，导入后只保存原片指针。
- **manifest 清单**：填写清单文件路径和可选素材根目录；不填写根目录时沿用项目配置。格式和路径边界与下文的 CLI 导入相同。
- **文件夹扫描**：填写目录，可勾选包含子目录；先查看候选，再勾选需要的文件并导入。扫描不会写入台账，未勾选条目不会导入，已登记文件会跳过。
- **链接下载**：填写单个视频链接，选择 720 或 1080 后开始下载；完成后自动登记到本地清单。点击工具检查只检查本机安装，不访问视频网站。

本地文件、manifest 和扫描目录都位于**运行 Web 服务的设备**，可填写绝对路径或相对工作区的路径。浏览器不能提供所选文件的真实本机路径，因此这些表单使用路径输入，不上传、复制或移动原片。通过其他设备访问工作台时，也要填写服务端可读取的路径。

链接下载以后台任务执行，同一 Web 服务一次只运行一个下载。主页面以简短状态提示正在下载或失败的任务，任务历史可按需展开；刷新页面后可继续查看，不会因为刷新重复下载。任务记录保存在当前服务进程中，保留最近 20 个已结束任务和当前任务；重启服务不会保留这份任务历史，已经登记的参考仍保存在本地台账。关闭服务会请求停止正在运行的下载；进程退出或文件保留的处理与下文下载失败规则相同。

下载成功但登记失败时，任务会显示保留文件的路径，可转到本地文件导入重试。工具未安装、链接不支持或文件不可读时，页面会显示具体操作的错误；这些失败不影响继续浏览已有参考与制作。

## 导入本地视频

```bash
node cli/remake.js reference:import /path/to/reference.mp4 --id demo --title '参考视频'
node cli/remake.js reference:list
node cli/remake.js start local-demo --as demo-remake
```

文件路径可以是绝对路径，也可以相对工作区。`--id` 和 `--title` 可省略：默认使用文件完整 SHA-256 生成稳定 ID，以不含扩展名的文件名为标题。自定义 ID 只用字母、数字、下划线或连字符；本地导入的参考 ID 带 `local-` 前缀，命令结果会显示完整 ID。

导入计算原片 SHA-256 和大小，保存元数据及文件指针。不会复制、移动、下载原片，也不会在制作目录创建原片软链接。原文件可以位于全局 `assetRoot` 之外；网页仅允许读取已明确登记的文件，不因此开放其所在目录。

重复导入同一 ID、相同内容时更新记录，保留理解状态、首次绑定时间和制作关联；同一 ID 对应不同内容会拒绝，避免覆盖已有制作的参考。

原片应保持在导入的位置。删除、移动或断开所在磁盘后，清单会报告不可用；导入并不是文件备份。

## 批量导入 manifest

已有的 `video-remake.source-list@1` 清单可直接使用。例如把以下内容保存为 `sources.json`：

```json
{
  "schema": "video-remake.source-list@1",
  "items": [
    {
      "video": {
        "videoId": "demo",
        "platform": "local",
        "status": "downloaded",
        "title": "参考视频",
        "canonicalUrl": "https://example.com/video/demo"
      },
      "files": {
        "video": "demo/video.mp4",
        "thumbnail": "demo/thumb.jpg",
        "subs": { "zh": "demo/zh.vtt" }
      }
    }
  ]
}
```

```bash
node cli/remake.js reference:import --manifest ./sources.json --asset-root ./assets/source
```

`files.video` 必填，封面和字幕可省略。文件路径必须相对指定的 `assetRoot`，路径及软链接不能越界；每条视频的状态必须为 `downloaded`，原片须在本机可读。清单内的视频 ID 不能重复。

批量导入先校验所有条目、文件和目标记录，再写入本地记录；校验失败不会留下部分导入，写入过程中的磁盘故障不保证整批回滚。每条导入为一份本地 SOURCE 快照和一条参考记录，保留 manifest 中的平台与视频 ID。导入后查询、建立制作不再读取原 manifest，也不请求网关；原片文件仍需保留。批量导入也会登记原片及封面的精确读取路径，因此网页播放无需保留导入时的命令行 assetRoot 覆盖。只想绑定一个条目时，可以继续用原入口：

```bash
node cli/remake.js bind demo --source-provider manifest --source-manifest ./sources.json --asset-root ./assets/source
```

## 扫描文件夹后选择导入

```bash
# 只扫描当前目录，不登记、不复制、不下载
node cli/remake.js reference:scan /path/to/videos

# 包含子目录；JSON 中列出候选文件及已关联的参考 ID
node cli/remake.js reference:scan /path/to/videos --recursive --json

# 选择扫描目录内的文件导入，--select 可重复
node cli/remake.js reference:scan /path/to/videos --recursive --import --select clip.mp4 --select series/part-1.mov

# 明确导入全部候选文件
node cli/remake.js reference:scan /path/to/videos --recursive --import
```

扫描默认为只读，没有台账时不会创建文件。候选按路径排序，只检查常见视频扩展名及文件是否可读，不解码视频；隐藏文件、隐藏目录、软链接、空文件和非普通文件会跳过，递归时不跟随目录软链接。单次扫描最多遍历 10,000 个目录项、深入 64 层，超过上限会报错，避免意外扫描过大的目录。明确指定的扫描根目录可以是软链接，扫描前会解析为真实目录；其内部软链接仍跳过。

`--select` 使用相对扫描目录的路径，且必须配合 `--import`；越界路径和未出现在候选列表里的路径会拒绝。不加 `--select` 的 `--import` 导入全部候选。已按同一真实路径登记的原片会跳过，保留已有标题、来源和制作关联。选中的新文件先完成整批校验，再登记；校验失败不会部分导入，磁盘写入故障不保证整批回滚。内容完全相同的候选只登记一条内容哈希参考；若该内容哈希 ID 已存在，不会把原片指针改向另一份副本。

## 从链接下载并登记

链接下载独立于清单来源。默认清单仍为 `source.provider: "local"`，下载适配器通过 `download.provider` 选择，目前提供 `yt-dlp`。

```bash
# 只检查本机下载工具，不访问视频网站
node cli/remake.js download:doctor

# 明确下载一个链接，完成后登记到本地清单
node cli/remake.js reference:download 'https://www.youtube.com/watch?v=VIDEO_ID' --quality 1080
node cli/remake.js reference:list
```

`download:doctor` 运行本机 yt-dlp 和 ffmpeg 的版本检查，不访问视频网站，不能据此保证网站可访问或 YouTube 的 JavaScript 组件已齐备。先安装本机 `yt-dlp` 与 FFmpeg 工具。FFmpeg / ffprobe 用于独立音视频流合并及后处理；完整的 YouTube 支持还需要 `yt-dlp-ejs` 与受支持的 JavaScript 运行环境，具体安装方式见 [yt-dlp 官方依赖说明](https://github.com/yt-dlp/yt-dlp#dependencies)。适配器向 yt-dlp 显式提供运行本项目的 Node.js；项目不会自动安装或更新下载工具及 EJS 组件。网页服务在启动时读取来源和下载配置，修改配置后需重启服务。

下载只接受无用户名密码的 HTTP(S) URL，先读取元数据并拒绝播放列表、直播和未开播内容，再下载单个视频。支持 `--quality 720` 或 `1080`，限制所选视频的最大像素高度，不接受 `audio`；不会把原片放大，实际可下载的规格受来源影响。不会沿用用户的 yt-dlp 配置文件、插件目录或缓存，也不会自动读取浏览器登录信息或 cookies。

下载文件默认写入私有目录 `assets/source/downloads/` 下的独立任务目录，使用固定文件名；成功后保存 `SOURCE.json`、来源链接、标题等元数据并登记内容哈希生成的 `local-…` 参考 ID。此后查询和制作只使用本地记录。下载生成新文件，后续登记只引用它，不再复制到参考或制作目录。下载失败或超时且进程确认退出后，清理本次任务的临时目录，保留之前的原片；若无法确认进程退出，则保留目录并报告路径，避免与仍在写入的进程争用。如果下载已经成功但登记失败，保留完成的文件并返回 `reference:import` 恢复路径，不必再次下载。

可以在私有 `video-remake.json` 中配置：

```json
{
  "source": { "provider": "local" },
  "download": {
    "provider": "yt-dlp",
    "executable": "yt-dlp",
    "directory": "assets/source/downloads",
    "timeoutMs": 1800000
  }
}
```

| 配置字段 | 命令行覆盖 | 环境变量覆盖 |
| --- | --- | --- |
| `download.provider` | `--download-provider` | `VIDEO_REMAKE_DOWNLOAD_PROVIDER` |
| `download.executable` | `--download-executable` | `VIDEO_REMAKE_DOWNLOAD_EXECUTABLE` |
| `download.directory` | `--download-dir` | `VIDEO_REMAKE_DOWNLOAD_DIR` |
| `download.timeoutMs` | `--download-timeout-ms` | `VIDEO_REMAKE_DOWNLOAD_TIMEOUT_MS` |

优先级为命令行、环境变量、配置文件、默认值。下载目录相对工作区解析，默认总超时为 30 分钟。修改下载工具不会改变参考清单来源，也不会自动切换到网关。

## 查询和关联

```bash
node cli/remake.js reference:list --json
```

输出包含参考标题、文件可读状态和关联制作。没有本地台账时返回空列表，不创建 `catalog.json`；缺失或损坏的 SOURCE 不会让整张清单消失，而是在对应条目报告原因。

参考状态（例如 `bound`、`understanding`）来自台账；可用状态来自当前磁盘检查。文件可读不代表可以正常解码，也不代表内容适合复刻。关联制作依据 `production.referenceIds`，不根据标题或目录名猜测。

`list` 同时列出带可用状态和关联信息的参考，以及制作清单；`get <ID>` 显示单条详情。这些查询均只读，台账缺失时不会创建文件。网页「参考视频」展示同一份清单，并提供导入、扫描、下载和从参考创建制作的入口。

## 已有网关数据如何继续使用

把本机配置中的默认来源改为：

```json
{
  "source": { "provider": "local" }
}
```

已有其他配置时只修改 `source.provider`，保留需要的网关地址、认证、`assetRoot` 和媒体配置。配置优先级为命令行、环境变量、配置文件、程序默认值；如果 `VIDEO_REMAKE_SOURCE_PROVIDER` 仍设为 `gateway-video`，需同步调整。

已有参考的 SOURCE 已保存元数据和原片路径，可以直接纳入本地清单，不改变参考 ID，不重写制作关联，不复制文件，也无需再次绑定。`provider.kind` 记录其导入来源，不代表以后查询必须连接那个服务。

关闭网关服务不等于可以删除原片目录：原片仍可能位于旧的共享目录，必须继续在本机可读。本阶段不自动移动文件，不对旧路径做批量迁移。

本地模式的 `doctor` 不访问网关，也不因未使用的全局 `assetRoot` 目录缺失而失败；工作区、台账和工具检查仍保留。

## 按需使用网关

```bash
node cli/remake.js bind VIDEO_ID --source-provider gateway-video
node cli/remake.js ingest 'https://www.youtube.com/watch?v=VIDEO_ID' --source-provider gateway-video
node cli/remake.js doctor --source-provider gateway-video
```

网关的地址、认证、超时和共享目录映射沿用原配置。显式选择网关检查时仍会访问其健康接口；`ingest` 继续由服务端下载 worker 完成下载，再登记本地参考。

`ingest` 仍走显式选择的来源适配器，本地来源和 manifest 不支持 URL 入队。直接下载链接请用独立的 `reference:download`；扫描文件夹请用 `reference:scan`，项目不会自行扫描其他目录。

### 网关配置与兼容细节

网关地址、认证和目录映射仍可保存在 `video-remake.json` 的 `source` 配置中；默认 provider 设为 `local` 即可保留配置、按需调用。显式配置的 provider 优先于程序默认值：旧配置如果仍写 `gateway-video`，需改为 `local` 才会切换。优先级为命令行、环境变量、配置文件、默认值。

网关的 `source.baseUrl` 默认是 `http://127.0.0.1:8888/video/api/v1/`。显式选择网关运行 `doctor` 时调用 `health.json`，`bind` 查询详情；URL 入队需要 `VIDEO_REMAKE_SOURCE_TOKEN` Bearer token。也可配置 `source.tokenEnv`、纯文本 `source.tokenFile`，或通过 `source.tokenJsonKey` 从 JSON 文件读取指定字段；环境变量优先。不要把 token 写入仓库。

网关详情不返回服务器本地路径，`assetRoot` 必须指向本机可读的共享目录；适配器按 `directoryTemplate`（默认 `videos/{id}`）、`videoFile`、`thumbFile` 映射文件，字幕按 API 返回的相对路径映射。未配置时 `assetRoot` 为工作区的 `assets/source`。本地文件导入不依赖这个目录；网关和 manifest 绑定仍校验路径边界，并从文件计算 SHA-256 与大小。

`ingest` 通过 `POST videos.json` 入队，轮询 `GET videos/<id>.json`，直到下载完成、失败或超时。这条网关流程的下载 worker 仍由服务端运行；独立下载工具通过 `reference:download` 调用。超时不会自动重复入队，完成后可显式选择网关用 `bind` 继续。请求默认超时 15 秒、轮询间隔 2 秒、总等待 10 分钟，可通过 `source.requestTimeoutMs`、`pollIntervalMs`、`waitTimeoutMs` 配置。

命令行保留 `--source-provider`、`--source-url`、`--source-manifest`、`--poll-interval-ms`、`--wait-timeout-ms`；环境变量保留 `VIDEO_REMAKE_SOURCE_PROVIDER`、`VIDEO_REMAKE_SOURCE_URL`、`VIDEO_REMAKE_SOURCE_MANIFEST`。`SOURCE.json` 和 catalog 的 `archiveVideoId` 字段保留兼容，来源 provider 作为导入记录保存，不要求日常查询连接该来源。

可选网关入队默认使用 `--quality 1080`；已有 720 成片只绑定并警告，加 `--force` 才重新入队。`video-remake.json` 中遗留的 `hypit`、`archiveCli`、`workerLimit` 字段会被忽略。
