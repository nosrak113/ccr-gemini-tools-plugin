"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { GeminiClient, ReplayStore, executeAnthropicRequest, toolDeclarations, generationConfig, normalizeModel, sse } = require("../lib.cjs");

test("maps pinned models and rejects unknown models", () => {
  assert.equal(normalizeModel("GoogleAgent/gemini-3.8-flash"), "gemini-3.8-flash");
  assert.equal(normalizeModel("GoogleAgent/claude-gemini-3.8-flash"), "gemini-3.8-flash");
  assert.equal(normalizeModel("anthropic/claude-sonnet-4-5"), "gemini-3.8-flash");
  assert.equal(normalizeModel("anthropic/claude-haiku"), "gemini-3.5-flash-lite");
  assert.equal(normalizeModel("GoogleAgent/claude-fable"), "gemini-3.8-flash");
  assert.equal(normalizeModel("fable"), "gemini-3.8-flash");
  assert.equal(normalizeModel("anthropic/claude-ccr-h47656d696e692d666c6173682d6c6174657374"), "gemini-3.8-flash");
  assert.equal(normalizeModel("anthropic/claude-ccr-h47656d696e692d70726f2d6c6174657374"), "gemini-3.1-pro-preview");
  assert.equal(normalizeModel("anthropic/claude-ccr-h476f6f676c652f67656d696e692d70726f2d6c6174657374"), "gemini-3.1-pro-preview");
  assert.equal(normalizeModel("anthropic/claude-ccr-h47656d696e692d666c6173682d6c6974652d6c6174657374"), "gemini-3.5-flash-lite");
  assert.throws(() => normalizeModel("GoogleAgent/gemini-2.5-pro"), /Unsupported/);
});

test("only declares bridge tools offered by the client", () => {
  assert.deepEqual(toolDeclarations({ tools: [], tool_choice: "none" }), []);
  const names = toolDeclarations({ tools: [{ type: "web_search_20250305" }, { type: "code_execution_20250825" }] }).map((tool) => tool.name);
  assert.deepEqual(names, ["WebSearch", "CodeExecution"]);
});

test("maps an explicit Claude tool choice to Gemini's required function mode", () => {
  const tools = toolDeclarations({ tools: [{ type: "web_search_20250305" }] });
  assert.deepEqual(generationConfig({ tool_choice: { type: "tool", name: "web_search" } }, "gemini-3.8-flash", tools).tool_choice,
    { allowed_tools: { mode: "any", tools: ["WebSearch"] } });
});

test("restores exact native steps for a matching session and transcript prefix", () => {
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-replay-")));
  const first = { messages: [{ role: "user", content: "Remember ORANGE-42" }] };
  const history = [
    { type: "user_input", content: [{ type: "text", text: "Remember ORANGE-42" }] },
    { type: "thought", signature: "native-signature" },
    { type: "model_output", content: [{ type: "text", text: "ACK" }] }
  ];
  replay.saveReplay("session-a", first, "gemini-3.8-flash", "ACK", history);
  const restored = replay.restoreForRequest("session-a", {
    messages: [...first.messages, { role: "assistant", content: "ACK" }, { role: "user", content: "What was the marker?" }]
  }, "gemini-3.8-flash");
  assert.deepEqual(restored, [...history, { type: "user_input", content: [{ type: "text", text: "What was the marker?" }] }]);
});

test("restores local-tool replay by exact tool ID when Desktop changes its system context", () => {
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-replay-")));
  const first = { system: "Desktop context version one", messages: [{ role: "user", content: "Read my saved location" }] };
  const assistant = {
    role: "assistant",
    content: [
      { type: "text", text: "I will check." },
      { type: "tool_use", id: "read-unique-1", name: "Read", input: { file_path: "/tmp/location.txt" } }
    ]
  };
  const history = [
    { type: "user_input", content: [{ type: "text", text: "Read my saved location" }] },
    { type: "thought", signature: "native-signature" },
    { type: "function_call", id: "read-unique-1", name: "Read", arguments: { file_path: "/tmp/location.txt" } }
  ];
  replay.saveReplay("desktop-session", first, "gemini-3.8-flash", "I will check.\n<tool_call id=\"read-unique-1\" name=\"Read\">{\"file_path\":\"/tmp/location.txt\"}</tool_call>", history);
  const restored = replay.restoreForRequest("desktop-session", {
    system: "Desktop context version two", messages: [
      ...first.messages,
      assistant,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read-unique-1", content: "Failed to read" }] }
    ]
  }, "gemini-3.8-flash");
  assert.deepEqual(restored, [...history, {
    type: "function_result", name: "Read", call_id: "read-unique-1", result: [{ type: "text", text: "Failed to read" }]
  }]);
});

