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
continues. Other declared tools are returned to Claude Code as `tool_use`
blocks and remain subject to Claude Code's normal local permissions. Domain
filters deliberately fail with a clear error because Google grounding cannot
faithfully enforce Claude's allow/block semantics.

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
