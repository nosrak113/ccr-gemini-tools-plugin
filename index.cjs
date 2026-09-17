"use strict";

const { readFileSync, writeFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { join, resolve } = require("node:path");
const { homedir } = require("node:os");
const { GeminiClient, ReplayStore, executeAnthropicRequest, normalizeModel, MODELS, CLIENT_MODELS, DESKTOP_MODELS, sse } = require("./lib.cjs");

let requestLogDb = null;

function googleKey(config, providerName) {
  const provider = (config.Providers || []).find((item) => item.name === providerName) || (config.Providers || []).find((item) => item.name === "Google");
  return provider && (provider.api_key || provider.apiKey);
}

function syncDesktopGatewayProfile(profilePath, logger) {
  if (!profilePath) return;
  try {
    const expandedProfilePath = profilePath === "~" || profilePath.startsWith("~/")
      ? resolve(homedir(), profilePath.slice(2))
      : profilePath;
    const profile = JSON.parse(readFileSync(expandedProfilePath, "utf8"));
    profile.inferenceProvider = "gateway";
    profile.inferenceGatewayBaseUrl = "http://127.0.0.1:3456";
    profile.inferenceGatewayAuthScheme = "x-api-key";
    profile.modelDiscoveryEnabled = false;
    profile.inferenceModels = [
      { name: DESKTOP_MODELS.primary, labelOverride: "Gemini 3.8 Flash (high reasoning)", supports1m: true },
      { name: DESKTOP_MODELS.preview, labelOverride: "Gemini 3.1 Pro Preview (high reasoning)", supports1m: true },
      { name: DESKTOP_MODELS.helper, labelOverride: "Gemini 3.5 Flash-Lite (low reasoning)", supports1m: true }
    ];
    writeFileSync(expandedProfilePath, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
    logger.info("Claude Desktop gateway profile synchronized");
  } catch (error) {
    logger.warn(`Could not synchronize Claude Desktop gateway profile: ${error.message}`);
  }
}

function openRequestLogDb(dataDir, logger) {
  try {
    const db = new DatabaseSync(join(dataDir, "request-logs.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL");
    return db;
  } catch (error) {
    logger.warn(`Could not open CCR request log database: ${error.message}`);
    return null;
  }
}

function closeRequestLogDb() {
  if (!requestLogDb) return;
  try {
    requestLogDb.close();
  } finally {
    requestLogDb = null;
  }
}

function recordCcrRequest(details, logger) {
  if (!requestLogDb) return;
  try {
    const now = new Date().toISOString();
    const toolNames = (details.response?.content || [])
      .filter((block) => block?.type === "tool_use" || block?.type === "server_tool_use")
      .map((block) => block.name).filter(Boolean);
    const usage = details.response?.usage || {};
    requestLogDb.prepare(`INSERT INTO request_logs (
      created_at, completed_at, request_id, event_id, client, method, path, url,
      provider, model, requested_model, resolved_model, response_model, is_stream,
      status_code, ok, gateway_status_code, gateway_ok, duration_ms,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, total_tokens,
      pricing_json, stream_metrics_json, error
    ) VALUES (?, ?, ?, ?, ?, 'POST', '/v1/messages', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        now, now, details.requestId, details.requestId,
        details.client, "GoogleAgent", details.requestedModel, details.requestedModel,
        details.resolvedModel, details.response?.model || details.requestedModel,
        details.stream ? 1 : 0, details.status, details.status < 400 ? 1 : 0,
        details.status, details.status < 400 ? 1 : 0, Date.now() - details.startedAt,
        usage.input_tokens || 0, usage.output_tokens || 0, 0, 0,
        (usage.input_tokens || 0) + (usage.output_tokens || 0),
        JSON.stringify({ configured_effort: details.resolvedModel === MODELS.helper ? "low" : "high" }),
        JSON.stringify({ native_tool_invocations: toolNames }), details.error || ""
      );
  } catch (error) {
    logger.warn(`Could not write CCR request log: ${error.message}`);
  }
}

function countRequestTokens(body) {
  // CCR's built-in counter is unavailable from gateway route handlers. Count all
  // request inputs rather than accidentally choosing messages over system.
  const input = `${JSON.stringify(body?.system ?? "")}${JSON.stringify(body?.messages ?? [])}`;
  return Math.ceil(input.length / 4);
}

function sendSseError(response, error) {
  if (!response.writableEnded) {
    response.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: error.type || "api_error", message: error.message || "GoogleAgent failed" } })}\n\n`);
    response.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
    response.end();
  }
}

module.exports = {
  async setup(ctx) {
    const config = ctx.pluginConfig || {};
    closeRequestLogDb();
    requestLogDb = openRequestLogDb(ctx.paths.dataDir, ctx.logger);
    const replay = new ReplayStore(ctx.paths.pluginDataDir);
    const buildClient = () => new GeminiClient({ apiKey: googleKey(ctx.config, config.googleProviderName || "Google"), baseUrl: config.interactionsBaseUrl });
    const send = (response, helpers, status, body) => helpers.sendJson(response, status, body);
    ctx.registerGatewayRoute({ key: "gemini-agent-health", method: "GET", path: "/plugins/gemini-agent/health", auth: "gateway", handler: async (_request, response, helpers) => send(response, helpers, 200, { ok: true, version: "0.2.0", models: MODELS }) });
    ctx.registerGatewayRoute({ key: "gemini-agent-cleanup", method: "POST", path: "/plugins/gemini-agent/cleanup", auth: "gateway", handler: async (_request, response, helpers) => send(response, helpers, 200, { deleted: replay.cleanup(30) }) });
    // CCR's gateway route API matches only method/path and has no handler
    // fallthrough. Do not register universal endpoints unless this CCR instance
    // is intentionally dedicated to Gemini.
    if (config.exclusiveGatewayRoutes !== true) {
      ctx.logger.warn("Gemini Agent Bridge did not register /v1 gateway overrides; set exclusiveGatewayRoutes: true only on a dedicated Gemini gateway.");
      ctx.logger.info("Gemini Agent Bridge loaded");
      return;
    }
    syncDesktopGatewayProfile(config.desktopProfilePath, ctx.logger);
    ctx.registerGatewayRoute({ key: "gemini-agent-models", method: "GET", path: "/v1/models", auth: "gateway", handler: async (_request, response, helpers) => send(response, helpers, 200, { object: "list", data: [
      { id: `GoogleAgent/${CLIENT_MODELS.primary}`, display_name: "Gemini 3.8 Flash (high reasoning)", description: "Pinned Gemini 3.8 Flash with high thinking", max_input_tokens: 1048576, max_tokens: 65536 },
      { id: `GoogleAgent/${CLIENT_MODELS.preview}`, display_name: "Gemini 3.1 Pro Preview (high reasoning)", description: "Pinned Gemini 3.1 Pro Preview with high thinking", max_input_tokens: 1048576, max_tokens: 65536 },
      { id: `GoogleAgent/${CLIENT_MODELS.helper}`, display_name: "Gemini 3.5 Flash-Lite (low reasoning)", description: "Pinned Gemini 3.5 Flash-Lite for lightweight helper work", max_input_tokens: 1048576, max_tokens: 65536 },
      { id: DESKTOP_MODELS.primary, display_name: "Gemini 3.8 Flash (high reasoning)", description: "Claude Desktop route to pinned Gemini 3.8 Flash", max_input_tokens: 1048576, max_tokens: 65536 },
      { id: DESKTOP_MODELS.preview, display_name: "Gemini 3.1 Pro Preview (high reasoning)", description: "Claude Desktop route to pinned Gemini 3.1 Pro Preview", max_input_tokens: 1048576, max_tokens: 65536 },
      { id: DESKTOP_MODELS.helper, display_name: "Gemini 3.5 Flash-Lite (low reasoning)", description: "Claude Desktop route to pinned Gemini 3.5 Flash-Lite", max_input_tokens: 1048576, max_tokens: 65536 }
    ].map((model) => ({ ...model, object: "model", created: 0, owned_by: "google" })) }) });
    ctx.registerGatewayRoute({ key: "gemini-agent-count", method: "POST", path: "/v1/messages/count_tokens", auth: "gateway", handler: async (request, response, helpers) => { const body = await helpers.readJson(request); return send(response, helpers, 200, { input_tokens: countRequestTokens(body) }); } });
    ctx.registerGatewayRoute({ key: "gemini-agent-messages", method: "POST", path: "/v1/messages", auth: "gateway", handler: async (request, response, helpers) => {
      const startedAt = Date.now();
      const requestId = randomUUID();
      let body;
      let resolvedModel = "unknown";
      try {
        body = await helpers.readJson(request);
        try { resolvedModel = normalizeModel(body.model); } catch {
          const error = { error: { type: "not_found_error", message: "This route is reserved for configured Gemini aliases." } };
          recordCcrRequest({ requestId, startedAt, client: String(request.headers["user-agent"] || "claude-client"), requestedModel: body.model || "", resolvedModel, stream: !!body.stream, status: 404, error: error.error.message }, ctx.logger);
          return send(response, helpers, 404, error);
        }
        const controller = new AbortController();
        // IncomingMessage emits "close" after a normal request body completes,
        // so using it here would abort slow native-tool work. "aborted" signals
        // a real client cancellation; the response close handler covers a client
        // disconnect that occurs while the response is still pending.
        request.on("aborted", () => controller.abort());
        response.on("close", () => { if (!response.writableEnded) controller.abort(); });
        const sessionKey = request.headers["x-claude-code-session-id"] || body.metadata?.user_id;
        const pending = executeAnthropicRequest({ body, client: buildClient(), replay, signal: controller.signal, sessionKey });
        if (body.stream) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          const heartbeat = setInterval(() => response.write(": ping\n\n"), 15000);
          try {
            const message = await pending;
            recordCcrRequest({ requestId, startedAt, client: String(request.headers["user-agent"] || "claude-client"), requestedModel: body.model, resolvedModel, stream: true, status: 200, response: message }, ctx.logger);
            sse(response, message);
          } finally { clearInterval(heartbeat); }
          return;
        }
        const message = await pending;
        recordCcrRequest({ requestId, startedAt, client: String(request.headers["user-agent"] || "claude-client"), requestedModel: body.model, resolvedModel, stream: false, status: 200, response: message }, ctx.logger);
        return send(response, helpers, 200, message);
      } catch (error) {
        recordCcrRequest({ requestId, startedAt, client: String(request.headers?.["user-agent"] || "claude-client"), requestedModel: body?.model || "", resolvedModel, stream: !!body?.stream, status: error.status || 500, error: error.message || "GoogleAgent failed" }, ctx.logger);
        if (response.headersSent) {
          sendSseError(response, error);
          return;
        }
        return send(response, helpers, error.status || 500, { type: "error", error: { type: error.type || "api_error", message: error.message || "GoogleAgent failed" } });
      }
    } });
    ctx.logger.info("Gemini Agent Bridge loaded");
  },
  stop() {
    closeRequestLogDb();
  },
  _test: { countRequestTokens, sendSseError, syncDesktopGatewayProfile }
};