test("restores the right replay when a session reuses a tool ID with different inputs", () => {
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-replay-")));
  const first = { system: "Desktop context one", messages: [{ role: "user", content: "Read the first file" }] };
  const second = { system: "Desktop context one", messages: [{ role: "user", content: "Read the second file" }] };
  const firstCall = { id: "reused-call", name: "Read", input: { file_path: "/tmp/first.txt" } };
  const secondCall = { id: "reused-call", name: "Read", input: { file_path: "/tmp/second.txt" } };
  const firstHistory = [{ type: "user_input", content: [{ type: "text", text: "first history" }] }, { type: "function_call", id: firstCall.id, name: firstCall.name, arguments: firstCall.input }];
  const secondHistory = [{ type: "user_input", content: [{ type: "text", text: "second history" }] }, { type: "function_call", id: secondCall.id, name: secondCall.name, arguments: secondCall.input }];
  replay.saveReplay("reused-id", first, "gemini-3.8-flash", '<tool_call id="reused-call" name="Read">{"file_path":"/tmp/first.txt"}</tool_call>', firstHistory, [firstCall]);
  replay.saveReplay("reused-id", second, "gemini-3.8-flash", '<tool_call id="reused-call" name="Read">{"file_path":"/tmp/second.txt"}</tool_call>', secondHistory, [secondCall]);

  const restored = replay.restoreForRequest("reused-id", {
    system: "Desktop context two",
    messages: [...second.messages, { role: "assistant", content: [{ type: "tool_use", ...secondCall }] }]
  }, "gemini-3.8-flash");

  assert.deepEqual(restored, secondHistory);
});

test("canonical tool fingerprints ignore input object key order", () => {
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-replay-")));
  const first = { system: "Desktop context one", messages: [{ role: "user", content: "List matching files" }] };
  const storedCall = { id: "ordered-call", name: "Glob", input: { path: "/tmp", filters: { extension: "txt", hidden: false } } };
  const requestCall = { id: "ordered-call", name: "Glob", input: { filters: { hidden: false, extension: "txt" }, path: "/tmp" } };
  const history = [{ type: "function_call", id: storedCall.id, name: storedCall.name, arguments: storedCall.input }];
  replay.saveReplay("key-order", first, "gemini-3.8-flash", '<tool_call id="ordered-call" name="Glob">{"path":"/tmp","filters":{"extension":"txt","hidden":false}}</tool_call>', history, [storedCall]);

  const restored = replay.restoreForRequest("key-order", {
    system: "Desktop context two",
    messages: [...first.messages, { role: "assistant", content: [{ type: "tool_use", ...requestCall }] }]
  }, "gemini-3.8-flash");

  assert.deepEqual(restored, history);
});

test("stable replay matching preserves local tool-call order", () => {
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-replay-")));
  const first = { system: "Desktop context one", messages: [{ role: "user", content: "Inspect both files" }] };
  const read = { id: "read-1", name: "Read", input: { file_path: "/tmp/a" } };
  const stat = { id: "stat-1", name: "Bash", input: { command: "stat /tmp/a" } };
  const firstHistory = [{ type: "user_input", content: [{ type: "text", text: "read then stat" }] }, { type: "function_call", id: read.id, name: read.name, arguments: read.input }, { type: "function_call", id: stat.id, name: stat.name, arguments: stat.input }];
  const secondHistory = [{ type: "user_input", content: [{ type: "text", text: "stat then read" }] }, { type: "function_call", id: stat.id, name: stat.name, arguments: stat.input }, { type: "function_call", id: read.id, name: read.name, arguments: read.input }];
  replay.saveReplay("ordered-calls", first, "gemini-3.8-flash", "read then stat", firstHistory, [read, stat]);
  replay.saveReplay("ordered-calls", first, "gemini-3.8-flash", "stat then read", secondHistory, [stat, read]);

  const restored = replay.restoreForRequest("ordered-calls", {
    system: "Desktop context two",
    messages: [...first.messages, { role: "assistant", content: [{ type: "tool_use", ...stat }, { type: "tool_use", ...read }] }]
  }, "gemini-3.8-flash");

  assert.deepEqual(restored, secondHistory);
});

