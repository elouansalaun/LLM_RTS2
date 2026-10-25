import type { Player } from "@openfront/engine/game/Game";
import type { OpenFrontGame } from "../engine/game";
import { directionFrom, playerKeys, PlayerView, regionOf, Snapshot } from "./observe";

export const UNCLAIMED = "unclaimed";

/**
 * The game as a graph: one node per living player plus one for unclaimed land.
 * - "border" edges join territories that touch on land (weight = border length in tile edges)
 * - "attack" edges point from attacker to target (weight = troops in the attack)
 * - "alliance" edges join allies
 * The map has ~328,000 land tiles; this graph has ~30 nodes and ~100 edges,
 * which is small enough for a 9B model to actually read.
 */
export interface Graph {
  nodes: string[];
  edges: GraphEdge[];
}

export interface GraphEdge {
  kind: "border" | "attack" | "alliance";
  from: string;
  to: string;
  weight: number;
}

export function buildGraph(g: OpenFrontGame): Graph {
  const game = g.game;
  const keys = playerKeys(game);
  const living = game.players().filter((p) => p.isAlive());
  const keyBySmallID = new Map<number, string>(living.map((p) => [p.smallID(), keys.get(p.id())!]));
  keyBySmallID.set(0, UNCLAIMED);

  // Land borders: walk every player's border tiles and look at their 4 neighbours.
  // A shared border is counted from the side of the player with the lower small id only.
  const borders = new Map<string, number>();
  for (const p of living) {
    const mine = p.smallID();
    for (const t of p.borderTiles()) {
      for (const n of game.neighbors(t)) {
        if (!game.isLand(n)) continue;
        const other = game.ownerID(n);
        if (other === mine || (other !== 0 && other < mine)) continue;
        const pair = `${mine}|${other}`;
        borders.set(pair, (borders.get(pair) ?? 0) + 1);
      }
    }
  }
  const edges: GraphEdge[] = [];
  for (const [pair, weight] of borders) {
    const [a, b] = pair.split("|").map(Number);
    const from = keyBySmallID.get(a);
    const to = keyBySmallID.get(b);
    if (from !== undefined && to !== undefined) edges.push({ kind: "border", from, to, weight });
  }

  const allied = new Set<string>();
  for (const p of living) {
    const from = keys.get(p.id())!;
    for (const a of p.outgoingAttacks()) {
      const target = a.target();
      const to = target.isPlayer() ? keys.get((target as Player).id())! : UNCLAIMED;
      edges.push({ kind: "attack", from, to, weight: Math.round(a.troops()) });
    }
    for (const ally of p.allies()) {
      const to = keys.get(ally.id())!;
      const pair = [from, to].sort().join("|");
      if (allied.has(pair)) continue;
      allied.add(pair);
      edges.push({ kind: "alliance", from, to, weight: 1 });
    }
  }
  return { nodes: [...keyBySmallID.values()], edges };
}

/** A player's land neighbours, longest border first. */
export function neighboursOf(graph: Graph, key: string): { key: string; border: number }[] {
  return graph.edges
    .filter((e) => e.kind === "border" && (e.from === key || e.to === key))
    .map((e) => ({ key: e.from === key ? e.to : e.from, border: e.weight }))
    .sort((a, b) => b.border - a.border);
}

/**
 * The situation in plain text, built from the snapshot and the graph. This is
 * what both LLM roles read about the game state.
 */
