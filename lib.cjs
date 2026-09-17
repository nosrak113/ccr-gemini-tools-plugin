"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { join } = require("node:path");

const MODELS = Object.freeze({
  primary: "gemini-3.8-flash",
  preview: "gemini-3.1-pro-preview",
  helper: "gemini-3.5-flash-lite"
});
const CLIENT_MODELS = Object.freeze({
  primary: "claude-gemini-3.8-flash",
  preview: "claude-gemini-3.1-pro-preview",
  helper: "claude-gemini-3.5-flash-lite"
});
const DESKTOP_MODELS = Object.freeze({
  primary: "anthropic/claude-sonnet-4-5",
  preview: "anthropic/claude-opus-4-5",
  helper: "anthropic/claude-haiku-4-5"
});
const BRIDGE_TOOLS = new Set(["WebSearch", "WebFetch", "CodeExecution"]);
const MAX_TOOL_ROUNDS = 12;

function fail(status, message, type = "api_error") {
  const error = new Error(message);
  error.status = status;
  error.type = type;
  return error;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    if (part.type === "text" || part.type === "input_text") return part.text || "";
    if (part.type === "tool_result") return `<tool_result id="${part.tool_use_id || "unknown"}">${textOf(part.content)}</tool_result>`;
    return "";
  }).join("\n");
}

function normalizeModel(model) {
  const original = String(model || "");
  const encoded = original.match(/(?:^|\/)claude-ccr-h([0-9a-f]+)$/i);
  if (encoded && encoded[1].length % 2 === 0) {
    const underlying = Buffer.from(encoded[1], "hex").toString("utf8").toLowerCase();
    if (underlying === "gemini-flash-latest") return MODELS.primary;
    if (underlying === "gemini-pro-latest") return MODELS.preview;
    if (underlying === "gemini-flash-lite-latest") return MODELS.helper;
  }
  const clean = original.replace(/^(GoogleAgent\/|anthropic\/)/i, "").replace(/\[1m\]$/i, "").replace(/^claude-/i, "");
  if (clean === "sonnet-4-5") return MODELS.primary;
  if (clean === "opus-4-5") return MODELS.preview;
  if (clean === "haiku-4-5") return MODELS.helper;
  if (clean === "haiku") return MODELS.helper;
  if (!clean || clean === "default" || clean === "sonnet" || clean === "opus") return MODELS.primary;
  if ([MODELS.primary, MODELS.preview, MODELS.helper].includes(clean)) return clean;
  throw fail(400, `Unsupported GoogleAgent model: ${model}`, "invalid_request_error");
}

function effortFor(model) {
  return model === MODELS.helper ? "low" : "high";
}

function turnText(message) {
  const content = textOf(message.content);
  if (message.role === "assistant") {
    const calls = Array.isArray(message.content) ? message.content
      .filter((part) => part && part.type === "tool_use")
      .map((part) => `<tool_call id="${part.id}" name="${part.name}">${JSON.stringify(part.input || {})}</tool_call>`)
      .join("\n") : "";
    return [content, calls].filter(Boolean).join("\n");
  }
  return content;
}

function toolUses(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part && part.type === "tool_use" && part.id && part.name)
    : [];
}

function toInteractionInput(body) {
  const input = [];
  for (const message of body.messages || []) {
    const text = turnText(message);
    if (!text) continue;
    input.push(message.role === "assistant"
      ? { type: "model_output", content: [{ type: "text", text }] }
      : { type: "user_input", content: [{ type: "text", text }] });
  }
  return input.length ? input : [{ type: "user_input", content: [{ type: "text", text: "" }] }];
}

function systemInstruction(body) {
  const text = textOf(body.system);
  return text || undefined;
}

function functionResult(call, result) {
  return {
    type: "function_result",
    name: call.name,
    call_id: call.id,
    result: [{ type: "text", text: result }]
  };
}