test("migrates and semantically restores pre-fingerprint replay rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "gemini-agent-replay-"));
  const db = new DatabaseSync(join(directory, "gemini-agent-replay.sqlite"));
  db.exec("CREATE TABLE replays (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, model TEXT NOT NULL, prefix_hash TEXT NOT NULL, assistant_text TEXT NOT NULL, history_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL)");
  const storedCall = { id: "legacy-call", name: "Read", input: { file_path: "/tmp/legacy.txt", options: { line_end: 2, line_start: 1 } } };
  const history = [{ type: "function_call", id: storedCall.id, name: storedCall.name, arguments: storedCall.input }];
  const now = Date.now();
  db.prepare("INSERT INTO replays VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-row", "legacy-session", "gemini-3.8-flash", "old-prefix", '<tool_call id="legacy-call" name="Read">{"file_path":"/tmp/legacy.txt","options":{"line_end":2,"line_start":1}}</tool_call>', JSON.stringify(history), now, now);
  db.close();

  const replay = new ReplayStore(directory);
  const columns = replay.db.prepare("PRAGMA table_info(replays)").all().map((column) => column.name);
  assert.equal(columns.includes("message_prefix_hash"), true);
  assert.equal(columns.includes("tool_fingerprint"), true);
  const requestCall = { id: "legacy-call", name: "Read", input: { options: { line_start: 1, line_end: 2 }, file_path: "/tmp/legacy.txt" } };
  const restored = replay.restoreForRequest("legacy-session", {
    system: "new desktop context",
    messages: [{ role: "user", content: "Read the legacy file" }, { role: "assistant", content: [{ type: "tool_use", ...requestCall }] }]
  }, "gemini-3.8-flash");

  assert.deepEqual(restored, history);
});

test("keeps a 409 when duplicate tool-call histories remain irreducibly ambiguous", () => {
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-replay-")));
  const first = { system: "Desktop context one", messages: [{ role: "user", content: "Read the file" }] };
  const call = { id: "same-call", name: "Read", input: { file_path: "/tmp/same.txt" } };
  const firstHistory = [{ type: "user_input", content: [{ type: "text", text: "first candidate" }] }, { type: "function_call", id: call.id, name: call.name, arguments: call.input }];
  const secondHistory = [{ type: "user_input", content: [{ type: "text", text: "second candidate" }] }, { type: "function_call", id: call.id, name: call.name, arguments: call.input }];
  const serializedCall = '<tool_call id="same-call" name="Read">{"file_path":"/tmp/same.txt"}</tool_call>';
  replay.saveReplay("ambiguous", first, "gemini-3.8-flash", `first response\n${serializedCall}`, firstHistory, [call]);
  replay.saveReplay("ambiguous", first, "gemini-3.8-flash", `second response\n${serializedCall}`, secondHistory, [call]);

  assert.throws(() => replay.restoreForRequest("ambiguous", {
    system: "Desktop context two",
    messages: [...first.messages, { role: "assistant", content: [{ type: "tool_use", ...call }] }]
  }, "gemini-3.8-flash"), (error) => error.status === 409 && error.type === "replay_state_ambiguous");
});

test("matches replayed tool results against Gemini call_id and retains accompanying user text", () => {
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-replay-")));
  const first = { messages: [{ role: "user", content: "Read the file" }] };
  const assistantText = '<tool_call id="call-id-only" name="Read">{}</tool_call>';
  const history = [
    { type: "user_input", content: [{ type: "text", text: "Read the file" }] },
    { type: "function_call", call_id: "call-id-only", name: "Read", arguments: {} }
  ];
  replay.saveReplay("session-call-id", first, "gemini-3.8-flash", assistantText, history);
  const restored = replay.restoreForRequest("session-call-id", {
    messages: [
      ...first.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "call-id-only", name: "Read", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call-id-only", content: "file contents" },
        { type: "text", text: "Now summarize it in one sentence." }
      ] }
    ]
  }, "gemini-3.8-flash");
  assert.deepEqual(restored.slice(-2), [
    { type: "function_result", name: "Read", call_id: "call-id-only", result: [{ type: "text", text: "file contents" }] },
    { type: "user_input", content: [{ type: "text", text: "Now summarize it in one sentence." }] }
  ]);
});

