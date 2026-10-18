/**
 * Checks the LM Studio setup with one small structured request:
 * npm run check-llm -- [--model <id>]
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../engine/game";
import { LMStudio } from "../llm/lmstudio";
import { LLMSettingsSchema } from "../match";

const { values: args } = parseArgs({ options: { model: { type: "string" } } });
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "config/match.json"), "utf8"));
const settings = LLMSettingsSchema.parse({ ...raw.llm, ...(args.model ? { model: args.model } : {}) });
const lms = new LMStudio(settings);

const ready = await lms.ensureReady((line) => console.log(line));
console.log(`LM Studio OK: ${settings.model} is ${ready.state}${ready.contextLength ? ` (context ${ready.contextLength} tokens)` : ""}`);

const r = await lms.chat({
  system: "You play a strategy game. Answer with JSON only.",
  user: "You border unclaimed land and a weak tribe. Pick one option: expand, attack_tribe, wait.",
  schema: {
    type: "object",
    properties: { reason: { type: "string" }, id: { type: "string", enum: ["expand", "attack_tribe", "wait"] } },
    required: ["reason", "id"],
    additionalProperties: false,
  },
  schemaName: "check",
  maxTokens: 200,
});
console.log(`answer in ${(r.ms / 1000).toFixed(1)} s (${r.promptTokens} prompt + ${r.completionTokens} completion tokens):`, r.json);