function toolDeclarations(body) {
  const declarations = [];
  const toolsDisabled = body.tool_choice === "none" || body.tool_choice?.type === "none";
  if (toolsDisabled) return declarations;
  let codeExecutionEnabled = false;
  for (const tool of body.tools || []) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "web_search_20250305") {
      declarations.push({ type: "function", name: "WebSearch", description: "Search the public web with Google Search grounding.", parameters: { type: "object", properties: { query: { type: "string" }, allowed_domains: { type: "array", items: { type: "string" } }, blocked_domains: { type: "array", items: { type: "string" } } }, required: ["query"] } });
    } else if (tool.type === "web_fetch_20250910") {
      declarations.push({ type: "function", name: "WebFetch", description: "Read a public URL using Gemini URL Context.", parameters: { type: "object", properties: { url: { type: "string" }, prompt: { type: "string" } }, required: ["url"] } });
    } else if (String(tool.type || "").includes("code_execution")) {
      codeExecutionEnabled = true;
    } else if (tool.name && tool.input_schema) {
      declarations.push({ type: "function", name: tool.name, description: tool.description || "", parameters: tool.input_schema });
    }
  }
  if (codeExecutionEnabled) declarations.push({ type: "function", name: "CodeExecution", description: "Run a self-contained Python calculation in Gemini's hosted execution environment. Do not use this for repository files, builds, package installation, or persistent changes.", parameters: { type: "object", properties: { task: { type: "string" }, data: {} }, required: ["task"] } });
  return declarations;
}

function generationConfig(body, model, tools) {
  const requested = Number(body.max_tokens);
  const config = {
    thinking_level: effortFor(model),
    max_output_tokens: Number.isFinite(requested) && requested > 0 ? Math.min(65536, Math.floor(requested)) : 65536
  };
  const choice = body.tool_choice;
  if (choice?.type === "any") {
    config.tool_choice = { allowed_tools: { mode: "any", tools: tools.map((tool) => tool.name) } };
  } else if (choice?.type === "tool" && choice.name) {
    const names = new Set(tools.map((tool) => tool.name));
    const selected = names.has(choice.name) ? choice.name
      : choice.name === "web_search" ? "WebSearch"
      : choice.name === "web_fetch" ? "WebFetch"
      : choice.name === "code_execution" ? "CodeExecution" : choice.name;
    if (!names.has(selected)) throw fail(400, `Requested tool is not available: ${choice.name}`, "invalid_request_error");
    config.tool_choice = { allowed_tools: { mode: "any", tools: [selected] } };
  } else if (choice === "none" || choice?.type === "none") {
    config.tool_choice = "none";
  }
  return config;
}

function responseText(interaction) {
  if (typeof interaction.output_text === "string") return interaction.output_text;
  const chunks = [];
  for (const step of interaction.steps || []) {
    if (step.type !== "model_output") continue;
    for (const content of step.content || []) if (content.type === "text" && content.text) chunks.push(content.text);
  }
  return chunks.join("\n");
}

function functionCalls(interaction) {
  const calls = [];
  for (const step of interaction.steps || []) {
    if (step.type !== "function_call") continue;
    calls.push({ id: step.id || step.call_id || randomUUID(), name: step.name, input: step.arguments || step.args || {} });
  }
  return calls;
}

function citations(interaction) {
  const items = [];
  for (const step of interaction.steps || []) for (const content of step.content || []) {
    for (const annotation of content.annotations || []) if (annotation.type === "url_citation" && annotation.url) items.push({ url: annotation.url, title: annotation.title || annotation.url });
  }
  return items;
}

