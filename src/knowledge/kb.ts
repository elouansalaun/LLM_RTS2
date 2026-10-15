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

/**
 * Situation tags, read off the snapshot and the graph. They are the "query"
 * of the retrieval: each tag names a topic that matters right now.
 */
export function situationTags(snap: Snapshot, graph: Graph): string[] {
  if (snap.spawnPhase) return ["spawn", "map", "expand"];
  const me = snap.me;
  const tags = new Set<string>();
  const neighbours = neighboursOf(graph, me.key);
  const byKey = new Map(snap.others.map((p) => [p.key, p]));
  const players = neighbours.map((n) => byKey.get(n.key)).filter((p): p is PlayerView => p !== undefined);
  if (neighbours.some((n) => n.key === UNCLAIMED)) tags.add("expand");
  else tags.add("attack");
  if (players.some((p) => p.kind === "tribe")) tags.add("tribes").add("attack");
  if (players.some((p) => p.kind === "nation")) tags.add("nations");
  if (me.incomingAttacks.length > 0 || players.some((p) => p.troops > me.troops)) tags.add("defend");
  if (me.gold >= 50_000) tags.add("build").add("economy");
  if (me.allianceRequests.length > 0 || players.some((p) => p.kind === "nation")) tags.add("diplomacy");
  if (me.coastal && !neighbours.some((n) => n.key === UNCLAIMED)) tags.add("naval");
  if (me.troopsPctOfCap > 60 || me.troopsPctOfCap < 25) tags.add("troops");
  if (phaseOf(snap) === "late") tags.add("win");
  return [...tags];
}

/**
 * Deterministic retrieval: sections tagged "core" are always included; the
 * others are scored by how many situation tags they share (2 points each)
 * plus 1 point if they are written for the current phase. Highest scores win;
 * ties keep the knowledge base's order. I left out embeddings and LLM ranking
 * on purpose: the same situation always gives the same knowledge, so two runs
 * can be compared.
 */
export function retrieve(
  kb: KnowledgeSection[],
  tags: string[],
  phase: Phase,
  limit = 6,
): { core: KnowledgeSection[]; selected: KnowledgeSection[] } {
  const core = kb.filter((s) => s.tags.includes("core"));
  const scored = kb
    .filter((s) => !s.tags.includes("core"))
    .map((s, i) => {
      const overlap = s.tags.filter((t) => tags.includes(t)).length;
      const timely = s.when.includes(phase) || s.when.includes("any") ? 1 : 0;
      return { s, i, score: overlap * 2 + timely, overlap };
    })
    .filter((e) => e.overlap > 0 && (e.s.when.includes(phase) || e.s.when.includes("any")))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return { core, selected: scored.slice(0, limit).map((e) => e.s) };
}

/** A section as the LLM reads it: facts and strategies are labelled differently. */
export function renderSection(s: KnowledgeSection): string {
  const label = s.type === "fact" ? "[fact]" : "[strategy idea, not a rule]";
  return `### ${s.title} ${label}\n${s.text}`;
}
