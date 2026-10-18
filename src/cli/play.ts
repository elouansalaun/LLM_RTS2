/**
 * Plays one match: npm run play -- [options]
 *
 *   --config <file>     match settings (default config/match.json)
 *   --seed <text>       game seed (same seed = same map setup and AI behaviour)
 *   --minutes <n>       stop after n minutes of game time
 *   --model <id>        LM Studio model id (default qwen/qwen3.5-9b)
 *   --size Compact|Normal, --bots <n>, --difficulty Easy|Medium|Hard|Impossible
 *   --mock              no LLM: a stand-in picks the first valid options (pipeline test)
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../engine/game";
import { LMStudio, LLM } from "../llm/lmstudio";
import { MockLLM } from "../llm/mock";
import { MatchConfigSchema, playMatch } from "../match";

const { values: args } = parseArgs({
  options: {
    config: { type: "string", default: path.join(ROOT, "config/match.json") },
    seed: { type: "string" },
    minutes: { type: "string" },
    model: { type: "string" },
    size: { type: "string" },
    bots: { type: "string" },
    difficulty: { type: "string" },
    out: { type: "string" },
    mock: { type: "boolean", default: false },
  },
});

const raw = JSON.parse(fs.readFileSync(args.config!, "utf8"));
if (args.seed) raw.game.seed = args.seed;
if (args.size) raw.game.mapSize = args.size;
if (args.bots) raw.game.bots = Number(args.bots);
if (args.difficulty) raw.game.difficulty = args.difficulty;
if (args.minutes) raw.maxMinutes = Number(args.minutes);
if (args.model) raw.llm.model = args.model;
const config = MatchConfigSchema.parse(raw);

let llm: LLM;
if (args.mock) {
  llm = new MockLLM();
} else {
  const lms = new LMStudio(config.llm);
  await lms.ensureReady((line) => console.log(line));
  llm = lms;
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
const outDir = args.out ?? path.join(ROOT, "runs", `${stamp}-${config.game.seed}${args.mock ? "-mock" : ""}`);
console.log(`${llm.name} plays ${config.game.map} (${config.game.mapSize}) against the nations and ${config.game.bots} tribes, seed "${config.game.seed}", up to ${config.maxMinutes} min.`);
console.log(`Writing to ${path.relative(process.cwd(), outDir)}\n`);

const result = await playMatch(config, llm, { outDir, log: (line) => console.log(line) });
console.log(
  `\n${result.outcome.toUpperCase()} after ${Math.round(result.seconds / 60)} min: ${result.me.landPct}% of the land, ` +
    `rank ${result.rank}/${result.players}. ${result.llm.calls} LLM calls, ${(result.llm.meanMs / 1000).toFixed(1)} s on average, ${result.llm.errors} errors.`,
);
console.log(`Report: ${path.relative(process.cwd(), path.join(outDir, "report.md"))}`);
