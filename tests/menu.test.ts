import { IntentSchema } from "@openfront/engine-api/Schemas";
import { describe, expect, it } from "vitest";
import { buildMenu, spawnMenu } from "../src/actions/menu";
import { OpenFrontGame } from "../src/engine/game";
import { buildGraph } from "../src/state/graph";
import { observe } from "../src/state/observe";
import { startedGame } from "./helpers";

describe("the action menu", () => {
  it("offers spread-out spawn candidates with a description", async () => {
    const g = await OpenFrontGame.create({});
    g.advance(1);
    const menu = buildMenu(g, observe(g), buildGraph(g));
    expect(menu.length).toBeGreaterThanOrEqual(8);
    expect(menu.every((o) => o.id.startsWith("spawn_"))).toBe(true);
    expect(menu[0].label).toMatch(/plains.*nearest nation/);
    for (const o of menu) expect(IntentSchema.safeParse(o.toIntent(0)).success).toBe(true);
  });

  it("offers only orders the engine accepts", async () => {
    const g = await startedGame({ ticks: 0 });
    g.submit({ type: "attack", targetID: null, troops: g.me.troops() * 0.3 });
    g.advance(1500); // 2.5 minutes: neighbours and gold
    const snap = observe(g);
    const menu = buildMenu(g, snap, buildGraph(g));
    const ids = menu.map((o) => o.id);
    expect(ids[0]).toBe("wait");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.startsWith("attack_") || id === "expand")).toBe(true);
    for (const o of menu) {
      const intent = o.toIntent(30);
      if (intent === null) continue;
      expect(IntentSchema.safeParse(intent).success, o.id).toBe(true);
      if (intent.type === "attack" || intent.type === "boat") {
        expect(intent.troops).toBeCloseTo(g.me.troops() * 0.3, -1);
      }
    }
    // A building is offered only when it is affordable.
    const city = menu.find((o) => o.id === "build_city");
    expect(city === undefined || snap.me.gold >= 125_000).toBe(true);
  });

  it("places a city where the engine builds it", async () => {
    const g = await startedGame({ ticks: 0 });
    g.submit({ type: "attack", targetID: null, troops: g.me.troops() * 0.3 });
    g.advance(1300); // > 125,000 gold
    const city = buildMenu(g, observe(g), buildGraph(g)).find((o) => o.id === "build_city");
    expect(city).toBeDefined();
    g.submit(city!.toIntent(0)!);
    g.advance(30);
    expect(observe(g).me.cities).toBe(1);
  });

  it("returns the same spawn candidates for the same map", async () => {
    const a = await OpenFrontGame.create({ seed: "x" });
    const b = await OpenFrontGame.create({ seed: "y" });
    expect(spawnMenu(a.game).map((o) => o.label)).toEqual(spawnMenu(b.game).map((o) => o.label));
  });
});