class ReplayStore {
  constructor(directory) {
    this.db = new DatabaseSync(join(directory, "gemini-agent-replay.sqlite"));
    // Concurrent gateway requests may share this replay database. WAL lets readers
    // proceed while a replay is written, and the timeout avoids transient BUSY
    // failures when two tool turns finish together.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec("CREATE TABLE IF NOT EXISTS replays (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, model TEXT NOT NULL, prefix_hash TEXT NOT NULL, assistant_text TEXT NOT NULL, history_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL)");
    this.db.exec("CREATE INDEX IF NOT EXISTS replays_lookup ON replays(session_key, model, prefix_hash, last_used_at DESC)");
  }
  prefixHash(body, beforeIndex) {
    return createHash("sha256").update(JSON.stringify({ system: body.system || "", messages: (body.messages || []).slice(0, beforeIndex) })).digest("hex");
  }
  saveReplay(sessionKey, body, model, assistantText, history) {
    const now = Date.now();
    this.db.prepare("INSERT INTO replays VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), sessionKey, model, this.prefixHash(body, (body.messages || []).length), assistantText, JSON.stringify(history), now, now);
  }
  restoreForRequest(sessionKey, body, model) {
    const messages = body.messages || [];
    const dialogue = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index] || {};
      if (message.role === "assistant") {
        const assistantText = turnText(message);
        let row = this.db.prepare("SELECT id, history_json FROM replays WHERE session_key = ? AND model = ? AND prefix_hash = ? AND assistant_text = ? ORDER BY last_used_at DESC LIMIT 1")
          .get(sessionKey, model, this.prefixHash(body, index), assistantText);
        const calls = toolUses(message);
        // Claude Desktop updates its injected system context between tool turns.
        // The transcript prefix then changes even though the function-call IDs
        // still identify the exact native interaction that must be replayed.
        if (!row && calls.length) {
          const predicates = calls.map(() => "assistant_text LIKE ?").join(" AND ");
          const candidates = this.db.prepare(`SELECT id, history_json FROM replays WHERE session_key = ? AND model = ? AND ${predicates} ORDER BY last_used_at DESC LIMIT 2`)
            .all(sessionKey, model, ...calls.map((call) => `%<tool_call id=\"${call.id}\" name=\"${call.name}\">%`));
          if (candidates.length === 1) row = candidates[0];
          else if (!candidates.length) throw fail(409, "Cannot resume this local tool call because its Gemini replay state is unavailable. Restart the conversation from before the tool call.", "replay_state_missing");
          else throw fail(409, "Cannot resume this local tool call because its Gemini replay state is ambiguous. Restart the conversation from before the tool call.", "replay_state_ambiguous");
        }
        if (row) {
          this.db.prepare("UPDATE replays SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
          dialogue.splice(0, dialogue.length, ...JSON.parse(row.history_json));
          continue;
        }
        if (calls.length) throw fail(409, "Cannot resume this local tool call because its Gemini replay state is unavailable. Restart the conversation from before the tool call.", "replay_state_missing");
        if (assistantText) dialogue.push({ type: "model_output", content: [{ type: "text", text: assistantText }] });
        continue;
      }
      const toolResults = Array.isArray(message.content) ? message.content.filter((part) => part?.type === "tool_result") : [];
      if (toolResults.length) {
        for (const result of toolResults) {
          const call = [...dialogue].reverse().find((step) => step.type === "function_call" && (step.id === result.tool_use_id || step.call_id === result.tool_use_id));
          if (call) dialogue.push(functionResult({ id: call.id || call.call_id, name: call.name }, textOf(result.content)));
          else dialogue.push({ type: "user_input", content: [{ type: "text", text: turnText(message) }] });
        }
        const accompanyingText = message.content
          .filter((part) => part && (part.type === "text" || part.type === "input_text"))
          .map((part) => part.text || "")
          .filter(Boolean)
          .join("\n");
        if (accompanyingText) dialogue.push({ type: "user_input", content: [{ type: "text", text: accompanyingText }] });
        continue;
      }
      const text = turnText(message);
      if (text) dialogue.push({ type: "user_input", content: [{ type: "text", text }] });
    }
    return dialogue.length ? dialogue : [{ type: "user_input", content: [{ type: "text", text: "" }] }];
  }
  cleanup(days = 30) {
    const cutoff = Date.now() - days * 86400000;
    const replays = this.db.prepare("DELETE FROM replays WHERE last_used_at < ?").run(cutoff).changes;
    return replays;
  }
}

