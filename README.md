# Gemini Agent Bridge for CCR

This local CCR extension exposes an Anthropic Messages-compatible endpoint for
Claude Code and uses Google Gemini's Interactions API behind it. It keeps the
existing CCR Google provider intact, so the previous configuration remains a
rollback path.

## Model policy

| Claude Code role | Gemini model | Thinking |
| --- | --- | --- |
| Default, Sonnet, Opus, Fable | `gemini-3.8-flash` | `high` |
| Explicit alternative | `gemini-3.1-pro-preview` | `high` |
| Haiku and small-fast | `gemini-3.5-flash-lite` | `low` |

Claude Code discovery requires client-visible model IDs to contain `claude`, so
the configured aliases are `GoogleAgent/claude-gemini-*`; the bridge maps them
only to the pinned Gemini IDs in the table. It does not select a fallback model.
Main-model requests set `store: false`, use the
Interactions step-list format, and preserve returned native steps during a
single request so Gemini receives thought signatures and function-call IDs
unchanged when a bridge tool returns its result.

## Tool bridge

Claude-facing `WebSearch`, `WebFetch`, and `CodeExecution` are normal Gemini
function declarations. When Gemini calls one, CCR performs a separate worker
interaction:

| Function | Gemini worker tool |
| --- | --- |
| `WebSearch` | `google_search` grounding |
| `WebFetch` | `url_context` |
| `CodeExecution` | `code_execution` |

The worker result is supplied as a native `function_result` step before Gemini
continues. Workers use the same Gemini model (and thinking level) selected for
the request, so choosing one of the configured Claude-facing aliases controls
both the main interaction and these intercepted tools. Other declared tools are
returned to Claude Code as `tool_use` blocks and remain subject to Claude Code's
normal local permissions. Domain filters deliberately fail with a clear error
because Google grounding cannot faithfully enforce Claude's allow/block
semantics.

### Intercepted-tool model support

All configured model aliases support every intercepted tool. The bridge passes
the selected model through to the worker interaction; it does not silently
switch tool calls to a different model.

| Selectable Claude-facing alias | Resolved Gemini model | WebSearch | WebFetch | CodeExecution |
| --- | --- | --- | --- | --- |
| `GoogleAgent/claude-gemini-3.8-flash` | `gemini-3.8-flash` | Yes | Yes | Yes |
| `GoogleAgent/claude-gemini-3.1-pro-preview` | `gemini-3.1-pro-preview` | Yes | Yes | Yes |
| `GoogleAgent/claude-gemini-3.5-flash-lite` | `gemini-3.5-flash-lite` | Yes | Yes | Yes |

Claude Desktop's Sonnet, Opus, and Haiku façade selections resolve to the
corresponding rows in the model-policy table above and have the same tool
support.

### `-latest` aliases

Google describes `-latest` as a moving alias for the newest release of a model
variation; see its [model version-name guidance](https://ai.google.dev/gemini-api/docs/models#model-version-name-patterns).
The bridge recognizes these incoming aliases, but resolves them to its pinned
models so an intercepted tool call stays on the same model as its parent
request:

| Incoming Google `-latest` alias | Bridge model used for the main interaction and intercepted tools |
| --- | --- |
| `gemini-flash-latest` | `gemini-3.8-flash` |
| `gemini-pro-latest` | `gemini-3.1-pro-preview` |
| `gemini-flash-lite-latest` | `gemini-3.5-flash-lite` |

Hosted code execution only receives its task and inline data. Repository files,
builds, package installs, and persistent file changes remain local tools.

## Local state and operations

The extension writes its replay database below CCR's `app-data/plugins` folder.
It keeps the native interaction history required for stateless replay, including
model-generated thought signatures, function-call IDs, tool results, and the
conversation text needed to re-submit those steps exactly. Credentials are never
stored there. Operational logs do not capture credentials or full conversation
bodies by default. The `POST
/plugins/gemini-agent/cleanup` endpoint deletes state unused for 30 days. CCR's
existing ten-minute request timeout remains in force. The bridge sends SSE
keepalives every 15 seconds and retries transient Google failures at most twice.

Use `config.example.json` as a sanitized reference. The Google API key remains
only in CCR's existing `Google` provider configuration; never add it to Claude
Code settings or this extension's configuration.

## Gateway scope

CCR gateway routes cannot inspect a model and then fall through to another
provider. Consequently, this bridge only claims the universal `/v1/*` endpoints
when `exclusiveGatewayRoutes: true` is set. Enable that setting only for a
dedicated Gemini gateway; on a shared CCR gateway it stays disabled, preserving
the routes and model discovery of every other provider. Desktop profile
synchronization is likewise performed only in that dedicated mode.

For Claude Desktop, set `desktopProfilePath` in the plugin configuration to the
Desktop profile JSON. CCR's generic model discovery precedes extension routes,
so the bridge synchronizes its three explicit Gemini façade routes on CCR
startup instead of allowing generic discovery to replace them.

## Rollback

1. Stop CCR: `ccr stop`.
2. Restore the CCR configuration database from its backup using SQLite's
   `.backup` mechanism, or disable the `ccr-gemini-agent` plugin and select
   the prior `Google/...` profile.
3. Restore `~/.claude/settings.json` from its dated backup.
4. Start CCR with `ccr start --daemon --no-open --gateway`.

The extension source is self-contained in this directory; no global npm package
or CCR installation files are changed.
