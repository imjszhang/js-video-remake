# 图片 provider：comfyui-image

调用已有 ComfyUI 的本地服务 HTTP API。图片与原有 `comfy-mcp` 视频适配器分别选择；不安装服务、节点或模型。

## 配置

```json
{"provider":"comfyui-image","baseUrl":"http://127.0.0.1:8188","workflowFile":"private/image-workflows.json"}
```

位于 `media.image`。字段对应环境变量：`baseUrl` → `COMFYUI_IMAGE_URL`（默认本机 8188），`workflowFile` → `COMFYUI_IMAGE_WORKFLOW`，可选 `apiKeyFile` → `COMFYUI_IMAGE_API_KEY_FILE`。密钥第一行作为 Bearer 头，仅适用于自行部署的认证代理，不是 Comfy 云平台 API 节点密钥。

## 工作流文件

先在 ComfyUI 导出 **API 格式**工作流（节点 ID 为对象键、节点包含 `class_type` 和 `inputs`），不要使用界面保存的 nodes/links JSON。工作流文件结构如下；`workflow` 需填入你导出的完整对象，不是文件路径：

```json
{
  "generate": {
    "workflow": {},
    "prompt": {"node":"6","input":"text"},
    "width": {"node":"5","input":"width"},
    "height": {"node":"5","input":"height"},
    "images": [],
    "outputNode": "9"
  },
  "edit": {
    "workflow": {},
    "prompt": {"node":"6","input":"text"},
    "images": [{"node":"10","input":"image"}],
    "outputNode": "9"
  }
}
```

这是结构示例，空 `workflow` 不能运行。ID 和输入名必须对应自己的工作流。可只配置 generate 或 edit；缺少本次需求对应的模式会在上传前失败。编辑参考图数量必须与 images 绑定数量完全一致，顺序一一对应；不允许漏传而使用工作流里的旧图片。若使用 `--size 宽x高`，对应模式必须同时绑定 width 和 height。

请确认工作流实际接通提示词/参考图/尺寸到输出，所有节点与模型均已安装。适配器能检查绑定存在，不能证明任意自定义节点的语义或模型可运行。工作流应配置为单张输出（如 batch_size=1）；本适配器只取 outputNode 的第一张图片，不会改写批量数、seed、采样参数或负面提示词。它不会替换工作流内其他本机文件引用。

## 执行

`doctor` 和 `prepare` 只读本地文件，不连服务。实际生成获得授权后，`media:image` 会：上传参考图到 `/upload/image`，注入绑定，向 `/prompt` 提交，轮询 `/history/<id>`，从指定输出节点通过 `/view` 下载图片。原工作流文件不会改写。默认轮询间隔 1 秒，总超时 10 分钟；异常不重新提交、不自动取消其他任务，已知任务 ID 会保留在错误中供查询。

结果来源 `comfyui-image.generate` / `comfyui-image.edit`，使用 `media:land` 落地。无专属 options；提示词之外的设置在工作流中维护。输入输出格式及文件保护见 [统一说明](../../../../docs/media-providers.md)。

仅通过模拟测试，未真实生图。依据：[官方 API 提交示例](https://github.com/comfyanonymous/ComfyUI/blob/master/script_examples/basic_api_example.py)、[历史与图片下载示例](https://github.com/comfyanonymous/ComfyUI/blob/master/script_examples/websockets_api_example.py)。
