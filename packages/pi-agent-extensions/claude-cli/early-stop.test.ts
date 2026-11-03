import assert from "node:assert/strict";
import test from "node:test";
import { EarlyStop, HOST_TOOL_PREFIX } from "./early-stop.ts";

const start = { type: "message_start" };
const toolBlock = (name: string) => ({ type: "content_block_start", content_block: { type: "tool_use", name } });
const stop = { type: "message_stop" };

test("stops once the message is complete and every announced host call is captured", () => {
  const s = new EarlyStop();
  s.observe(start);
  s.observe(toolBlock(`${HOST_TOOL_PREFIX}read`));
  s.observe(toolBlock(`${HOST_TOOL_PREFIX}bash`));
  s.captureOne();
  s.observe(stop);
  assert.equal(s.shouldStop(), false, "one of two calls still missing");
  s.captureOne();
  assert.equal(s.shouldStop(), true);
  assert.equal(s.shouldStop(), false, "reports the stop only once");
});

test("a capture that arrives before the message ends does not stop early", () => {
  const s = new EarlyStop();
  s.observe(start);
  s.observe(toolBlock(`${HOST_TOOL_PREFIX}read`));
  s.captureOne();
  assert.equal(s.shouldStop(), false);
  s.observe(stop);
  assert.equal(s.shouldStop(), true);
});

test("a plain text or structured-output message never stops the process", () => {
  const s = new EarlyStop();
  s.observe(start);
  s.observe({ type: "content_block_start", content_block: { type: "text" } });
  s.observe(toolBlock("StructuredOutput"));
  s.observe(stop);
  assert.equal(s.shouldStop(), false);
});

test("ignores garbage events", () => {
  const s = new EarlyStop();
  s.observe(undefined);
  s.observe({});
  assert.equal(s.shouldStop(), false);
});
