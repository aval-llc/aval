"use strict";
 

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  ANSWER_SCHEMA,
  JsonLineRpc,
  CodexAppServerService,
  answerFromText,
  assertAnswerUsesSuppliedNumbers,
  publicAccount,
  resolveCodexExecutable,
  validateAuthUrl,
} = require("../codex-app-server.cjs");

test("JSON-line RPC frames partial and multiple responses", async () => {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const rpc = new JsonLineRpc(readable, writable, { timeoutMs: 500 });
  const first = rpc.request("one", {});
  const second = rpc.request("two", {});
  readable.write('{"id":1,"result":{"ok":');
  readable.write('true}}\n{"id":2,"result":42}\n');
  assert.deepEqual(await first, { ok: true });
  assert.equal(await second, 42);
  rpc.close();
});

test("JSON-line RPC rejects pending work when the process closes", async () => {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const rpc = new JsonLineRpc(readable, writable, { timeoutMs: 5_000 });
  const request = rpc.request("wait", {});
  readable.end();
  await assert.rejects(request, /closed/i);
});

test("login URL allowlist accepts only OpenAI-owned HTTPS hosts", () => {
  assert.ok(validateAuthUrl("https://auth.openai.com/oauth/authorize"));
  assert.ok(validateAuthUrl("https://chatgpt.com/auth/login"));
  assert.equal(validateAuthUrl("http://chatgpt.com/auth/login"), null);
  assert.equal(validateAuthUrl("https://chatgpt.com.evil.example/login"), null);
  assert.equal(validateAuthUrl("javascript:alert(1)"), null);
});

test("renderer account shape cannot contain credentials", () => {
  const account = publicAccount({ type: "chatgpt", email: "owner@example.com", planType: "plus", accessToken: "never-render" });
  assert.deepEqual(account, { type: "chatgpt", email: "owner@example.com", planType: "plus" });
  assert.equal(JSON.stringify(account).includes("never-render"), false);
});

test("structured answers are validated and normalized", () => {
  const answer = answerFromText('```json\n{"headline":"Occupancy is steady","narrative":"No change is visible.","confidence":"high"}\n```');
  assert.deepEqual(answer.metrics, []);
  assert.throws(() => answerFromText('{"headline":7,"narrative":"x"}'), /incomplete/i);
});

test("desktop output schema satisfies strict output requirements at every object", () => {
  function visit(schema) {
    if (schema.properties) {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(visit);
    }
    if (schema.items) visit(schema.items);
  }
  visit(ANSWER_SCHEMA);
});

test("nullable fields are omitted for the renderer without dropping zero deltas", () => {
  const answer = answerFromText(JSON.stringify({ headline: "Verified", narrative: "Supplied records.",
    metrics: [{ label: "Count", value: 8, unit: "count", delta: null }, { label: "Other", value: 6, unit: "count", delta: 0 }],
    evidence: null, chart: { metric: null, title: null, points: [] }, action: null, confidence: "high" }));
  assert.equal(Object.hasOwn(answer.metrics[0], "delta"), false);
  assert.equal(answer.metrics[1].delta, 0);
  assert.equal(Object.hasOwn(answer, "evidence"), false);
  assert.equal(Object.hasOwn(answer, "action"), false);
  assert.deepEqual(answer.chart, { points: [] });
});

test("answers with unsupported figures fail closed", () => {
  const verified = { headline: "Occupancy", narrative: "Occupancy is 94%.", metrics: [{ label: "Occupancy", value: 94, unit: "percent" }], confidence: "high" };
  assert.equal(assertAnswerUsesSuppliedNumbers(verified, { occupancy: 94 }), verified);
  assert.throws(
    () => assertAnswerUsesSuppliedNumbers({ ...verified, narrative: "Occupancy is 87%." }, { occupancy: 94 }),
    /not in Aval's verified facts/i,
  );
});

