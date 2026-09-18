"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const bridge = require("../index.cjs");

function makeContext(config = {}) {
  const routes = [];
  const messages = [];
  const root = mkdtempSync(join(tmpdir(), "gemini-agent-index-"));
  return {
    routes,
    messages,
    ctx: {
      config: { Providers: [] },
      pluginConfig: config,
      paths: { dataDir: root, pluginDataDir: root },
      logger: { info: (message) => messages.push(["info", message]), warn: (message) => messages.push(["warn", message]) },
      registerGatewayRoute: (route) => routes.push(route)
    }
  };
}

function jsonHelpers(body) {
  return {
    readJson: async () => body,
    sendJson: (_response, status, value) => ({ status, value })
  };
}

test("does not claim universal CCR endpoints unless explicitly dedicated", async () => {
  const normal = makeContext();
  await bridge.setup(normal.ctx);
  assert.deepEqual(normal.routes.map((route) => route.path), ["/plugins/gemini-agent/health", "/plugins/gemini-agent/cleanup"]);
  assert.match(normal.messages.find(([level]) => level === "warn")[1], /exclusiveGatewayRoutes/);

  const dedicated = makeContext({ exclusiveGatewayRoutes: true });
  await bridge.setup(dedicated.ctx);
  assert.deepEqual(dedicated.routes.map((route) => route.path), [
    "/plugins/gemini-agent/health", "/plugins/gemini-agent/cleanup", "/v1/models", "/v1/messages/count_tokens", "/v1/messages"
  ]);
  bridge.stop();
});

test("count_tokens includes both system and messages", async () => {
  const fixture = makeContext({ exclusiveGatewayRoutes: true });
  await bridge.setup(fixture.ctx);
  const route = fixture.routes.find((candidate) => candidate.path === "/v1/messages/count_tokens");
  const body = { system: "system instructions", messages: [{ role: "user", content: "hello" }] };
  const result = await route.handler({}, {}, jsonHelpers(body));
  const expected = Math.ceil((JSON.stringify(body.system) + JSON.stringify(body.messages)).length / 4);
  assert.equal(result.status, 200);
  assert.equal(result.value.input_tokens, expected);
  bridge.stop();
});

test("health reports the replay-correlation patch version", async () => {
  const fixture = makeContext();
  await bridge.setup(fixture.ctx);
  const route = fixture.routes.find((candidate) => candidate.path === "/plugins/gemini-agent/health");
  const result = await route.handler({}, {}, jsonHelpers({}));
  assert.equal(result.status, 200);
  assert.equal(result.value.version, "0.2.4");
  bridge.stop();
});

test("SSE errors are emitted and closed after headers have been sent", () => {
  const response = new EventEmitter();
  let output = "";
  response.writableEnded = false;
  response.write = (chunk) => { output += chunk; };
  response.end = () => { response.writableEnded = true; };
  bridge._test.sendSseError(response, Object.assign(new Error("upstream failed"), { type: "api_error" }));
  assert.match(output, /^event: error/m);
  assert.match(output, /upstream failed/);
  assert.doesNotMatch(output, /event: message_stop/);
  assert.equal(response.writableEnded, true);
});

test("entry reload clears the lib module cache before loading index", () => {
  const entryPath = require.resolve("../entry.cjs");
  const libPath = require.resolve("../lib.cjs");
  require(libPath);
  require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { stale: true } };
  delete require.cache[entryPath];
  const reloaded = require(entryPath);
  assert.equal(typeof reloaded.setup, "function");
  assert.equal(typeof require.cache[libPath].exports.GeminiClient, "function");
  assert.equal(require.cache[libPath].exports.stale, undefined);
});

test("returns 404 with Anthropic error envelope for unmapped models", async () => {
  const fixture = makeContext({ exclusiveGatewayRoutes: true });
  await bridge.setup(fixture.ctx);
  const route = fixture.routes.find((candidate) => candidate.path === "/v1/messages");
  const request = { headers: {} };
  const response = new EventEmitter();
  const body = { model: "unknown-model", messages: [{ role: "user", content: "hi" }] };
  const result = await route.handler(request, response, jsonHelpers(body));
  assert.equal(result.status, 404);
  assert.equal(result.value.type, "error");
  assert.equal(result.value.error.type, "not_found_error");
  bridge.stop();
});
