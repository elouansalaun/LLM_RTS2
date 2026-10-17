import { describe, expect, it } from "vitest";
import { diffEvents } from "../src/agent/events";
import { buildGraph, describeSituation, neighboursOf, toMermaid, UNCLAIMED } from "../src/state/graph";
import { directionFrom, observe, playerKeys, regionOf } from "../src/state/observe";
import { renderASCII, renderPNG } from "../src/state/render";
import { startedGame } from "./helpers";

describe("observation and graph", async () => {
  const g = await startedGame({ ticks: 0 });
  g.submit({ type: "attack", targetID: null, troops: g.me.troops() * 0.3 });
  g.advance(300);
  const snap = observe(g);
  const graph = buildGraph(g);

  it("describes the LLM's player", () => {
    expect(snap.me.kind).toBe("you");
    expect(snap.me.tiles).toBeGreaterThan(100);
    expect(snap.me.troopCap).toBeGreaterThan(snap.me.troops);
    expect(snap.others.length).toBe(snap.playersAlive - 1);
    expect(snap.unclaimedPct).toBeGreaterThan(0);
  });

  it("gives every player a unique, readable key", () => {
    const keys = [...playerKeys(g.game).values()];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("new_south_wales");
  });

  it("builds a graph whose borders match the map", () => {
    const mine = neighboursOf(graph, snap.me.key);
    expect(mine.some((n) => n.key === UNCLAIMED)).toBe(true);
    // Cross-check one border against a direct count on the tiles.
    const first = mine.find((n) => n.key !== UNCLAIMED) ?? mine[0];
    const otherSmallID = first.key === UNCLAIMED ? 0 : g.game.players().find((p) => playerKeys(g.game).get(p.id()) === first.key)!.smallID();
    let count = 0;
    for (const t of g.me.borderTiles()) {
      for (const n of g.game.neighbors(t)) if (g.game.isLand(n) && g.game.ownerID(n) === otherSmallID) count++;
    }
    expect(first.border).toBe(count);
  });

  it("writes the situation in words, with neighbours and directions", () => {
    const text = describeSituation(snap, graph);
    expect(text).toContain("You are Qwen");
    expect(text).toContain("unclaimed land: border");
    expect(toMermaid(snap, graph)).toMatch(/^graph LR/);
  });

  it("names map regions and directions", () => {
    expect(regionOf(g.game, { x: 10, y: 10 })).toBe("north-west");
    expect(regionOf(g.game, { x: 500, y: 375 })).toBe("centre");
    expect(directionFrom({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe("east");
    expect(directionFrom({ x: 0, y: 0 }, { x: 0, y: -100 })).toBe("north");
  });

  it("writes what changed between two snapshots as events", () => {
    const before = observe(g);
    g.submit({ type: "attack", targetID: null, troops: g.me.troops() * 0.5 });
    g.advance(100);
    const after = observe(g);
    const events = diffEvents(before, after).map((e) => e.text);
    expect(events.some((e) => /^You gained [\d,]+ tiles\.$/.test(e))).toBe(true);
    expect(diffEvents(null, after)).toEqual([]);
  });

  it("renders the map as PNG and as text", () => {
    const png = renderPNG(g.game, g.me);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    const ascii = renderASCII(g.game, g.me, 250); // fine enough for a small territory to show
    expect(ascii.text).toContain("@");
    expect(ascii.legend["@"]).toContain("you");
  });
});