test("Codex executable resolution checks explicit paths without a shell", () => {
  const checked = [];
  const resolved = resolveCodexExecutable({
    env: { AVAL_CODEX_PATH: "/opt/aval/codex", PATH: "/bin" },
    platform: "darwin",
    home: "/Users/test",
    accessSync(candidate) {
      checked.push(candidate);
      if (candidate !== "/opt/aval/codex") throw new Error("missing");
    },
  });
  assert.equal(resolved, "/opt/aval/codex");
  assert.deepEqual(checked, ["/opt/aval/codex"]);
});

test("service handles real completion envelopes after the start acknowledgement", { timeout: 3000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "aval-service-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  let spawnOptions;
  let openedUrl = null;
  const requests = [];
  const responses = [];
  let completionStatus = "completed";
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit("exit", 0, null); };
  let inputBuffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    inputBuffer += String(chunk);
    while (inputBuffer.includes("\n")) {
      const newline = inputBuffer.indexOf("\n");
      const line = inputBuffer.slice(0, newline);
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (!message.id) continue;
      if (!message.method) { responses.push(message); continue; }
      requests.push(message);
      let result = {};
      if (message.method === "initialize") result = { userAgent: "fake" };
      if (message.method === "account/read") result = { account: { type: "chatgpt", email: "owner@example.com", planType: "plus", accessToken: "hidden" }, requiresOpenaiAuth: true };
      if (message.method === "model/list") result = { data: [{ model: "gpt-test", displayName: "GPT Test", hidden: false, isDefault: true }], nextCursor: null };
      if (message.method === "account/rateLimits/read") result = { rateLimits: { primary: null, secondary: null, rateLimitReachedType: null, spendControlReached: false } };
      if (message.method === "account/login/start") result = { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/oauth/authorize" };
      if (message.method === "thread/start") result = { thread: { id: "thread-1" } };
      if (message.method === "turn/start") result = { turn: { id: "turn-1" } };
      if (message.method === "turn/start") {
        // A delayed cancellation from the previous turn arrives before this ack.
        child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "old-turn", status: "interrupted" } } })}\n`);
      }
      child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      if (message.method === "turn/start") {
        // Real notifications arrive after the turn/start response has set the
        // active turn ID. A microtask here incorrectly hid completion matching bugs.
        setImmediate(() => {
          child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "previous-turn", status: "failed", items: [], error: { message: "Stale turn must be ignored" } } } })}\n`);
          child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: '{"headline":"Verified","narrative":"The supplied facts support this.","metrics":[],"confidence":"high"}' } })}\n`);
          child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "unrelated-turn", status: "failed", error: { message: "Wrong turn" } } } })}\n`);
          child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: completionStatus, items: [], error: completionStatus === "failed" ? { message: "Invalid output schema" } : null } } })}\n`);
        });
      }
    }
  });

  const service = new CodexAppServerService({
    userDataDir: temporary,
    env: { PATH: "/fake", OPENAI_API_KEY: "must-not-leak" },
    spawnImpl(_command, _args, options) { spawnOptions = options; return child; },
    openExternal: async (url) => { openedUrl = url; },
  });
  t.after(() => service.stop());
  // The fake executable resolver needs one explicit path it can stat. This
  // test uses the current Node binary as a harmless executable placeholder;
  // spawnImpl above prevents it from actually launching.
  service.env.AVAL_CODEX_PATH = process.execPath;
  await service.start();
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.env.OPENAI_API_KEY, undefined);
  assert.equal(spawnOptions.env.CODEX_HOME, path.join(temporary, "codex-home"));
  assert.deepEqual(service.getState().account, { type: "chatgpt", email: "owner@example.com", planType: "plus" });
  await service.connect();
  assert.equal(openedUrl, "https://auth.openai.com/oauth/authorize");
  assert.deepEqual(requests.find((message) => message.method === "account/login/start")?.params, {
    type: "chatgpt",
    useHostedLoginSuccessPage: true,
    appBrand: "chatgpt",
  });
  assert.equal(JSON.stringify(service.getState()).includes("oauth/authorize"), false);
  const activated = new Promise((resolve) => {
    const onEvent = (event) => {
      if (event.type === "state" && event.state.active) {
        service.off("event", onEvent);
        resolve();
      }
    };
    service.on("event", onEvent);
  });
  child.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } })}\n`);
  await activated;
  assert.equal(service.getState().active, true);
  await assert.rejects(() => service.ask({question:'x'.repeat(601)}), /too long/);
  await assert.rejects(() => service.ask({question:'Review',context:{text:'x'.repeat(48000)}}), /too large/);
  assert.equal(requests.filter(r=>r.method==='turn/start').length,0);
  for (const [index,method] of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','mcpServer/elicitation/request','item/tool/call','unregistered/capability'].entries()) {
    child.stdout.write(`${JSON.stringify({id:`probe-${index}`,method,params:{path:'/outside-workspace/probe',url:'https://example.invalid'}})}\n`);
  }
  assert.equal(responses.find(r=>r.id==='probe-0').result.decision,'decline');
  assert.equal(responses.find(r=>r.id==='probe-1').result.decision,'decline');
  assert.equal(responses.find(r=>r.id==='probe-2').result.action,'decline');
  assert.equal(responses.find(r=>r.id==='probe-3').result.success,false);
  assert.equal(responses.find(r=>r.id==='probe-4').error.code,-32601);
  const answer = await service.ask({ conversationId: "test", question: "What changed?", locale: "en", context: { facts: { occupancy: 94 } } });
  assert.equal(answer.headline, "Verified");
  await t.test("failed turns report the provider error immediately", async () => {
    completionStatus = "failed";
    await assert.rejects(service.ask({ conversationId: "test", question: "Retry" }), /Invalid output schema/);
    assert.equal(service.activeTurns.size, 0);
  });
  await t.test("interrupted turns settle without waiting for timeout", async () => {
    completionStatus = "interrupted";
    await assert.rejects(service.ask({ conversationId: "test", question: "Retry" }), /cancelled/);
    assert.equal(service.activeTurns.size, 0);
  });
  assert.equal(requests.find(r=>r.method==='thread/start').params.ephemeral,true);
  assert.deepEqual(requests.find(r=>r.method==='turn/start').params.sandboxPolicy,{type:'readOnly',networkAccess:false});
  await t.test("a new question survives late cancellation events", async () => {
    completionStatus = "completed";
    assert.equal((await service.ask({ conversationId: "test", question: "Ask after cancellation" })).headline, "Verified");
  });
  await t.test("cancelling before acknowledgement interrupts the turn when its ID arrives", async () => {
    let acknowledge;
    const interrupts = [];
    const mockRequest = t.mock.method(service.rpc, "request", (method, params) => {
      if (method === "turn/start") return new Promise(resolve => { acknowledge = resolve; });
      if (method === "turn/interrupt") interrupts.push(params);
      return Promise.resolve({});
    });
    try {
      const answer = service.ask({ conversationId: "test", question: "Cancel immediately" });
      const cancelled = assert.rejects(answer, /cancelled/);
      await service.cancelTurn({ conversationId: "test" });
      await cancelled;
      acknowledge({ turn: { id: "late-start" } });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(interrupts, [{ threadId: "thread-1", turnId: "late-start" }]);
      assert.equal(service.activeTurns.size, 0);
    } finally { mockRequest.mock.restore(); }
  });
  t.mock.timers.enable({apis:['setTimeout']});
  // Direct RPC probes use an unresponsive pipe so no model or credentials are involved.
  const stalled=new JsonLineRpc(new PassThrough(),new PassThrough(),{timeoutMs:30});
  const pending=stalled.request('probe',{});const rejected=assert.rejects(pending,/timed out/i);
  t.mock.timers.tick(31);await rejected;stalled.close();
  t.mock.method(service.rpc,'request',async(method)=>method==='turn/start'?{turn:{id:'stalled-turn'}}:{});
  const unanswered=service.ask({conversationId:'test',question:'Inspect again',context:{}});
  const turnExpired=assert.rejects(unanswered,/too long|cancelled/i);
  await assert.rejects(()=>service.ask({conversationId:'test',question:'Duplicate'}),/already answering/);
  t.mock.timers.tick(120001);await turnExpired;
  assert.equal(service.activeTurns.size,0);
  t.mock.timers.reset();
  service.stop();
});

