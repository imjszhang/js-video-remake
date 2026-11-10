# 出图 provider：codex-image

仅在 `media.image.provider` 选中 `codex-image` 时使用。执行方式是 `agent`：由当前 Codex 会话的内置生图工具生成或编辑图片，再走项目的素材落地流程。共享默认是 `codex-image`。

## 选择与准备

单次选择（不改本机配置）：

若文件配置中有其他工具的专属字段，单独覆盖 provider 会被配置检查拒绝；此时先保存原配置，再按下述方式替换整个 `media.image` 段。

```bash
VIDEO_REMAKE_MEDIA_IMAGE=codex-image node cli/remake.js media:prepare --task image --request request.json --json
```

长期使用时，把 `video-remake.json` 中的 `media.image` 整段设为 `{"provider":"codex-image"}`。切换工具时使用对应工具的配置。视频与转写配置不受影响。

需求示例：

```json
{
  "intent": "人物半身照，保持参考人物身份，将背景换成办公室",
  "images": ["productions/demo/assets/image/look.png"],
  "size": "1024x1536",
  "options": { "transparentBackground": false }
}
```

文生图省略 `images`。`size` 是交给 Agent 的画面要求，不是已验证的内置工具尺寸参数，不保证精确像素；需要精确尺寸时检查实际输出并说明差异。`outPath` 是生成后的保存目标，不作为工具参数传入。`options` 只支持布尔值 `transparentBackground`，省略时按需求判断，编辑时保留已有透明背景，除非用户要求修改。质量、构图、保留内容等要求写入 `intent`；不接受其他工具的专属选项。

## 就绪与授权

- `media:prepare` 仅做本地检查，不生成、不联网。
- `media:doctor` 会给出指南，但 `ready: false` 表示 **CLI 无法确认会话能力**，不表示实际工具一定不可用。限定 `--task image` 时仍按现有规则返回 `DOCTOR_FAILED`。Agent 应检查当前真实可用工具和登录方式；不能靠环境变量声称订阅已验证。
- 当前会话必须实际提供内置生图工具（例如 `image_gen`）；没有时说明缺少什么并停下。工具存在也不保证剩余额度或生成成功。
- 必须获得当前任务的出图授权；“接入工具”“先别生图”只允许配置与检查，不允许测试生成。
- 使用 ChatGPT 登录的内置工具，不要求 API Key，不读取或复制 Cookie、访问令牌，不调用私有网页接口。禁止自动切换 图片 API 或 skill 的 CLI fallback；更换渠道需要用户明确指示。

## 调用与交付

1. 检查制作存在，读取准备后的需求。确认当前会话工具的真实 schema，按它支持的参数调用，不固定模型名或伪造工具。
2. 对本地参考图先用图像查看工具检查。按工具支持的方式提供参考：当前工具若支持 `referenced_image_paths`，传准备后的绝对路径；只有会话图片没有本地路径时才使用其会话图片引用机制。遵守实际工具的互斥参数与数量限制。
3. 将 `intent`、图片各自用途、需保留的内容及 `size` 要求整理成提示词。透明背景按工具实际参数传入。只在授权后调用；超时先检查原任务，不重复提交。
4. 工具返回本地文件时，用实际返回路径，不猜测缓存文件名。若仅返回可读取的 `data:image/...;base64,...`，可把返回的原始字节解码为本地图片，扩展名与 MIME 一致，不重新绘制图片。若只显示预览、没有可取回的文件或数据，明确说明交付受阻，不虚构路径、不宣称已登记，也不为拿文件再次生图。
5. 检查图片实际可读、非空及是否满足需求。有 `outPath` 时把文件保存到该位置；没有时可使用本次工具返回的本地文件。不要覆盖已有资产，除非用户明确要求；已存在目标使用新版本名。工具缓存不是最终素材库。
6. 用统一入口落地。文生图和仅用作风格/身份参考的新图记 `codex-image.generate`；修改指定已有图片记 `codex-image.edit`。能力检查将所有带参考图需求归入 `image-edit`，来源名则按实际操作意图记录。

```bash
node cli/remake.js media:land <slug> --kind image \
  --from <实际图片文件> --intent "<制作意图>" \
  --provider codex-image.generate
```

编辑时改为 `--provider codex-image.edit`。登记后沿用 `video:add` 接入视频包。只有登记成功才报告素材 id 和项目路径；真实验证与模拟验证分别记录，不把一次成功视为后续会话或账户必然可用。

`media:image` 在此 provider 下会返回 `MEDIA_AGENT_REQUIRED`，提示由 Agent 执行；不会从 CLI 偷跑 API。订阅内置生图与 API 计费的区别见 [官方说明](https://learn.chatgpt.com/docs/image-generation)，实际可用性和额度以当前账户为准。

## 实测记录

2026-11-09：当前会话内置工具完成一次文生图，返回本地 PNG 文件，已通过 `media:land` 登记并保留来源。未使用 API Key；参考图编辑与透明输出尚未实测。CLI 仍无法独立确认其他会话的可用性与剩余额度。
