import assert from "node:assert/strict";
import test from "node:test";
import { correctionMessage, parseRuns, renderTools, signature, type ToolDef } from "./protocol.ts";
import { CONTINUE_NOTE, SessionTracker, toolPreamble, type MuseMessage } from "./session.ts";

const read: ToolDef = {
  name: "read",
  description: "Read a file from disk. Supports offsets.",
  parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" } }, required: ["path"] },
};
const bash: ToolDef = {
  name: "bash",
  description: "Run a shell command",
  parameters: { type: "object", properties: { command: { type: "string" }, mode: { enum: ["a", "b"] }, args: { type: "array", items: { type: "string" } } }, required: ["command"] },
};
const tools = [read, bash];

test("signature marks optional args and renders enums and arrays", () => {
  assert.equal(signature(read), "read(path: string, offset?: number)");
  assert.equal(signature(bash), 'bash(command: string, mode?: "a"|"b", args?: string[])');
  assert.equal(signature({ name: "noop" }), "noop()");
});

test("renderTools uses the first sentence of the description", () => {
  assert.equal(renderTools([read]), "- read(path: string, offset?: number) - Read a file from disk.");
});

test("parseRuns captures a single @@RUN line", () => {
  const out = parseRuns('@@RUN {"name":"read","arguments":{"path":"/etc/hosts"}}', tools);
  assert.deepEqual(out.calls, [{ name: "read", arguments: { path: "/etc/hosts" } }]);
  assert.equal(out.text, "");
  assert.deepEqual(out.errors, []);
});

test("parseRuns keeps reasoning text and several calls in order, deduping repeats", () => {
  const text = [
    "I should look at two things first.",
    '@@RUN {"name":"read","arguments":{"path":"a.txt"}}',
    '@@RUN {"name":"bash","arguments":{"command":"ls"}}',
    '@@RUN {"name":"read","arguments":{"path":"a.txt"}}',
  ].join("\n");
  const out = parseRuns(text, tools);
  assert.equal(out.text, "I should look at two things first.");
  assert.deepEqual(out.calls.map((c) => c.name), ["read", "bash"]);
});

test("parseRuns handles braces and quotes inside strings", () => {
  const cmd = 'echo "}" && printf \'{\\"a\\":1}\'';
  const out = parseRuns(`@@RUN ${JSON.stringify({ name: "bash", arguments: { command: cmd } })} trailing`, tools);
  assert.equal((out.calls[0].arguments as { command: string }).command, cmd);
  assert.equal(out.text, "trailing");
});

test("parseRuns accepts the <run> block form", () => {
  const out = parseRuns('Checking.\n<run>{"name":"bash","arguments":{"command":"ls"}}</run>', tools);
  assert.equal(out.calls.length, 1);
  assert.equal(out.text, "Checking.");
});

test("parseRuns reports unknown tools, bad JSON and missing required args", () => {
  assert.match(parseRuns('@@RUN {"name":"nope","arguments":{}}', tools).errors[0], /unknown tool "nope"/);
  assert.match(parseRuns('@@RUN {"name":"read","arguments":{}}', tools).errors[0], /missing required argument\(s\): path/);
  assert.match(parseRuns('@@RUN {"name":"read",', tools).errors[0], /unterminated/);
  assert.match(parseRuns('@@RUN {"name":read}', tools).errors[0], /not valid JSON/);
  assert.match(parseRuns("@@RUN read /etc/hosts", tools).errors[0], /must be followed by a JSON object/);
});

test("plain prose has no calls and no errors", () => {
  const out = parseRuns("The first line is ##", tools);
  assert.deepEqual(out, { text: "The first line is ##", calls: [], errors: [] });
});

test("correctionMessage names the problems and the format", () => {
  const msg = correctionMessage(["unknown tool \"x\""]);
  assert.ok(msg.includes('unknown tool "x"') && msg.includes("@@RUN"));
});

test("fresh plan with tools carries the hands preamble and signatures", () => {
  const t = new SessionTracker();
  const plan = t.plan([{ role: "user", content: "read my hosts" }], "Be terse.", "", undefined, tools);
  assert.ok(plan.content.startsWith("I'm working on my own laptop"));
  assert.ok(plan.content.includes("read(path: string, offset?: number)"));
  assert.ok(plan.content.includes("@@RUN"));
  assert.ok(plan.content.includes("Be terse."));
  assert.ok(plan.content.endsWith("read my hosts"));
  assert.equal(toolPreamble(tools).includes("bash(command: string"), true);
});

test("delta with tool results sends OUTPUT blocks and the continue note", () => {
  const t = new SessionTracker();
  const first = t.plan([{ role: "user", content: "go" }], undefined, "", undefined, tools);
  t.commit(first);
  const messages: MuseMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
    { role: "toolResult", toolName: "read", content: "AAA" },
    { role: "toolResult", toolName: "bash", isError: true, content: "boom" },
  ];
  const next = t.plan(messages, undefined, "", undefined, tools);
  assert.equal(next.fresh, false);
  assert.equal(next.content, `OUTPUT (read, ok):\nAAA\n\nOUTPUT (bash, error):\nboom\n\n${CONTINUE_NOTE}`);
});

test("parallel tool results share the budget instead of dropping older ones", () => {
  const t = new SessionTracker({ maxChars: 3000, systemChars: 200 });
  t.commit(t.plan([{ role: "user", content: "go" }], undefined, "", undefined, tools));
  const big = "z".repeat(5000);
  const plan = t.plan(
    [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
      { role: "toolResult", toolName: "read", content: "A" + big },
      { role: "toolResult", toolName: "read", content: "B" + big },
    ],
    undefined, "", undefined, tools,
  );
  assert.ok(plan.content.length <= 3000);
  assert.ok(plan.content.includes("OUTPUT (read, ok):\nA") && plan.content.includes("OUTPUT (read, ok):\nB"));
});

test("a fresh resend renders earlier tool calls as @@RUN lines", () => {
  const t = new SessionTracker();
  const plan = t.plan(
    [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall", name: "read", arguments: { path: "a" } }] },
      { role: "toolResult", toolName: "read", content: "AAA" },
    ],
    undefined, "", undefined, tools,
  );
  assert.ok(plan.content.includes('Assistant: looking\n@@RUN {"name":"read","arguments":{"path":"a"}}'));
  assert.ok(plan.content.includes("OUTPUT (read, ok):\nAAA"));
  assert.ok(plan.content.endsWith(CONTINUE_NOTE));
});
