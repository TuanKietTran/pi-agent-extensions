import test from "node:test";
import assert from "node:assert/strict";
import { contentToText, errorBody, parsePort, parsePositiveInt } from "../extensions/pi-odysseus-bridge.ts";

test("configuration parsing rejects invalid values", () => {
  assert.equal(parsePort("8788", 8787), 8788);
  assert.equal(parsePort("0", 8787), 8787);
  assert.equal(parsePort("65536", 8787), 8787);
  assert.equal(parsePositiveInt("2500", 100), 2500);
  assert.equal(parsePositiveInt("nope", 100), 100);
});

test("OpenAI error responses have the expected shape", () => {
  assert.deepEqual(errorBody("bad request", "invalid_request_error"), {
    error: { message: "bad request", type: "invalid_request_error", code: "invalid_request_error" },
  });
});

test("multimodal content becomes prompt text", () => {
  assert.equal(contentToText([
    { type: "text", text: "first" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
    { type: "input_text", text: "second" },
  ]), "first\nsecond");
});