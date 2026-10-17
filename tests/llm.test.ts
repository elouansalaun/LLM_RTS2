import { describe, expect, it } from "vitest";
import { LMStudio, parseJSON } from "../src/llm/lmstudio";
import { MockLLM } from "../src/llm/mock";

const settings = {
  baseURL: "http://localhost:1234/v1",
  model: "qwen/qwen3.5-9b",
  temperature: 0.3,
  maxTokens: 800,
  timeoutSeconds: 10,
  contextLength: 16384,
};

function fakeFetch(message: Record<string, string | null>, seen: unknown[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  }) as unknown as typeof fetch;
}

const request = {
  system: "s",
  user: "u",
  schema: { type: "object", properties: { id: { type: "string", enum: ["a", "b"] } } },
  schemaName: "test",
};

describe("LM Studio client", () => {
  it("sends the JSON schema so decoding is constrained", async () => {
    const seen: Record<string, unknown>[] = [];
    await new LMStudio(settings, fakeFetch({ content: '{"id":"a"}' }, seen)).chat(request);
    expect(seen[0].model).toBe("qwen/qwen3.5-9b");
    expect(seen[0].response_format).toEqual({ type: "json_schema", json_schema: { name: "test", strict: true, schema: request.schema } });
  });

  it("reads the answer from reasoning_content when content is empty (Qwen 3.5 on MLX)", async () => {
    const r = await new LMStudio(settings, fakeFetch({ content: "", reasoning_content: '{"id":"b"}' })).chat(request);
    expect(r.json).toEqual({ id: "b" });
    expect(r.promptTokens).toBe(10);
  });

  it("finds the JSON object inside extra text", () => {
    expect(parseJSON('Sure! {"id": "a"} done')).toEqual({ id: "a" });
    expect(() => parseJSON("no json here")).toThrow(/not JSON/);
  });
});

describe("mock LLM", () => {
  it("answers with valid values taken from the schema", async () => {
    const mock = new MockLLM(["b"]);
    const r = await mock.chat(request);
    expect(r.json).toEqual({ id: "b" });
  });
});
