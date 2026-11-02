import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionTracker, clip, conversationKey, newSessionId, NO_TOOLS_NOTE, type MuseMessage } from "./session.ts";
import { errorMessageFromBody, loadConfig } from "./config.ts";

const user = (text: string): MuseMessage => ({ role: "user", content: text });
const assistant = (text: string): MuseMessage => ({ role: "assistant", content: [{ type: "text", text }] });

test("fresh session sends system note, system prompt and the message", () => {
  const t = new SessionTracker();
  const plan = t.plan([user("hello")], "You are a coding agent.");
  assert.equal(plan.fresh, true);
  assert.match(plan.sessionId, /^pi-[0-9a-f]{12}$/);
  assert.ok(plan.content.includes(NO_TOOLS_NOTE));
  assert.ok(plan.content.includes("You are a coding agent."));
  assert.ok(plan.content.endsWith("hello"));
});

test("later turns send only the new user message, same session id", () => {
  const t = new SessionTracker();
  const first = t.plan([user("one")], "sys");
  t.commit(first);
  const second = t.plan([user("one"), assistant("reply one"), user("two")], "sys");
  assert.equal(second.fresh, false);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.content, "two");
  assert.ok(!second.content.includes("reply one"));
});

test("an uncommitted (failed) turn is planned fresh again", () => {
  const t = new SessionTracker();
  const first = t.plan([user("one")], undefined);
  const retry = t.plan([user("one")], undefined);
  assert.equal(retry.fresh, true);
  assert.notEqual(retry.sessionId, first.sessionId);
});

test("a rewound conversation starts a new Muse session and resends history", () => {
  const t = new SessionTracker();
  const long = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")];
  t.commit(t.plan(long, undefined));
  const rewound = t.plan([user("a"), assistant("b"), user("c2")], undefined);
  assert.equal(rewound.fresh, true);
  assert.ok(rewound.content.includes("Assistant: b"));
  assert.ok(rewound.content.endsWith("c2"));
});

test("different first messages are different conversations", () => {
  assert.notEqual(conversationKey([user("x")]), conversationKey([user("y")]));
  assert.notEqual(conversationKey([user("x")], "/a"), conversationKey([user("x")], "/b"));
});

test("content never exceeds maxChars and keeps the newest message", () => {
  const t = new SessionTracker({ maxChars: 2000, systemChars: 300 });
  const big = "x".repeat(5000);
  const plan = t.plan([user("first " + big), assistant(big), user("LATEST " + big)], "S".repeat(9000));
  assert.ok(plan.content.length <= 2000);
  assert.ok(plan.content.includes("LATEST"));
});

test("oldest history is dropped first and marked", () => {
  const t = new SessionTracker({ maxChars: 600, systemChars: 100 });
  const msgs: MuseMessage[] = [];
  for (let i = 0; i < 10; i++) { msgs.push(user(`question ${i} ${"q".repeat(120)}`)); msgs.push(assistant(`answer ${i} ${"a".repeat(120)}`)); }
  msgs.push(user("final"));
  const plan = t.plan(msgs, undefined);
  assert.ok(plan.content.length <= 600);
  assert.ok(plan.content.includes("[earlier messages omitted]"));
  assert.ok(plan.content.endsWith("final"));
  assert.ok(!plan.content.includes("question 0"));
});

test("clip keeps head and tail", () => {
  const out = clip("A".repeat(100) + "Z".repeat(100), 60);
  assert.equal(out.length, 60);
  assert.ok(out.startsWith("A") && out.endsWith("Z"));
});

test("tool results are labelled", () => {
  const t = new SessionTracker();
  const first = t.plan([user("go")], undefined);
  t.commit(first);
  const next = t.plan([user("go"), assistant("calling"), { role: "toolResult", toolName: "read", content: "file text" }], undefined);
  assert.equal(next.content, "OUTPUT (read, ok):\nfile text");
});

test("newSessionId matches the proxy's allowed alphabet", () => {
  for (let i = 0; i < 50; i++) assert.match(newSessionId(), /^[A-Za-z0-9-]{1,64}$/);
});

test("loadConfig: env beats file, key required, trailing slash trimmed", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-cfg-"));
  try {
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ baseUrl: "http://file:1/v1/", apiKey: "filekey" }));
    assert.deepEqual(loadConfig({}, file), { baseUrl: "http://file:1/v1", apiKey: "filekey", maxChars: 15000 });
    assert.equal(loadConfig({ PI_MUSE_PROXY_KEY: "envkey", PI_MUSE_PROXY_URL: "http://env:2/v1" }, file).apiKey, "envkey");
    assert.equal(loadConfig({ PI_MUSE_PROXY_MAX_CHARS: "50000" }, file).maxChars, 50000);
    assert.throws(() => loadConfig({}, join(dir, "missing.json")), /no API key/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("errorMessageFromBody surfaces the proxy's message", () => {
  assert.equal(
    errorMessageFromBody(400, '{"message":"Client-supplied tools are not supported.","type":"invalid_request_error"}'),
    "muse-proxy 400: Client-supplied tools are not supported.",
  );
  assert.match(errorMessageFromBody(502, "<html>bad</html>"), /^muse-proxy 502: <html>/);
});
