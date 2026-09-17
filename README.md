# Gemini Agent Bridge for CCR

Use Claude Code or Claude Desktop with Gemini through a local [Claude Code Router (CCR)](https://github.com/musistudio/claude-code-router) gateway.

Gemini Agent Bridge is a self-hosted CCR gateway plugin. It accepts Anthropic Messages-compatible requests from Claude clients, translates them to the Gemini Interactions API, and translates the response back. Your prompts travel through your local CCR instance and use the Gemini API access configured there.

It is useful when you want Claude's familiar clients and local-tool workflow while using Gemini as the model provider.

> [!IMPORTANT]
> You provide and are responsible for your own Gemini API access, quota, and billing. This project does not include an API key, credits, or a billing service. Review [Gemini API billing](https://ai.google.dev/gemini-api/docs/billing) and your account's terms before using it.

## What it does

- Provides an Anthropic Messages-compatible gateway endpoint for Claude Code and Claude Desktop.
- Maps Claude-facing model choices to three pinned Gemini models with appropriate thinking levels.
- Bridges Claude's web search, web fetch, and code execution requests to Gemini-native tools.
- Preserves the native tool history Gemini needs for multi-turn requests, while keeping repository tools and file changes local to Claude Code or Claude Desktop.

## What it does not do

- It does not replace CCR, Claude Code, Claude Desktop, or a Google account with Gemini API access.
- It does not install a global npm package or change CCR installation files.
- It does not silently fall back to another model or provider.
- It cannot enforce Claude web-tool domain allow/block filters with Google grounding; those requests fail clearly instead.

## Requirements

- A running CCR installation with a `Google` provider (or a provider name you choose) containing your Gemini API key.
- Node.js 22 or later for the plugin and its tests.
- A dedicated CCR gateway when you enable the bridge's universal `/v1/*` routes.
- Either Claude Code, Claude Desktop, or both.

Keep your Gemini API key in CCR's existing Google provider configuration. Never add it to this repository, this plugin's configuration, or Claude client settings.

## Install and configure

1. Clone this repository into CCR's plugin directory:

   ```sh
   git clone https://github.com/<owner>/<repository>.git <CCR_HOME>/plugins/gemini-agent
   ```

2. Configure CCR's existing Google provider with your Gemini API key. The bridge reads that provider at runtime; no key belongs in the plugin configuration.

3. Copy the plugin and profile structure from [`config.example.json`](./config.example.json) into your CCR configuration. Set the `module` path to this checkout's `entry.cjs` file.

4. For a dedicated Gemini gateway, set `exclusiveGatewayRoutes` to `true`. This registers `/v1/messages`, `/v1/messages/count_tokens`, and `/v1/models` for the bridge.

   Do **not** enable this on a shared gateway. CCR gateway routes cannot inspect a model and then fall through to another provider, so a shared gateway would lose the other provider routes and discovery behavior.

5. Start or restart the dedicated gateway:

   ```sh
   ccr start --daemon --no-open --gateway
   ```

6. Select the `gemini-agent` profile in your Claude client and begin a conversation.

### Claude Code

Use the `gemini-agent` CLI profile shown in `config.example.json`. Its default, Sonnet, Opus, and Fable selections resolve to Gemini 3.8 Flash; Haiku and small-fast resolve to Gemini 3.5 Flash-Lite. The bridge exposes `GoogleAgent/claude-gemini-*` aliases because Claude Code requires discoverable model IDs containing `claude`.

### Claude Desktop

Set `desktopProfilePath` to the Claude Desktop profile JSON in the plugin configuration. When the dedicated gateway starts, the bridge updates that profile to use the local CCR gateway, disables generic model discovery, and registers the supported Claude Desktop façade models.

The profile file is rewritten with permissions restricted to its owner. Back it up before the first run if you want an independent rollback point.

## Models

| Claude-facing selection | Gemini model | Thinking level |
| --- | --- | --- |
| Default, Sonnet, Opus, Fable | `gemini-3.8-flash` | High |
| Explicit alternative | `gemini-3.1-pro-preview` | High |
| Haiku, small-fast | `gemini-3.5-flash-lite` | Low |

The bridge also recognizes Google `-latest` aliases but resolves them to the pinned models above. This keeps a parent request and any internally bridged tools on the same model.

## Tool behavior

When offered by a Claude client, these tools are handled by Gemini workers:

| Claude-facing tool | Gemini capability |
| --- | --- |
| `WebSearch` | Google Search grounding |
| `WebFetch` | URL Context |
| `CodeExecution` | Hosted code execution |

Other declared tools are returned to Claude as normal `tool_use` blocks and continue to follow the client’s existing local permissions. Gemini hosted code execution only receives its task and inline data; it does not receive repository files, builds, package installs, or persistent file access.

### Benefits of native tools vs. MCP servers

Instead of configuring external Model Context Protocol (MCP) servers to replicate search, fetching, code execution, or local developer operations, this plugin maps Claude's native tools directly to first-party capabilities:

- **`WebSearch` via Google Search grounding:** Connects Claude's search requests directly to Google's live search index and citation engine. You get first-party search grounding without installing search MCP servers (such as Brave or Tavily) or managing extra API keys.
- **`WebFetch` via Gemini URL Context:** Fetches and extracts public web content server-side. Eliminates the need for local browser-automation MCP servers (such as Puppeteer or Playwright) that require local headless browser dependencies and consume CPU and memory.
- **`CodeExecution` in hosted sandboxes:** Runs Python calculations and data-processing tasks in Google's secure cloud environment, avoiding the need for local code-runner MCP servers or container sandboxes for scratch math and evaluation.
- **Local repository tools (`Read`, `Edit`, `Write`, `Bash`):** Passed back to Claude Code or Claude Desktop as standard client tool calls. This preserves native interactive diffs, syntax highlighting, fine-grained permission prompts, and sandbox boundaries that generic filesystem or terminal MCP servers lose.
- **Lower overhead and token savings:** Avoids MCP schema boilerplate, namespace prefixes (`mcp__*`), and JSON-RPC process hops, keeping prompt token usage lean and multi-turn tool loops fast.

## Data, privacy, and operations

The plugin writes a local replay database under CCR's `app-data/plugins` directory. It stores the native interaction history needed to safely continue stateless requests, including tool-call IDs, thought signatures, tool results, and relevant conversation text. Credentials are not stored there, and logs do not include credentials or full conversation bodies by default.

- `GET /plugins/gemini-agent/health` reports plugin health and configured models.
- `POST /plugins/gemini-agent/cleanup` deletes replay state unused for 30 days.
- CCR's ten-minute request timeout still applies. The bridge emits SSE keepalives every 15 seconds and retries transient Google failures up to two times.

## Troubleshooting and rollback

- **No Gemini routes are available:** confirm `exclusiveGatewayRoutes: true` is set only on a dedicated gateway, then restart CCR.
- **Authentication fails:** check the Google provider selected by `googleProviderName` (default: `Google`) in your CCR configuration. Do not put the key in this plugin's config.
- **A web request with domain filters fails:** this is expected; Google grounding cannot faithfully apply Claude's allow/block domain semantics.
- **Claude Desktop shows unexpected models:** verify `desktopProfilePath` and restart the dedicated gateway so the profile can be synchronized.

To roll back, stop CCR, disable the `ccr-gemini-agent` plugin or restore your previous CCR configuration, restore the dated Claude Desktop profile backup if applicable, and start CCR again.

## Development

```sh
npm test
npm run check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and pull-request guidance. Security issues belong in the private reporting flow described in [SECURITY.md](./SECURITY.md), not public Issues.

## Support

If this project is useful to you, optional support is welcome at [Buy Me a Coffee](https://buymeacoffee.com/karsonm).

## Project status

Gemini Agent Bridge is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic, Google, Claude Code Router, or their respective organizations.

## License

This project is licensed under the [GNU General Public License v3.0 only](./LICENSE).
