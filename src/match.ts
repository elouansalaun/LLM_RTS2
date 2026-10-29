import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildMenu } from "./actions/menu";
import { diffEvents } from "./agent/events";
import { AgentSettingsSchema, LLMPlayer, Turn } from "./agent/player";
import { GameSettingsSchema, OpenFrontGame } from "./engine/game";
import { loadKnowledge } from "./knowledge/kb";
import type { LLM } from "./llm/lmstudio";
import { buildGraph, clock, describeSituation, describeSpawn, Graph } from "./state/graph";
import { observe, Snapshot } from "./state/observe";
import { renderPNG } from "./state/render";
import { writeReport } from "./report";

export const LLMSettingsSchema = z.object({
  baseURL: z.string().default("http://localhost:1234/v1"),
  model: z.string().default("qwen/qwen3.5-9b"),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().positive().default(800),
  timeoutSeconds: z.number().positive().default(180),
  contextLength: z.number().int().positive().default(16384),
});

export const MatchConfigSchema = z.object({
  game: GameSettingsSchema.prefault({}),
  agent: AgentSettingsSchema.prefault({}),
  llm: LLMSettingsSchema.prefault({}),
  /** The match stops after this much game time if nobody has won. */
  maxMinutes: z.number().positive().default(30),
  /** A map image is saved this often (game minutes). */
  mapEveryMinutes: z.number().positive().default(5),
});
export type MatchConfig = z.output<typeof MatchConfigSchema>;

export interface MatchResult {
  outcome: "won" | "lost" | "eliminated" | "time limit" | "engine error";
  winner: string | null;
  seconds: number;
  rank: number;
  players: number;
  me: { tiles: number; landPct: number; troops: number; gold: number; cities: number };
  standings: { name: string; kind: string; landPct: number }[];
  turns: number;
  llm: { model: string; calls: number; strategistCalls: number; meanMs: number; errors: number };
  outDir: string | null;
}

/** One line of turns.jsonl: the LLM turn plus the state it was taken in. */
export interface TurnRecord extends Turn {
  state: { tiles: number; landPct: number; troops: number; troopsPctOfCap: number; gold: number; rank: number; players: number };
  events: string[];
  engineWarnings: string[];
}

/**
 * Plays one game: the LLM player against the game's AI, until someone wins,
 * the LLM is eliminated, or the time limit. Game time is paused while the LLM
 * thinks (each turn the game runs `decisionEverySeconds`, then waits).
 */
