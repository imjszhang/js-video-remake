# 本地 Agent runtime 包

项目使用 `js-agent-runtime-0.2.3-mcp.2.tgz`。它基于 `0.2.3-mcp.1`，增加系统 Claude 包装入口的兼容修复：`claude-config` 版本检查保留启动 HOME，继续用临时 `CLAUDE_CONFIG_DIR` 隔离配置。其他认证模式保持原行为。

`js-agent-runtime-metadata.patch` 记录该次逻辑差异；包内 package.json、运行时版本常量和 MCP 版本标识同步为 `0.2.3-mcp.2`。旧包保留用于复核基线，不再是当前依赖。

更新此包后需同步根依赖声明与锁文件，用 `npm ci` 安装，并运行 `npm test`。`test/agent-system-entry.test.js` 验证系统包装脚本在安装更新后仍能被版本检查调用，不需要固化版本路径。
