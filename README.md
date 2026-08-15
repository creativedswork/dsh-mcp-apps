# DSH MCP Apps

Cordis plugin bundle for hosting stable-spec MCP Apps in the DeepSeek Harness Web UI. One npm package provides the Host plugin, Browser bundle, and `dsh.bundle` patch needed to activate both.

The Host owns its MCP connections, exposes model-visible tools through Harness, keeps app-only tools out of the model registry, and serves untrusted Views through a different-origin Sandbox Proxy. No agent-loop change or external MCP proxy is required.

## Install

Install the package into the Web profile:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-mcp-apps
```

The bundle is activated automatically. Configure its `mcp-apps` row in `$DSH_HOME/profiles/web/cordis.patch.yml`:

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

`transport: streamable-http` accepts `url` and optional `headers` instead of `command`, `args`, `cwd`, and `env`. `serverName` must match `[A-Za-z0-9_-]{1,32}` and becomes part of the public tool name.

Start Harness with:

```sh
dsh web
```

The Web profile must bind to `127.0.0.1`; the plugin rejects broader bindings because the Sandbox Proxy currently supports loopback browsers only.

## Counter Demo

The checkout includes a local stdio MCP server with:

- `show_counter`, a model-visible tool linked to `ui://counter/app`;
- `increment_counter`, an app-only tool available only to that View;
- a bundled View using the official MCP Apps `App`.

Run the deterministic demo without a model key from this directory. The second local path installs Harness's replay adapter as a plain profile dependency:

```sh
pnpm install
pnpm run build
export DSH_HOME="$PWD/.tmp/demo-home"
dsh plugin --profile web add . ../deepseek-harness/packages/test-support/llm-replay \
  --config.auto-install-peers=false
dsh web --patch demo/cordis.patch.yml --patch demo/replay.patch.yml
```

Open the printed URL, connect this directory as the workspace, and send any prompt. Replay calls `mcp__counter__show_counter`; the settled tool row renders a counter at `0`. The `+` button calls the app-only `increment_counter` through the Host and updates the View to `1`.

Omit `demo/replay.patch.yml` and the replay dependency to exercise the same flow with the profile's configured model.

## Behavior

- Targets MCP Apps specification `2026-01-26` and advertises `text/html;profile=mcp-app`.
- Supports stdio and Streamable HTTP MCP transports.
- Applies `_meta.ui.visibility`; omitted visibility means model and app.
- Persists readable text for the model while retaining `structuredContent` and result `_meta` in bounded UI-only presentation metadata.
- Uses the official `AppBridge` and `PostMessageTransport` for View lifecycle and app-originated tool/resource calls.
- Enforces CSP by HTTP header on a separate loopback origin and validates `postMessage` source and origin.
- Falls back to the ordinary text tool result when a View cannot load.

Tool-list changes are synchronized, while automatic transport reconnection is not yet implemented. The Browser refreshes its catalog every five seconds.

## Development

```sh
pnpm install
pnpm run check
pnpm run pack:dry-run
```

Install a local checkout into a profile:

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config
```

## Publishing

`prepack` runs type checking, the production build, and package tests. The npm tarball contains the Host entry, Browser bundle, declarations, bundle patch, license, and README; development Demo files are excluded.

```sh
pnpm publish --access public
```

Publishing requires npm permission for the `@deepseek-ai` scope.
