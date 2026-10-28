import { fmt, UNCLAIMED } from "../state/graph";
import type { Snapshot } from "../state/observe";

export interface GameEvent {
  text: string;
  /** Major events make the strategist re-plan before the next scheduled time. */
  major: boolean;
  /**
   * Routine events (land gained, small losses, an expansion wave that ended)
   * do not call the commander: the standing orders handle them.
   */
  routine?: boolean;
}

/**
 * What changed between two snapshots, in words. I diff snapshots instead of
 * decoding the engine's update stream: it's simpler and sturdier, and it gives
 * the LLM exactly what it needs ("what happened since I last looked").
 */
export function diffEvents(prev: Snapshot | null, now: Snapshot): GameEvent[] {
  if (prev === null || prev.spawnPhase) return [];
  const events: GameEvent[] = [];
  const name = (key: string) =>
    key === UNCLAIMED ? "unclaimed land" : (now.others.find((p) => p.key === key)?.name ?? prev.others.find((p) => p.key === key)?.name ?? key);

  const dTiles = now.me.tiles - prev.me.tiles;
  if (dTiles !== 0) {
    const lostShare = prev.me.tiles > 0 ? -dTiles / prev.me.tiles : 0;
    events.push({
      text: dTiles > 0 ? `You gained ${fmt(dTiles)} tiles.` : `You LOST ${fmt(-dTiles)} tiles.`,
      major: lostShare > 0.05,
      routine: lostShare <= 0.05,
    });
  }
  if (prev.me.bordersUnclaimed && !now.me.bordersUnclaimed) {
    events.push({ text: "No unclaimed land touches you any more: expansion is over, only attacks (or boats) can grow your land now.", major: true });
  }
  if (prev.me.troopsPctOfCap < 95 && now.me.troopsPctOfCap >= 95) {
    events.push({ text: `Your troops reached ${now.me.troopsPctOfCap}% of your maximum: they no longer grow until you use them.`, major: true });
  }
  const before = new Set(prev.me.incomingAttacks.map((a) => a.from));
  for (const a of now.me.incomingAttacks) {
    if (!before.has(a.from)) events.push({ text: `${name(a.from)} started attacking you with ${fmt(a.troops)} troops.`, major: true });
  }
  const after = new Set(now.me.incomingAttacks.map((a) => a.from));
  for (const from of before) if (!after.has(from)) events.push({ text: `${name(from)}'s attack on you ended.`, major: false });
  const mineAfter = new Set(now.me.outgoingAttacks.map((a) => a.to));
  for (const a of prev.me.outgoingAttacks) {
    if (!mineAfter.has(a.to)) events.push({ text: `Your attack on ${name(a.to)} ended.`, major: false, routine: a.to === UNCLAIMED });
  }
  for (const key of now.me.allianceRequests) {
    if (!prev.me.allianceRequests.includes(key)) events.push({ text: `${name(key)} asks you for an alliance.`, major: false });
  }
  const alliesBefore = new Set(prev.me.alliances.map((a) => a.with));
  const alliesAfter = new Set(now.me.alliances.map((a) => a.with));
  for (const k of alliesAfter) if (!alliesBefore.has(k)) events.push({ text: `You are now allied with ${name(k)}.`, major: true });
  for (const k of alliesBefore) if (!alliesAfter.has(k)) events.push({ text: `Your alliance with ${name(k)} ended.`, major: true });
  const alive = new Set(now.others.map((p) => p.key));
  for (const p of prev.others) {
    if (!alive.has(p.key)) events.push({ text: `${p.name} (${p.kind}) was eliminated.`, major: p.kind === "nation" });
  }
  for (const [what, b, a] of [
    ["city", prev.me.cities, now.me.cities],
    ["port", prev.me.ports, now.me.ports],
    ["defense post", prev.me.defensePosts, now.me.defensePosts],
  ] as const) {
    if (a > b) events.push({ text: `Your new ${what} is ready.`, major: false });
    if (a < b) events.push({ text: `You lost a ${what}.`, major: true });
  }
  return events;
}
