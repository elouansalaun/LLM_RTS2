import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ChatRequest {
  system: string;
  user: string;
  /** JSON schema the answer must follow (LM Studio enforces it while decoding). */
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens?: number;
}

export interface ChatResult {
  json: unknown;
  /** The raw text the model produced. */
  text: string;
  ms: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Anything that can answer a chat request with JSON: LM Studio, or a mock in tests. */
export interface LLM {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResult>;
}

export interface LMStudioOptions {
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  /** Context length to use when we load the model ourselves (see ensureReady). */
  contextLength: number;
}

/**
 * LM Studio's local server speaks the OpenAI chat-completions protocol.
 * With `response_format: json_schema`, it constrains decoding to the schema:
 * the model cannot produce an action id that is not on the menu.
 */
export class LMStudio implements LLM {
  readonly name: string;

  constructor(
    readonly options: LMStudioOptions,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.name = options.model;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const body = {
      model: this.options.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      temperature: this.options.temperature,
      max_tokens: request.maxTokens ?? this.options.maxTokens,
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, strict: true, schema: request.schema },
      },
    };
    const start = performance.now();
    const res = await this.fetchImpl(`${this.options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutSeconds * 1000),
    });
    if (!res.ok) throw new Error(`LM Studio HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = data.choices?.[0]?.message;
    // Qwen 3.5 on LM Studio's MLX engine puts the schema-constrained answer in
    // reasoning_content and leaves content empty, so I check both. Turning
    // thinking off (enable_thinking: false) did nothing through this API.
    const content = message?.content ?? "";
    const text = content.trim() !== "" ? content : (message?.reasoning_content ?? "");
    return {
      json: parseJSON(text),
      text,
      ms: Math.round(performance.now() - start),
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
    };
  }

  /**
   * Checks that the server runs and the model is downloaded, and loads it
   * with a large enough context if it is not loaded yet. If I let LM Studio
   * load it just in time, it picks a 4,096-token context, too small for the
   * strategist's prompt.
   */
  async ensureReady(log: (line: string) => void = () => {}): Promise<{ state: string; contextLength: number | null }> {
    const root = this.options.baseURL.replace(/\/v1\/?$/, "");
    let models: { id: string; state?: string; loaded_context_length?: number }[];
    try {
      const res = await this.fetchImpl(`${root}/api/v0/models`, { signal: AbortSignal.timeout(5000) });
      models = ((await res.json()) as { data: typeof models }).data;
    } catch {
      throw new Error(`LM Studio is not reachable at ${root}. Start its server (Developer tab, or \`lms server start\`).`);
    }
    const model = models.find((m) => m.id === this.options.model);
    if (model === undefined) {
      throw new Error(
        `model "${this.options.model}" is not downloaded in LM Studio. Available: ${models.map((m) => m.id).join(", ")}`,
      );
    }
    if (model.state === "loaded") return { state: "loaded", contextLength: model.loaded_context_length ?? null };
    const lms = process.env.LMS_PATH ?? path.join(os.homedir(), ".lmstudio/bin/lms");
    if (!fs.existsSync(lms)) {
      log(`${this.options.model} is not loaded; LM Studio will load it on the first request (small default context).`);
      return { state: "not-loaded", contextLength: null };
    }
    log(`loading ${this.options.model} in LM Studio (context ${this.options.contextLength} tokens)…`);
    const r = spawnSync(
      lms,
      ["load", this.options.model, "-c", String(this.options.contextLength), "--parallel", "1", "--identifier", this.options.model, "-y"],
      { encoding: "utf8", timeout: 10 * 60_000 },
    );
    if (r.status !== 0) throw new Error(`lms load failed: ${(r.stderr || r.stdout || String(r.error)).slice(-300)}`);
    return { state: "loaded", contextLength: this.options.contextLength };
  }
}

/** The model's answer as JSON: the whole text, or the first {...} block in it. */
export function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new Error(`the model's answer is not JSON: ${text.slice(0, 200)}`);
  }
}