test("uses WAL and a busy timeout without creating the obsolete turns table", () => {
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-replay-")));
  assert.equal(replay.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(replay.db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  assert.equal(replay.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get(), undefined);
});

test("does not serialize unrecoverable local tool calls into model text", () => {
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-replay-")));
  assert.throws(() => replay.restoreForRequest("desktop-session", {
    messages: [
      { role: "user", content: "Read my saved location" },
      { role: "assistant", content: [{ type: "tool_use", id: "missing-call", name: "Read", input: { file_path: "/tmp/location.txt" } }] }
    ]
  }, "gemini-3.8-flash"), /replay state is unavailable/);
});

test("streams local tool arguments as Anthropic input_json_delta events", () => {
  let output = "";
  const response = { write: (chunk) => { output += chunk; }, end: () => {} };
  sse(response, {
    id: "msg_test", model: "anthropic/claude-sonnet-4-5", usage: {}, stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "ls -la", description: "List files" } }]
  });
  assert.match(output, /"content_block_start"/);
  assert.match(output, /"input":\{\}/);
  assert.match(output, /"type":"input_json_delta"/);
  const delta = output.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "content_block_delta");
  assert.deepEqual(JSON.parse(delta.delta.partial_json), { command: "ls -la", description: "List files" });
});

test("streams final output token usage", () => {
  let output = "";
  sse({ write: (chunk) => { output += chunk; }, end: () => {} }, {
    id: "msg_usage", model: "anthropic/claude-sonnet-4-5", usage: { input_tokens: 2, output_tokens: 17 }, stop_reason: "end_turn",
    content: [{ type: "text", text: "Done" }]
  });
  const messageDelta = output.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "message_delta");
  assert.equal(messageDelta.usage.output_tokens, 17);
});

