import fs from "node:fs";
import path from "node:path";
import type { LLMCall } from "./agent/player";
import type { OpenFrontGame } from "./engine/game";
import type { MatchConfig, MatchResult, TurnRecord } from "./match";
import { clock, fmt, Graph, toMermaid } from "./state/graph";
import type { Snapshot } from "./state/observe";

/** A readable match report (report.md) next to the raw turns.jsonl. */
export function writeReport(
  outDir: string,
  config: MatchConfig,
  result: MatchResult,
  records: TurnRecord[],
  finalSnap: Snapshot,
  finalGraph: Graph,
  g: OpenFrontGame,
): void {
  const playing = records.filter((r) => r.orders.every((o) => !o.id.startsWith("spawn_")));
  const lines: string[] = [];
  const s = config.game;
  lines.push(
    `# Match report: ${result.llm.model} on ${s.map}`,
    "",
    `**Result: ${result.outcome}**${result.winner ? ` (winner: ${result.winner})` : ""}. ` +
      `After ${clock(result.seconds)} of game time the LLM holds ${result.me.landPct}% of the land: rank ${result.rank} of the ${result.players} players left in the game.`,
    "",
    "| Setting | Value |",
    "|---|---|",
    `| Model | \`${result.llm.model}\` |`,
    `| Map | ${s.map} (${s.mapSize}) |`,
    `| Opponents | ${s.nations === "default" ? "all nations of the map" : `${s.nations} nations`}, ${s.bots} tribes, ${s.difficulty} difficulty |`,
    `| Seed | \`${s.seed}\` |`,
    `| Turns | every ${config.agent.decisionEverySeconds} s; commander when something changes (at least every ${config.agent.commanderHeartbeatSeconds} s), strategist every ${config.agent.strategistEverySeconds} s or on major events |`,
    `| Troop rules | reserve chosen by the plan (at least ${config.agent.minReservePercent}% of the maximum), at most ${config.agent.troopBudgetPercent}% of the army per ${config.agent.troopBudgetWindowSeconds} s |`,
    "",
  );

  // Land over time, one point per game minute.
  const perMinute = new Map<number, TurnRecord>();
  for (const r of playing) perMinute.set(Math.floor(r.seconds / 60), r);
  const points = [...perMinute.entries()].sort((a, b) => a[0] - b[0]);
  if (points.length > 1) {
    const maxY = Math.max(5, Math.ceil(Math.max(...points.map(([, r]) => r.state.landPct)) / 5) * 5);
    lines.push(
      "## Land over time",
      "",
      "```mermaid",
      "xychart-beta",
      '  title "Share of the land held by the LLM (%)"',
      `  x-axis "game minute" [${points.map(([m]) => m).join(", ")}]`,
      `  y-axis "land %" 0 --> ${maxY}`,
      `  line [${points.map(([, r]) => r.state.landPct).join(", ")}]`,
      "```",
      "",
      "| Minute | Land % | Rank | Troops | % of cap | Gold |",
      "|---:|---:|---:|---:|---:|---:|",
      ...points.map(([m, r]) => `| ${m} | ${r.state.landPct} | ${r.state.rank}/${r.state.players} | ${fmt(r.state.troops)} | ${r.state.troopsPctOfCap} | ${fmt(r.state.gold)} |`),
      "",
    );
  }

  lines.push("## Final standings", "", "| # | Player | Kind | Land % |", "|---:|---|---|---:|");
  result.standings.forEach((p, i) => lines.push(`| ${i + 1} | ${p.kind === "you" ? `**${p.name} (LLM)**` : p.name} | ${p.kind} | ${p.landPct} |`));
  lines.push("", "Maps: gold = the LLM, colours = nations, grey = tribes, white squares = buildings.", "");
  const maps = fs.readdirSync(outDir).filter((f) => f.startsWith("map-") && f.endsWith(".png")).sort();
  for (const m of [...maps, "final.png"]) lines.push(`![${m}](${m})`, "");

  lines.push("## The strategist's plans", "", "| Time | Why it ran | Priorities | Focus | Plan | Knowledge used |", "|---|---|---|---|---|---|");
  for (const r of records) {
    const st = r.strategist;
    if (st === null) continue;
    const cell = (t: string) => t.replace(/\|/g, "/").replace(/\n/g, " ");
    lines.push(
      `| ${clock(r.seconds)} | ${cell(st.trigger)} | ${st.plan.priorities.join(", ")} | ${st.plan.focus} | ${cell(st.plan.plan)} | ${st.plan.knowledge_used.join("; ") || "-"} |`,
    );
  }

  const counts = new Map<string, number>();
  let reduced = 0;
  for (const r of playing) {
    for (const o of r.orders) {
      // attack_queensland -> attack, but build_city stays build_city; waves launched by the code are separate.
      const kind = o.standing ? "expand (automatic wave)" : o.id.startsWith("build_") ? o.id : o.id.replace(/_.*$/, "");
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (o.requestedPercent !== undefined) reduced++;
    }
  }
  const called = playing.filter((r) => r.commander !== null).length;
  const revised = playing.filter((r) => r.commander?.revision).length;
  lines.push(
    "",
    "## Orders",
    "",
    `The commander was called on ${called} of ${playing.length} turns; ${revised} answers were sent back by the self-check; the troop rules reduced ${reduced} orders.`,
    "",
    "| Order | Count |",
    "|---|---:|",
  );
  for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${n} |`);

  const used = new Map<string, number>();
  for (const r of records) for (const k of r.strategist?.plan.knowledge_used ?? []) used.set(k, (used.get(k) ?? 0) + 1);
  if (used.size > 0) {
    lines.push("", "## Knowledge the strategist relied on", "", "| Knowledge section | Plans citing it |", "|---|---:|");
    for (const [k, n] of [...used.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${n} |`);
  }

  const calls: { role: string; c: LLMCall }[] = records.flatMap((r) => [
    ...(r.commander ? [{ role: "commander", c: r.commander as LLMCall }] : []),
    ...(r.commander?.revision ? [{ role: "commander", c: r.commander.revision as LLMCall }] : []),
    ...(r.strategist ? [{ role: "strategist", c: r.strategist as LLMCall }] : []),
  ]);
  lines.push("", "## LLM calls", "", "| Role | Calls | Mean latency | Median latency | Errors |", "|---|---:|---:|---:|---:|");
  for (const role of ["strategist", "commander"]) {
    const ms = calls.filter((x) => x.role === role).map((x) => x.c.ms).sort((a, b) => a - b);
    const errors = calls.filter((x) => x.role === role && x.c.error !== null).length;
    if (ms.length === 0) continue;
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    lines.push(`| ${role} | ${ms.length} | ${(mean / 1000).toFixed(1)} s | ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s | ${errors} |`);
  }

  lines.push("", "## Final neighbourhood (map graph)", "", "```mermaid", toMermaid(finalSnap, finalGraph), "```", "");
  lines.push(
    `Raw data: \`turns.jsonl\` (every prompt and answer) and \`summary.json\`. Game id \`${g.gameStart.gameID}\`, engine: OpenFrontIO at the commit pinned in config/openfront.lock.json.`,
    "",
  );
  fs.writeFileSync(path.join(outDir, "report.md"), lines.join("\n"));
}