export function describeSituation(snap: Snapshot, graph: Graph): string {
  const me = snap.me;
  const byKey = new Map<string, PlayerView>(snap.others.map((p) => [p.key, p]));
  const lines: string[] = [];
  lines.push(
    `Time ${clock(snap.seconds)}. You are ${me.name}, in the ${me.region} of the map.`,
    `You: ${fmt(me.tiles)} tiles (${me.landPct}% of the land, rank ${me.rank} of ${snap.playersAlive}), ` +
      `${fmt(me.troops)} troops = ${me.troopsPctOfCap}% of your maximum of ${fmt(me.troopCap)} (${reserveHint(me.troopsPctOfCap)}), ${fmt(me.gold)} gold, ` +
      `${count(me.cities, "city", "cities")}, ${count(me.ports, "port")}, ${count(me.defensePosts, "defense post")}` +
      `${me.coastal ? ", coastal" : ", no coast"}.`,
    // The model once sat at 0-1% of its cap for 90 s while quoting "keep troops near
    // 40%". The rule alone wasn't enough, so I spell out the growth it gives up.
    `Troop growth: +${fmt(me.growthPerSecond)} per second now; it would be +${fmt(me.growthAt40PerSecond)} per second at 40% of your maximum.`,
    `Unclaimed land: ${snap.unclaimedPct}% of the map.`,
  );
  if (me.incomingAttacks.length > 0) {
    lines.push(`UNDER ATTACK by ${me.incomingAttacks.map((a) => `${nameOf(byKey, a.from)} (${fmt(a.troops)} troops)`).join(", ")}.`);
  }
  if (me.outgoingAttacks.length > 0) {
    lines.push(`Your attacks under way: ${me.outgoingAttacks.map((a) => `${nameOf(byKey, a.to)} (${fmt(a.troops)} troops left)`).join(", ")}.`);
  }
  if (me.alliances.length > 0) {
    lines.push(`Allies: ${me.alliances.map((a) => `${nameOf(byKey, a.with)} (${a.secondsLeft}s left)`).join(", ")}.`);
  }
  if (me.allianceRequests.length > 0) {
    lines.push(`Alliance requests waiting for your answer: ${me.allianceRequests.map((k) => nameOf(byKey, k)).join(", ")}.`);
  }

  const neighbours = neighboursOf(graph, me.key);
  lines.push("", "Your land neighbours (from the map graph, longest border first):");
  if (neighbours.length === 0) lines.push("- none: you have no land border with anyone (boats only).");
  for (const n of neighbours) {
    if (n.key === UNCLAIMED) {
      lines.push(`- unclaimed land: border ${n.border} tiles. Expanding into it costs troops but no fight.`);
      continue;
    }
    const p = byKey.get(n.key);
    if (p === undefined) continue;
    const ratio = me.troops > 0 ? p.troops / me.troops : 99;
    const busy = graph.edges
      .filter((e) => e.kind === "attack" && e.from === p.key && e.to !== me.key && e.to !== UNCLAIMED)
      .map((e) => nameOf(byKey, e.to));
    const parts = [
      `${p.name} (${p.kind}, ${directionFrom(me.centre, p.centre)}): border ${n.border} tiles`,
      `${fmt(p.tiles)} tiles, ${fmt(p.troops)} troops, ${strength(ratio)}, ${p.troopsPerTile} troops/tile`,
    ];
    if (p.relation !== null) parts.push(`feels ${p.relation} towards you`);
    if (p.allied) parts.push("ALLIED with you");
    if (p.traitor) parts.push("traitor (easier to attack)");
    if (me.incomingAttacks.some((a) => a.from === p.key)) parts.push("ATTACKING YOU");
    if (busy.length > 0) parts.push(`busy attacking ${busy.join(", ")}`);
    lines.push(`- ${parts.join("; ")}.`);
  }

  const far = snap.others.filter((p) => !neighbours.some((n) => n.key === p.key) && p.kind === "nation");
  if (far.length > 0) {
    lines.push("", "Nations you do not border:");
    for (const p of far) {
      lines.push(`- ${p.name} (${p.region} of the map): ${fmt(p.tiles)} tiles, ${fmt(p.troops)} troops${p.allied ? ", ALLIED" : ""}.`);
    }
  }
  lines.push("", `Largest players: ${snap.others.slice(0, 5).map((p) => `${p.name} ${p.landPct}%`).join(", ")}.`);
  return lines.join("\n");
}

/** The situation before the game starts: only the nations' fixed starts are known. */
export function describeSpawn(g: OpenFrontGame): string {
  const game = g.game;
  const nations = game
    .nations()
    .filter((n) => n.spawnCell !== undefined)
    .map((n) => `${n.playerInfo.name} (${regionOf(game, n.spawnCell!)})`);
  return [
    `The game is about to start on the ${g.settings.map} map (${game.width()} × ${game.height()} tiles, ${fmt(game.numLandTiles())} land tiles).`,
    `You are ${g.settings.playerName}. Choose where to start.`,
    `Nations (strong AI) start at fixed places: ${nations.join(", ")}.`,
    `${g.settings.bots} tribes (weak AI) will start at random places.`,
  ].join("\n");
}

/** Mermaid diagram of the player's neighbourhood, for the notebooks and reports. */
export function toMermaid(snap: Snapshot, graph: Graph): string {
  const keep = new Set([snap.me.key, ...neighboursOf(graph, snap.me.key).map((n) => n.key)]);
  const label = new Map<string, string>([[UNCLAIMED, "unclaimed land"]]);
  label.set(snap.me.key, `${snap.me.name} (you)<br/>${fmt(snap.me.tiles)} tiles`);
  for (const p of snap.others) label.set(p.key, `${p.name}<br/>${p.kind}, ${fmt(p.tiles)} tiles`);
  const lines = ["graph LR"];
  for (const k of keep) lines.push(`  ${k}["${label.get(k) ?? k}"]`);
  for (const e of graph.edges) {
    if (!keep.has(e.from) || !keep.has(e.to)) continue;
    if (e.kind === "border") lines.push(`  ${e.from} ---|"border ${e.weight}"| ${e.to}`);
    if (e.kind === "attack") lines.push(`  ${e.from} ==>|"attack ${fmt(e.weight)}"| ${e.to}`);
    if (e.kind === "alliance") lines.push(`  ${e.from} -.-|alliance| ${e.to}`);
  }
  return lines.join("\n");
}

function nameOf(byKey: Map<string, PlayerView>, key: string): string {
  return key === UNCLAIMED ? "unclaimed land" : (byKey.get(key)?.name ?? key);
}

export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Words, not just numbers. In my first tests Qwen 3.5 9B read "0.5× yours" as
 * "they outnumber us" and "92% of your cap" as "reserve nearly empty", so I
 * write the conclusion next to the number.
 */
export function strength(ratio: number): string {
  if (ratio < 0.8) return `WEAKER than you (they have ${ratio.toFixed(1)}× your troops)`;
  if (ratio <= 1.25) return `about as strong as you (${ratio.toFixed(1)}× your troops)`;
  return `STRONGER than you (they have ${ratio.toFixed(1)}× your troops)`;
}

function reserveHint(pct: number): string {
  if (pct >= 95) return "full: troops have stopped growing, use them";
  if (pct > 60) return "high: growth is slowing, troops are available";
  if (pct >= 25) return "good range for growth";
  return "low: vulnerable to attacks";
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
