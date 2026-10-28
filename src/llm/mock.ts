import type { ChatRequest, ChatResult, LLM } from "./lmstudio";

/**
 * A stand-in for the LLM, for tests and dry runs without LM Studio. It answers
 * every request with a valid object built from the schema itself: the first
 * allowed value of every enum (the first non-zero one for numbers), preferring
 * the option ids listed in `prefer`.
 */
export class MockLLM implements LLM {
  readonly name = "mock";
  readonly requests: ChatRequest[] = [];

  constructor(private prefer: string[] = ["spawn_7", "expand", "build_city", "attack_"]) {}

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(request);
    const json = this.fill(request.schema);
    return { json, text: JSON.stringify(json), ms: 0, promptTokens: null, completionTokens: null };
  }

  private fill(schema: Record<string, unknown>): unknown {
    if (Array.isArray(schema.enum)) {
      const values = schema.enum as unknown[];
      for (const p of this.prefer) {
        const hit = values.find((v) => typeof v === "string" && v.startsWith(p));
        if (hit !== undefined) return hit;
      }
      // Numbers: the first non-zero value (0 usually means "none").
      return values.find((v) => typeof v === "number" && v !== 0) ?? values[0];
    }
    switch (schema.type) {
      case "object": {
        const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
        return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, this.fill(v)]));
      }
      case "array":
        return [this.fill(schema.items as Record<string, unknown>)];
      case "string":
        return "mock answer";
      case "integer":
      case "number":
        return 0;
      case "boolean":
        return false;
      default:
        return null;
    }
  }
}