test("executes a native search internally and returns a final Claude message", async () => {
  const calls = [];
  const responses = [
    { output_text: "", steps: [{ type: "function_call", id: "search-1", name: "WebSearch", arguments: { query: "Gemini API" } }] },
    { output_text: "Grounded answer", steps: [{ type: "model_output", content: [{ type: "text", text: "Grounded answer" }] }] },
    { output_text: "Final answer", steps: [{ type: "model_output", content: [{ type: "text", text: "Final answer" }] }] }
  ];
  const client = new GeminiClient({ apiKey: "test", fetchImpl: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-test-")));
  const message = await executeAnthropicRequest({ body: { model: "GoogleAgent/gemini-3.8-flash", messages: [{ role: "user", content: "Research Gemini API" }], tools: [{ type: "web_search_20250305" }] }, client, replay });
  assert.equal(message.stop_reason, "end_turn");
  assert.equal(message.content.at(-1).text, "Final answer");
  assert.equal(calls[0].generation_config.thinking_level, "high");
  assert.equal(calls[0].generation_config.max_output_tokens, 65536);
  assert.equal(calls[0].input[0].type, "user_input");
  assert.equal(calls[2].input.some((step) => step.type === "function_call"), true);
  assert.deepEqual(calls[1].tools, [{ type: "google_search" }]);
  assert.equal(calls.every((call) => call.store === false), true);
});

test("uses the request's selected model for intercepted tools", async () => {
  const calls = [];
  const responses = [
    { output_text: "", steps: [{ type: "function_call", id: "search-1", name: "WebSearch", arguments: { query: "Gemini API" } }] },
    { output_text: "Grounded answer", steps: [{ type: "model_output", content: [{ type: "text", text: "Grounded answer" }] }] },
    { output_text: "Final answer", steps: [{ type: "model_output", content: [{ type: "text", text: "Final answer" }] }] }
  ];
  const client = new GeminiClient({ apiKey: "test", fetchImpl: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-test-")));
  await executeAnthropicRequest({ body: { model: "GoogleAgent/gemini-3.5-flash-lite", messages: [{ role: "user", content: "Research Gemini API" }], tools: [{ type: "web_search_20250305" }] }, client, replay });
  assert.equal(calls[0].model, "gemini-3.5-flash-lite");
  assert.equal(calls[1].model, "gemini-3.5-flash-lite");
  assert.equal(calls[1].generation_config.thinking_level, "low");
});

test("does not duplicate native steps when bridge and local tools are returned together", async () => {
  const responses = [
    { output_text: "", steps: [
      { type: "function_call", id: "search-1", name: "WebSearch", arguments: { query: "Gemini API" } },
      { type: "function_call", id: "bash-1", name: "Bash", arguments: { command: "pwd" } }
    ] },
    { output_text: "search result", steps: [{ type: "model_output", content: [{ type: "text", text: "search result" }] }] }
  ];
  const client = new GeminiClient({ apiKey: "test", fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } }) });
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-test-")));
  const body = { model: "GoogleAgent/gemini-3.8-flash", messages: [{ role: "user", content: "Search, then run pwd" }], tools: [{ type: "web_search_20250305" }, { name: "Bash", input_schema: { type: "object" } }] };
  const message = await executeAnthropicRequest({ body, client, replay });
  assert.equal(message.stop_reason, "tool_use");
  const stored = replay.db.prepare("SELECT history_json, tool_fingerprint FROM replays").get();
  const history = JSON.parse(stored.history_json);
  assert.equal(history.filter((step) => step.type === "function_call" && step.id === "search-1").length, 1);
  assert.equal(history.filter((step) => step.type === "function_call" && step.id === "bash-1").length, 1);
  assert.equal(typeof stored.tool_fingerprint, "string");
});

test("returns bridge worker failures to Gemini as function results", async () => {
  const requests = [];
  const responses = [
    { output_text: "", steps: [{ type: "function_call", id: "fetch-1", name: "WebFetch", arguments: { url: "http://example.com" } }] },
    { output_text: "I need an HTTPS URL.", steps: [{ type: "model_output", content: [{ type: "text", text: "I need an HTTPS URL." }] }] }
  ];
  const client = new GeminiClient({ apiKey: "test", fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-test-")));
  const message = await executeAnthropicRequest({ body: { model: "GoogleAgent/gemini-3.8-flash", messages: [{ role: "user", content: "Fetch this" }], tools: [{ type: "web_fetch_20250910" }] }, client, replay });
  assert.equal(message.content.at(-1).text, "I need an HTTPS URL.");
  const result = requests[1].input.find((step) => step.type === "function_result");
  assert.match(result.result[0].text, /^Error: URL Context requires/);
});

test("propagates bridge worker cancellation instead of turning it into a tool result", async () => {
  let requestCount = 0;
  const aborted = new Error("request cancelled");
  aborted.name = "AbortError";
  const client = new GeminiClient({ apiKey: "test", fetchImpl: async () => {
    requestCount += 1;
    if (requestCount === 1) return new Response(JSON.stringify({ output_text: "", steps: [{ type: "function_call", id: "fetch-1", name: "WebFetch", arguments: { url: "https://example.com" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    throw aborted;
  } });
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-test-")));
  await assert.rejects(() => executeAnthropicRequest({ body: { model: "GoogleAgent/gemini-3.8-flash", messages: [{ role: "user", content: "Fetch this" }], tools: [{ type: "web_fetch_20250910" }] }, client, replay }), aborted);
});

test("preserves max_tokens across multi-round tool loops", () => {
  const config = generationConfig({ max_tokens: 500 }, "gemini-3.8-flash", []);
  assert.equal(config.max_output_tokens, 500);
});

test("GeminiClient aborts immediately on AbortError without retry", async () => {
  let attempts = 0;
  const aborted = new Error("aborted");
  aborted.name = "AbortError";
  const client = new GeminiClient({ apiKey: "test", fetchImpl: async () => {
    attempts += 1;
    throw aborted;
  } });
  await assert.rejects(() => client.interaction({}), aborted);
  assert.equal(attempts, 1);
});

test("sets stop_reason to max_tokens when generation is truncated", async () => {
  const client = new GeminiClient({ apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({
    output_text: "Truncated text", status: "budget_exceeded", steps: [{ type: "model_output", content: [{ type: "text", text: "Truncated text" }] }]
  }), { status: 200, headers: { "content-type": "application/json" } }) });
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-test-")));
  const message = await executeAnthropicRequest({ body: { model: "GoogleAgent/gemini-3.8-flash", messages: [{ role: "user", content: "Write a long essay" }] }, client, replay });
  assert.equal(message.stop_reason, "max_tokens");
});

test("assigns generated UUID back to function_call step in latest.steps", async () => {
  const step = { type: "function_call", name: "Bash", arguments: { command: "ls" } };
  const client = new GeminiClient({ apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({
    output_text: "", steps: [step]
  }), { status: 200, headers: { "content-type": "application/json" } }) });
  const replay = new ReplayStore(mkdtempSync(join(tmpdir(), "gemini-agent-test-")));
  const message = await executeAnthropicRequest({ body: { model: "GoogleAgent/gemini-3.8-flash", messages: [{ role: "user", content: "Run ls" }], tools: [{ name: "Bash", input_schema: { type: "object" } }] }, client, replay });
  assert.equal(message.stop_reason, "tool_use");
  const stored = replay.db.prepare("SELECT history_json FROM replays").get();
  const history = JSON.parse(stored.history_json);
  const storedStep = history.find((s) => s.type === "function_call" && s.name === "Bash");
  assert.equal(typeof storedStep.id, "string");
  assert.equal(message.content[0].id, storedStep.id);
});