class GeminiClient {
  constructor({ apiKey, fetchImpl = fetch, baseUrl = "https://generativelanguage.googleapis.com/v1beta" }) {
    if (!apiKey) throw fail(500, "GoogleAgent has no configured Google API key.", "configuration_error");
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  async interaction(payload, signal) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetch(`${this.baseUrl}/interactions`, { method: "POST", signal, headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey }, body: JSON.stringify(payload) });
        if (response.ok) return response.json();
        const body = await response.text();
        if ((response.status !== 429 && response.status < 500) || attempt === 2) throw fail(response.status, `Gemini Interactions request failed: ${body.slice(0, 1000)}`);
        const wait = Math.min(8000, 500 * 2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, wait));
      } catch (error) {
        lastError = error;
        if (error.status && error.status < 500 && error.status !== 429) throw error;
        if (attempt === 2) throw error;
      }
    }
    throw lastError;
  }
}

async function runWorker(client, call, model, signal) {
  const input = call.input || {};
  if (call.name === "WebSearch") {
    if ((input.allowed_domains && input.allowed_domains.length) || (input.blocked_domains && input.blocked_domains.length)) throw fail(400, "Google Search grounding cannot faithfully enforce Claude domain filters.", "invalid_request_error");
    const response = await client.interaction({ model, input: String(input.query || ""), tools: [{ type: "google_search" }], generation_config: { thinking_level: effortFor(model) }, store: false }, signal);
    return { kind: "search", text: responseText(response), citations: citations(response), raw: response };
  }
  if (call.name === "WebFetch") {
    const url = String(input.url || "");
    if (!/^https:\/\//i.test(url) || /https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url)) throw fail(400, "URL Context requires a publicly accessible HTTPS URL.", "invalid_request_error");
    const response = await client.interaction({ model, input: `${input.prompt || "Read and summarize this URL accurately."}\n\nURL: ${url}`, tools: [{ type: "url_context" }], generation_config: { thinking_level: effortFor(model) }, store: false }, signal);
    return { kind: "fetch", text: responseText(response), citations: citations(response), raw: response };
  }
  if (call.name === "CodeExecution") {
    const response = await client.interaction({ model, input: `${input.task}\n\nInline data: ${JSON.stringify(input.data ?? null)}`, tools: [{ type: "code_execution" }], generation_config: { thinking_level: effortFor(model) }, store: false }, signal);
    const evidence = (response.steps || []).filter((step) => step.type === "code_execution_result" || step.type === "executable_code");
    if (!evidence.length) throw fail(502, "Gemini returned no hosted code-execution evidence.", "tool_error");
    return { kind: "code", text: responseText(response), citations: [], raw: response };
  }
  throw fail(400, `Unknown bridge tool: ${call.name}`, "invalid_request_error");
}

function serverBlocks(worker, call) {
  if (worker.kind === "search") return [
    { type: "server_tool_use", id: call.id, name: "web_search", input: { query: call.input.query } },
    { type: "web_search_tool_result", tool_use_id: call.id, content: worker.citations.map((citation) => ({ type: "web_search_result", url: citation.url, title: citation.title })) }
  ];
  if (worker.kind === "fetch") return [
    { type: "server_tool_use", id: call.id, name: "web_fetch", input: { url: call.input.url } },
    { type: "web_fetch_tool_result", tool_use_id: call.id, content: { type: "web_fetch_result", url: call.input.url, content: { type: "document", source: { type: "text", media_type: "text/plain", data: worker.text } } } }
  ];
  return [{ type: "text", text: `Hosted Python execution\n${worker.text}` }];
}

async function executeAnthropicRequest({ body, client, replay, signal, sessionKey: suppliedSessionKey }) {
  const model = normalizeModel(body.model);
  const sessionKey = String(suppliedSessionKey || body.metadata?.user_id || "default");
  const dialogue = replay.restoreForRequest(sessionKey, body, model);
  const tools = toolDeclarations(body);
  const system_instruction = systemInstruction(body);
  const visible = [];
  let latest;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    // An Anthropic forced tool choice applies to the first decision only. Once a
    // bridge tool has supplied its result, forcing it again would cause a loop.
    const generation_config = round === 0
      ? generationConfig(body, model, tools)
      : generationConfig({}, model, tools);
    latest = await client.interaction({ model, input: dialogue, tools, system_instruction, generation_config, store: false }, signal);
    const calls = functionCalls(latest);
    const bridgeCalls = calls.filter((call) => BRIDGE_TOOLS.has(call.name));
    const localCalls = calls.filter((call) => !BRIDGE_TOOLS.has(call.name));
    let stepsAppended = false;
    if (bridgeCalls.length) {
      // Stateless Interactions requires the exact returned steps, including thought
      // signatures and function-call IDs, before any function result is appended.
      dialogue.push(...(latest.steps || []));
      stepsAppended = true;
      for (const call of bridgeCalls) {
        try {
          const worker = await runWorker(client, call, model, signal);
          visible.push(...serverBlocks(worker, call));
          dialogue.push(functionResult(call, worker.text));
        } catch (error) {
          // Cancellation and upstream transport failures belong to the request,
          // rather than to the model's tool invocation. Surface those normally.
          if (signal?.aborted || error?.name === "AbortError" || !["invalid_request_error", "tool_error"].includes(error?.type)) throw error;
          // A model-generated bridge call can be invalid (for example, a non-HTTPS
          // URL). Feed the failure back to Gemini so it can correct itself instead
          // of failing the entire Anthropic request.
          dialogue.push(functionResult(call, `Error: ${error.message || "Bridge tool failed."}`));
        }
      }
      if (!localCalls.length) continue;
    }
    const content = [...visible];
    const text = responseText(latest);
    if (text) content.push({ type: "text", text });
    for (const call of localCalls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    const response = { id: `msg_${randomUUID().replace(/-/g, "")}`, type: "message", role: "assistant", model: body.model, content: content.length ? content : [{ type: "text", text: "" }], stop_reason: localCalls.length ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: latest.usage?.total_input_tokens || 0, output_tokens: latest.usage?.total_output_tokens || 0 } };
    if (!stepsAppended) dialogue.push(...(latest.steps || []));
    replay.saveReplay(sessionKey, body, model, turnText({ role: "assistant", content: response.content }), dialogue);
    return response;
  }
  throw fail(429, `GoogleAgent exceeded its ${MAX_TOOL_ROUNDS} native-tool-round limit.`, "tool_limit_error");
}

function sse(response, message) {
  response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: message.id, type: "message", role: "assistant", model: message.model, content: [], usage: message.usage } })}\n\n`);
  message.content.forEach((block, index) => {
    // Anthropic streaming requires function inputs as input_json_delta events.
    // Supplying input on content_block_start works in some clients but Claude
    // Desktop treats every property as unknown, causing valid calls such as
    // Bash({ command: "ls" }) to fail schema validation.
    const contentBlock = block.type === "text"
      ? { type: "text", text: "" }
      : block.type === "tool_use"
        ? { type: "tool_use", id: block.id, name: block.name, input: {} }
        : block;
    response.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: contentBlock })}\n\n`);
    if (block.type === "text" && block.text) response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } })}\n\n`);
    if (block.type === "tool_use") response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } })}\n\n`);
    response.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`);
  });
  response.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage?.output_tokens || 0 } })}\n\n`);
  response.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  response.end();
}

module.exports = { MODELS, CLIENT_MODELS, DESKTOP_MODELS, ReplayStore, GeminiClient, executeAnthropicRequest, normalizeModel, effortFor, toolDeclarations, toInteractionInput, generationConfig, sse, fail };