export async function playMatch(
  config: MatchConfig,
  llm: LLM,
  opts: { outDir: string | null; log?: (line: string) => void },
): Promise<MatchResult> {
  const log = opts.log ?? (() => {});
  const out = opts.outDir;
  if (out !== null) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "config.json"), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(out, "turns.jsonl"), "");
  }
  const g = await OpenFrontGame.create(config.game);
  const player = new LLMPlayer(llm, loadKnowledge(), config.agent);
  const records: TurnRecord[] = [];
  let warningsSeen = 0;

  const record = (turn: Turn, snap: Snapshot, events: string[]) => {
    const rec: TurnRecord = {
      ...turn,
      state: {
        tiles: snap.me.tiles,
        landPct: snap.me.landPct,
        troops: snap.me.troops,
        troopsPctOfCap: snap.me.troopsPctOfCap,
        gold: snap.me.gold,
        rank: snap.me.rank,
        players: snap.playersAlive,
      },
      events,
      engineWarnings: g.engineLog.slice(warningsSeen).map((w) => w.message),
    };
    warningsSeen = g.engineLog.length;
    records.push(rec);
    if (out !== null) fs.appendFileSync(path.join(out, "turns.jsonl"), JSON.stringify(rec) + "\n");
    if (turn.strategist !== null) {
      log(`[${clock(snap.seconds)}] strategist (${turn.strategist.trigger}, ${(turn.strategist.ms / 1000).toFixed(1)}s): ${turn.strategist.plan.plan}`);
    }
    const orders = turn.orders.map((o) => {
      const troops = o.intent?.type === "attack" || o.intent?.type === "boat";
      const asked = o.requestedPercent !== undefined ? ` (asked ${o.requestedPercent}%, ${o.limitedBy})` : "";
      return `${o.standing ? "auto-" : ""}${o.id}${troops ? ` ${o.troopsPercent}%` : ""}${asked}`;
    });
    const where = snap.spawnPhase
      ? "start"
      : `${snap.me.landPct.toFixed(1)}% land, #${snap.me.rank}/${snap.playersAlive}, ${Math.round(snap.me.troops / 1000)}k troops (${snap.me.troopsPctOfCap}%)`;
    const c = turn.commander;
    const llmPart =
      c === null
        ? "no LLM call"
        : `${((c.ms + (c.revision?.ms ?? 0)) / 1000).toFixed(1)}s${c.revision ? " (revised)" : ""}${c.error ? ` ERROR ${c.error}` : ""}`;
    // Quiet turns with nothing new are not printed, to keep the log readable at fast cadences.
    if (c === null && turn.orders.length === 0) return;
    log(`[${clock(snap.seconds)}] ${where} │ ${orders.join(" + ") || "wait"} │ ${llmPart}`);
  };

  // The engine adds every player on the first tick.
  g.advance(1);

  // ── spawn: the strategist picks a start, the commander places it ──
  for (let attempt = 0; g.inSpawnPhase(); attempt++) {
    if (attempt === 3) throw new Error("could not spawn after 3 attempts");
    const snap = observe(g);
    const graph = buildGraph(g);
    const menu = buildMenu(g, snap, graph);
    const turn = await player.takeTurn({ snap, graph, menu, situation: describeSpawn(g), events: [] });
    for (const o of turn.orders) if (o.intent) g.submit(o.intent);
    record(turn, snap, []);
    g.advance(5);
  }

  // ── the game ──
  const decisionTicks = Math.max(1, Math.round(config.agent.decisionEverySeconds * 10));
  const mapEvery = config.mapEveryMinutes * 60;
  let nextMap = mapEvery;
  let prev: Snapshot | null = null;
  let snap = observe(g);
  let graph: Graph = buildGraph(g);
  while (true) {
    snap = observe(g);
    graph = buildGraph(g);
    if (g.winner() !== null || !snap.me.alive || g.error !== null || snap.seconds >= config.maxMinutes * 60) break;
    const events = diffEvents(prev, snap);
    const menu = buildMenu(g, snap, graph);
    const turn = await player.takeTurn({ snap, graph, menu, situation: describeSituation(snap, graph), events });
    for (const o of turn.orders) if (o.intent) g.submit(o.intent);
    record(turn, snap, events.map((e) => e.text));
    if (out !== null && snap.seconds >= nextMap) {
      fs.writeFileSync(path.join(out, `map-${String(Math.round(snap.seconds / 60)).padStart(2, "0")}min.png`), renderPNG(g.game, g.me));
      nextMap += mapEvery;
    }
    prev = snap;
    g.advance(decisionTicks);
  }

  const winner = g.winner();
  const outcome: MatchResult["outcome"] =
    g.error !== null ? "engine error" : winner === g.me ? "won" : winner !== null ? "lost" : !snap.me.alive ? "eliminated" : "time limit";
  const calls = records.flatMap((r) => [
    ...(r.commander ? [r.commander] : []),
    ...(r.commander?.revision ? [r.commander.revision] : []),
    ...(r.strategist ? [r.strategist] : []),
  ]);
  const result: MatchResult = {
    outcome,
    winner: winner?.displayName() ?? null,
    seconds: snap.seconds,
    rank: snap.me.rank,
    players: snap.others.length + 1,
    me: { tiles: snap.me.tiles, landPct: snap.me.landPct, troops: snap.me.troops, gold: snap.me.gold, cities: snap.me.cities },
    standings: [snap.me, ...snap.others]
      .sort((a, b) => b.tiles - a.tiles)
      .slice(0, 10)
      .map((p) => ({ name: p.name, kind: p.kind, landPct: p.landPct })),
    turns: records.length,
    llm: {
      model: llm.name,
      calls: calls.length,
      strategistCalls: records.filter((r) => r.strategist !== null).length,
      meanMs: calls.length > 0 ? Math.round(calls.reduce((s, c) => s + c.ms, 0) / calls.length) : 0,
      errors: calls.filter((c) => c.error !== null).length,
    },
    outDir: out,
  };
  if (out !== null) {
    fs.writeFileSync(path.join(out, "final.png"), renderPNG(g.game, g.me));
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(result, null, 2));
    writeReport(out, config, result, records, snap, graph, g);
  }
  return result;
}
