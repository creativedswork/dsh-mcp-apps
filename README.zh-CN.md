# DSH MCP Apps

[English](README.md) | 简体中文

[![CI](https://github.com/creativedswork/dsh-mcp-apps/actions/workflows/ci.yml/badge.svg)](https://github.com/creativedswork/dsh-mcp-apps/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@deepseek-ai/dsh-mcp-apps.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-apps)
[![GitHub release](https://img.shields.io/github/v/release/creativedswork/dsh-mcp-apps)](https://github.com/creativedswork/dsh-mcp-apps/releases)
[![license](https://img.shields.io/npm/l/@deepseek-ai/dsh-mcp-apps.svg)](LICENSE)

这是一个 Cordis 插件包，用于在 DeepSeek Harness Web UI 中运行稳定规范的 MCP Apps。一个 npm 包同时提供 Host 插件、Browser bundle，以及用于启用两者的 `dsh.bundle` patch。

Host 管理 MCP 连接，通过 Harness 注册模型可见工具，不把 app-only 工具暴露给模型，并通过不同源的 Sandbox Proxy 运行不受信任的 View。整个方案不需要修改 Agent Loop，也不需要外部 MCP 代理。

<img width="900" height="900" alt="用户在 MCP App 中编辑 Three.js Pong 场景，保存后 Agent 读取操作记录" src="https://github.com/user-attachments/assets/d9ef0df0-e628-4734-8d61-b33b4c0f3933">

这段 34 秒的演示使用了 [`threejs-editor-mcp`](https://github.com/creativedswork/threejs-editor-mcp)：用户调整 Canvas 布局和相机视角，点击 **Save**；App 随后发送标准 `ui/message`，Agent 调用 `inspect_project` 读取保存的操作记录并作出回应。

## 安装

将 npm 包安装到 Web profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-mcp-apps
```

安装后 bundle 会自动启用。在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中配置 `mcp-apps`：

```yaml
- id: mcp-apps
  config:
    servers:
      - serverName: counter
        transport: stdio
        command: node
        args: [/absolute/path/to/server.js]
        cwd: /absolute/path/to/server
```

使用 `transport: streamable-http` 时，改为提供 `url` 和可选的 `headers`，不再填写 `command`、`args`、`cwd` 和 `env`。`serverName` 必须匹配 `[A-Za-z0-9_-]{1,32}`，它会成为公开工具名的一部分。

启动 Harness：

```sh
dsh web
```

Web profile 必须绑定到 `127.0.0.1`。当前 Sandbox Proxy 只支持 loopback 浏览器，因此插件会拒绝范围更大的监听地址。

## 独立 Counter Demo

仓库内置了一个本地 stdio MCP Server：

- `show_counter`：模型可见工具，关联 `ui://counter/app`；
- `increment_counter`：只有该 View 可以调用的 app-only 工具；
- 一个使用 MCP Apps 官方 `App` 的内置 View。

下面的命令使用已发布的 Harness CLI，不依赖相邻的 `deepseek-harness` 源码目录：

```sh
pnpm install
pnpm run build
export DSH_HOME="$PWD/.tmp/demo-home"
pnpm dlx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add "$PWD"
pnpm dlx @deepseek-ai/dsh@0.1.0-rc.6 web --patch "$PWD/demo/cordis.patch.yml"
```

打开命令输出的 URL，将当前目录连接为 workspace，然后让已配置的模型显示 counter。工具调用完成后，工具卡片会渲染数值 `0`；点击 `+` 时，View 会通过 Host 调用 app-only 的 `increment_counter`，并把数值更新为 `1`。

完整编辑器示例请参阅 [`threejs-editor-mcp`](https://github.com/creativedswork/threejs-editor-mcp)。

## 行为

- 目标规范为 MCP Apps `2026-01-26`，View MIME 类型为 `text/html;profile=mcp-app`。
- 支持 stdio 和 Streamable HTTP 两种 MCP transport。
- 识别 `_meta.ui.visibility`；省略该字段时，工具同时对模型和 App 可见。
- 将可读文本交给模型，同时把 `structuredContent` 和结果 `_meta` 保存在受大小限制、仅 UI 可见的 presentation metadata 中。
- 使用官方 `AppBridge` 和 `PostMessageTransport` 处理 View 生命周期，以及 App 发起的工具和资源调用。
- 代理 `ui/download-file`，允许下载一个最大 4 MiB 的内嵌 JSON 资源，因为 Sandbox View 无法直接下载文件。
- 在独立 loopback origin 上通过 HTTP header 强制执行 CSP，并校验 `postMessage` 的 source 和 origin。
- View 加载失败时回退到普通文本工具结果。

工具列表变化会自动同步；transport 自动重连尚未实现。Browser 每五秒刷新一次 catalog。

## 安全架构

```mermaid
flowchart LR
  Agent["Harness Agent"] -->|"模型可见工具"| Host["MCP Apps Host<br/>127.0.0.1"]
  Host -->|"stdio 或 Streamable HTTP"| Server["MCP Server"]

  subgraph Browser["浏览器"]
    UI["Harness UI<br/>Host origin"]
    Proxy["Sandbox Proxy<br/>独立 loopback origin"]
    View["MCP App View<br/>双层 iframe Sandbox"]
    UI -->|"经过校验的 postMessage"| Proxy
    Proxy -->|"CSP + sandbox 属性"| View
  end

  Host -->|"受大小限制的 View 和资源 API"| UI
  View -->|"app-only 工具和 ui/message"| UI
  UI -->|"经过授权的 bridge 调用"| Host
```

- Host 和 Sandbox Proxy 使用不同的 loopback origin。
- View 运行在双层 iframe 中，由 HTTP CSP 和明确的 sandbox 属性共同约束。
- bridge 接受消息前会校验 `postMessage` 的 source 和 origin。
- 工具可见性将模型可见工具与 app-only 工具分开。
- Host API 拒绝跨源写入，并限制请求体和 metadata 的大小。

## 开发

```sh
pnpm install
pnpm run check
pnpm run pack:dry-run
```

将本地 checkout 安装到 profile：

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config
```

## 发布

`prepack` 会执行类型检查、生产构建和包测试。npm tarball 包含 Host 入口、Browser bundle、类型声明、bundle patch、许可证和中英文 README，不包含开发 Demo 文件。

发布通过 [Publish workflow](https://github.com/creativedswork/dsh-mcp-apps/actions/workflows/publish.yml) 手动触发。`npm` environment 必须提供有权发布 `@deepseek-ai` scope 的 `NPM_TOKEN`。workflow 会携带 provenance 发布 npm 包；npm 发布成功后，再创建 `v0.1.0` tag 和 GitHub Release。
