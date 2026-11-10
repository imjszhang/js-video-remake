# 落地合同

生成物进制作目录。原片仍只存在归档 library，用 `SOURCE.json` 指针引用。

## 路径

| 种类 | 落点 |
| --- | --- |
| 图像 | `productions/<slug>/assets/image/<id>.<ext>` |
| 视频 | `productions/<slug>/assets/video/<id>.<ext>` |
| 音频 | `productions/<slug>/assets/audio/<id>.<ext>` |
| 台账 | `productions/<slug>/assets/ledger.json` |
| 转写 | `productions/<slug>/assets/<id>.transcript.json`（`media:transcribe` 写出，不走 `media:land`） |

`<id>` 由 `media:land` 生成：`{img\|vid\|aud}-<slug>-<YYYYMMDD>-<rand>`。不要手写拷贝。

`*.mp4` 已被仓库 gitignore；落地成功不等于文件能进 git。

## 台账

```json
{
  "format": "remake-asset-ledger@1",
  "items": [
    {
      "id": "img-demo-announcement-20260919-ab12",
      "kind": "image",
      "path": "productions/demo-announcement/assets/image/img-demo-announcement-20260919-ab12.png",
      "provider": "codex-image.generate",
      "intent": "speaker look, 16:9 talking-head still",
      "sourcePath": "/tmp/remake-designer-…/image_001.png",
      "createdAt": "2026-09-19T10:25:41.000Z",
      "status": "landed"
    }
  ]
}
```

`provider` 用所选 provider 指南里列出的稳定来源名，`media:doctor --json` 和 `media:prepare --json` 的 `ledgerProviders` 也会列出。它记录素材的实际来源，不根据当前默认工具改写已有记录。上面的图片条目只是格式示例；更换生成工具后仍使用相同台账结构。`remake normalize` 自己写 `local.normalize`。

程序出图返回实际文件路径与来源名；Agent 出片先核对需求、取回实际视频文件，再调用这里的落地入口。`media:prepare` 的准备结果不是生成结果，不能拿它替代图片、视频或转写文件。转写 JSON 由 `media:transcribe` 检查并写入原有位置，不另包一层影响 `captions` 的格式。

## 接线

成片工程是独立的代码视频包 `productions/<slug>/videos/<名字>-vN/`，不和制作目录共用素材。落地后用 `video:add` 把素材复制进包：

```bash
node cli/remake.js video:add <slug> --id <assetId> [--video <名字>]
```

它把文件复制到包内 `assets/<kind>/`，输出 src 为 `./assets/<kind>/<file>` 的片段，不要写 `../`。HyperFrames 会把跳出工程目录的路径当成找不到的文件。已导入草稿的包已冻结，不要往里加素材，先 `video:fork` 开新版本。

```html
<img id="img-demo-announcement-20260919-ab12" class="clip" src="./assets/image/img-demo-announcement-20260919-ab12.png" alt="" data-start="0" data-duration="1">
<video id="vid-demo-announcement-20260919-cd34" class="clip" src="./assets/video/vid-demo-announcement-20260919-cd34.mp4" muted playsinline data-start="0" data-duration="1" data-media-start="0"></video>
```

把 `video:add` 输出的片段贴进包入口 HTML 的 `#root`。时间属性尽量落在整数帧上，`remake check` 会对不在整数帧上的时间给出警告。代码视频包不引用原片；和原片的对比用 `remake compare`。

## 命令

```bash
node cli/remake.js media:land demo-announcement --kind image \
  --from /tmp/look.png \
  --intent "speaker look" \
  --provider codex-image.generate
```

成功 stdout：

```text
landed img-demo-announcement-20260919-ab12 → productions/demo-announcement/assets/image/img-demo-announcement-20260919-ab12.png
复制进代码视频包: remake video:add demo-announcement --id img-demo-announcement-20260919-ab12
```

制作必须已在 `catalog.json` 登记且目录存在。`--from` 的相对路径按仓库根目录解析。加 `--json` 可拿到结构化结果。