// Seeding runs at the top of startup, before any RPC. A stub whose stdout is
// already closed makes initialize reject, which start() handles as a normal
// startup failure -- so the import is exercised without a real Codex process.
function startWithoutCodex(temporary, sharedHome, preferences) {
  if (preferences) {
    fs.writeFileSync(path.join(temporary, "desktop-state.json"), JSON.stringify(preferences));
  }
  const service = new CodexAppServerService({
    userDataDir: temporary,
    env: { PATH: path.join(temporary, "no-such-bin"), CODEX_HOME: sharedHome },
    spawnImpl() {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => { child.killed = true; };
      child.stdout.end();
      return child;
    },
  });
  service.env.AVAL_CODEX_PATH = process.execPath;
  return service;
}

function makeSharedLogin(root, body) {
  const sharedHome = path.join(root, "shared-codex");
  fs.mkdirSync(sharedHome, { recursive: true });
  fs.writeFileSync(path.join(sharedHome, "auth.json"), body, { mode: 0o600 });
  return sharedHome;
}

test("an existing Codex login is adopted into the isolated home", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "aval-seed-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sharedHome = makeSharedLogin(temporary, '{"tokens":{"refresh_token":"shared"}}');

  const service = startWithoutCodex(temporary, sharedHome);
  await service.start();

  const imported = path.join(temporary, "codex-home", "auth.json");
  assert.equal(fs.readFileSync(imported, "utf8"), '{"tokens":{"refresh_token":"shared"}}');
  // Windows does not expose POSIX permission bits; Unix packaging must retain
  // owner-only access for the copied credential.
  if (process.platform !== "win32") assert.equal(fs.statSync(imported).mode & 0o777, 0o600);
  assert.ok(service.diagnostics.some((entry) => entry.kind === "shared_login_imported"));
  // Credentials must never reach the renderer-visible state.
  assert.equal(JSON.stringify(service.getState()).includes("shared"), false);
});

