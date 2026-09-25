import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { callOpenAiCompatible } from "../lib/ask-aval/openai-compatible.ts";

test("OpenAI commercial default uses GPT-6 Sol", () => {
  const catalog = readFileSync(new URL("../lib/integrations/catalog.ts", import.meta.url), "utf8");
  const models = readFileSync(new URL("../lib/integrations/model-providers.ts", import.meta.url), "utf8");
  assert.match(catalog, /id: "openai"[\s\S]*?defaultModel: "gpt-6-sol"/);
  assert.match(models, /openai: \["gpt-6-sol", "gpt-6-luna"/);
  assert.match(models, /gpt-6-\(astra\|sol\|luna\)/);
});

for (const model of ["gpt-6-sol", "gpt-6-luna"]) {
  test(`${model} tool calls use the Chat Completions compatible reasoning mode`, async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        id: "response_1",
        choices: [{
          message: { content: null, tool_calls: [{ id: "call_1", function: { name: "render_answer", arguments: '{"headline":"Ready"}' } }] },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
    };
    try {
      const response = await callOpenAiCompatible(
        { baseUrl: "https://api.openai.com/v1", apiKey: "test-only", model, providerLabel: "OpenAI" },
        {
          system: "Use the offered tool.",
          messages: [{ role: "user", content: "Answer" }],
          tools: [{ name: "render_answer", description: "Finish", input_schema: { type: "object", properties: { headline: { type: "string" } }, required: ["headline"] } }],
          tool_choice: { type: "tool", name: "render_answer" },
          reasoningEffort: "medium",
        },
      );
      assert.equal(requestBody?.model, model);
      assert.equal(requestBody?.reasoning_effort, "none");
      assert.equal(response.content[0]?.type, "tool_use");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
