import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../engine/game";
import type { Graph } from "../state/graph";
import { neighboursOf, UNCLAIMED } from "../state/graph";
import type { PlayerView, Snapshot } from "../state/observe";

/**
 * One "## " section of a knowledge/*.md file. Its metadata line says whether it
 * is a verified fact about the engine or a strategy idea to try, which topics
 * it covers, and in which phase of the game it matters.
 */
export interface KnowledgeSection {
  title: string;
  file: string;
  type: "fact" | "strategy";
  tags: string[];
  when: string[];
  source: string | null;
  text: string;
}

export type Phase = "spawn" | "early" | "mid" | "late";

const META = /^<!--\s*(.*?)\s*-->$/;

export function loadKnowledge(dir = path.join(ROOT, "knowledge")): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const chunks = fs.readFileSync(path.join(dir, file), "utf8").split(/^## /m).slice(1);
    for (const chunk of chunks) {
      const [title, metaLine, ...body] = chunk.split("\n");
      const m = META.exec(metaLine.trim());
      if (m === null) throw new Error(`${file} › ${title}: missing <!-- metadata --> line`);
      const meta = Object.fromEntries(
        m[1].split(";").map((kv) => kv.split(":").map((s) => s.trim()) as [string, string]),
      );
      const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (meta.type !== "fact" && meta.type !== "strategy") {
        throw new Error(`${file} › ${title}: type must be fact or strategy`);
      }
      sections.push({
        title: title.trim(),
        file,
        type: meta.type,
        tags: list(meta.tags),
        when: list(meta.when),
        source: meta.source ?? null,
        text: body.join("\n").trim(),
      });
    }
  }
  return sections;
}

/** Where the game is: picks which strategies are relevant. */
export function phaseOf(snap: Snapshot): Phase {
  if (snap.spawnPhase) return "spawn";
  const leader = Math.max(snap.me.landPct, ...snap.others.map((p) => p.landPct));
  if (leader >= 30) return "late";
  if (snap.unclaimedPct > 15) return "early";
  return "mid";
}

/** The retrieval query: topics that matter now, and the pressing ones among them. */
export interface Situation {
  tags: string[];
  /** Pressing topics (under attack, reserve full or empty…): they weigh double. */
  urgent: string[];
}

/**
 * Situation tags, read off the snapshot and the graph. They are the "query"
 * of the retrieval: each tag names a topic that matters right now.
 */
export function situationTags(snap: Snapshot, graph: Graph): Situation {
  if (snap.spawnPhase) return { tags: ["spawn", "map", "expand"], urgent: ["spawn"] };
  const me = snap.me;
  const tags = new Set<string>();
  const urgent = new Set<string>();
  const neighbours = neighboursOf(graph, me.key);
  const byKey = new Map(snap.others.map((p) => [p.key, p]));
  const players = neighbours.map((n) => byKey.get(n.key)).filter((p): p is PlayerView => p !== undefined);
  const freeLand = neighbours.some((n) => n.key === UNCLAIMED);
  if (freeLand) tags.add("expand");
  if (freeLand && snap.unclaimedPct > 15) urgent.add("expand");
  if (!freeLand) tags.add("attack");
  if (players.some((p) => p.kind === "tribe")) tags.add("tribes").add("attack");
  if (players.some((p) => p.kind === "nation")) tags.add("nations");
  if (me.incomingAttacks.length > 0) urgent.add("defend");
  if (me.incomingAttacks.length > 0 || players.some((p) => p.troops > me.troops)) tags.add("defend");
  if (me.gold >= 50_000) tags.add("build").add("economy");
  if (me.allianceRequests.length > 0) urgent.add("diplomacy");
  if (me.allianceRequests.length > 0 || players.some((p) => p.kind === "nation")) tags.add("diplomacy");
  if (me.coastal && !freeLand) tags.add("naval");
  if (me.troopsPctOfCap > 60 || me.troopsPctOfCap < 25) tags.add("troops");
  if (me.troopsPctOfCap > 80 || me.troopsPctOfCap < 20) urgent.add("troops");
  if (phaseOf(snap) === "late") tags.add("win");
  for (const u of urgent) tags.add(u);
  return { tags: [...tags], urgent: [...urgent] };
}

/**
 * Deterministic retrieval. Sections tagged "core" are always included. The
 * others must be written for the current phase, and are picked one by one:
 * each tag a section shares with the situation is worth 2 points (4 if the
 * tag is urgent), divided by 1 + the number of sections already picked for
 * that tag. So the first sections cover the most pressing topics, and each
 * following one has to bring something the others did not. Ties keep the
 * knowledge base's order. I left out embeddings and LLM ranking on purpose:
 * the same situation always gives the same knowledge, so two runs can be
 * compared.
 */
export function retrieve(
  kb: KnowledgeSection[],
  situation: Situation,
  phase: Phase,
  limit = 6,
): { core: KnowledgeSection[]; selected: KnowledgeSection[]; scores: number[] } {
  const core = kb.filter((s) => s.tags.includes("core"));
  const pool = kb.filter(
    (s) => !s.tags.includes("core") && (s.when.includes(phase) || s.when.includes("any")),
  );
  const covered = new Map<string, number>();
  const selected: KnowledgeSection[] = [];
  const scores: number[] = [];
  const score = (s: KnowledgeSection) =>
    s.tags
      .filter((t) => situation.tags.includes(t))
      .reduce((sum, t) => sum + (situation.urgent.includes(t) ? 4 : 2) / (1 + (covered.get(t) ?? 0)), 0);
  while (selected.length < limit) {
    let best: KnowledgeSection | null = null;
    let bestScore = 0;
    for (const s of pool) {
      if (selected.includes(s)) continue;
      const v = score(s);
      if (v > bestScore + 1e-9) [best, bestScore] = [s, v];
    }
    if (best === null) break;
    selected.push(best);
    scores.push(Math.round(bestScore * 100) / 100);
    for (const t of best.tags) if (situation.tags.includes(t)) covered.set(t, (covered.get(t) ?? 0) + 1);
  }
  return { core, selected, scores };
}

/** A section as the LLM reads it: facts and strategies are labelled differently. */
export function renderSection(s: KnowledgeSection): string {
  const label = s.type === "fact" ? "[fact]" : "[strategy idea, not a rule]";
  return `### ${s.title} ${label}\n${s.text}`;
}