test("an in-app login is never overwritten by the shared Codex file", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "aval-seed-keep-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sharedHome = makeSharedLogin(temporary, '{"tokens":{"refresh_token":"shared"}}');
  fs.mkdirSync(path.join(temporary, "codex-home"), { recursive: true });
  fs.writeFileSync(path.join(temporary, "codex-home", "auth.json"), '{"tokens":{"refresh_token":"in-app"}}');

  const service = startWithoutCodex(temporary, sharedHome);
  await service.start();

  assert.equal(
    fs.readFileSync(path.join(temporary, "codex-home", "auth.json"), "utf8"),
    '{"tokens":{"refresh_token":"in-app"}}',
  );
});

test("signing out opts out of re-adopting the shared Codex login", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "aval-seed-optout-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sharedHome = makeSharedLogin(temporary, '{"tokens":{"refresh_token":"shared"}}');

  const service = startWithoutCodex(temporary, sharedHome, { ignoreSharedAuth: true, disabled: true });
  await service.start();

  assert.equal(fs.existsSync(path.join(temporary, "codex-home", "auth.json")), false);
});

test("a missing shared login is not reported as a failure", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "aval-seed-absent-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  const service = startWithoutCodex(temporary, path.join(temporary, "absent-codex"));
  await service.start();

  assert.equal(fs.existsSync(path.join(temporary, "codex-home", "auth.json")), false);
  assert.equal(service.diagnostics.some((entry) => entry.kind === "shared_login_skipped"), false);
});
