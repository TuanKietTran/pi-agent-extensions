import assert from "node:assert/strict";
import test from "node:test";

const loaderPath = "./pi-root.mjs";
const { createLoader } = await import(loaderPath);
const loader = await createLoader(import.meta.url);
const { modelLines }: typeof import("../right-panel.ts") = await loader.import("../right-panel.ts");

test("right panel shows the complete provider and model id across narrow widths", () => {
	const lines = modelLines({ provider: "openai-codex", id: "gpt-6-luna" }, 12);
	assert.equal(lines.join(""), "Model: openai-codex/gpt-6-luna");
	assert.ok(lines.every((line) => line.length <= 12));
});

test("right panel shows an unavailable model explicitly", () => {
	assert.deepEqual(modelLines(undefined, 24), ["Model: unavailable"]);
});
