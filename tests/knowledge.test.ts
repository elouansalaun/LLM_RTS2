import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { describe, expect, it } from "vitest";
import { loadKnowledge, phaseOf, retrieve, situationTags } from "../src/knowledge/kb";
import { buildGraph } from "../src/state/graph";
import { observe } from "../src/state/observe";
import { startedGame } from "./helpers";

const kb = loadKnowledge();
const TAGS = ["core", "spawn", "expand", "attack", "defend", "economy", "build", "diplomacy", "naval", "tribes", "nations", "troops", "win", "map"];
const WHEN = ["spawn", "early", "mid", "late", "any"];

describe("knowledge base", () => {
  it("parses every section with valid metadata", () => {
    expect(kb.length).toBeGreaterThan(25);
    expect(new Set(kb.map((s) => s.title)).size).toBe(kb.length);
    for (const s of kb) {
      expect(s.text.length, s.title).toBeGreaterThan(40);
      for (const t of s.tags) expect(TAGS, `${s.title}: tag ${t}`).toContain(t);
      for (const w of s.when) expect(WHEN, `${s.title}: when ${w}`).toContain(w);
      if (s.type === "fact") expect(s.source, `${s.title} needs a source`).not.toBeNull();
    }
  });

  it("retrieves spawn knowledge before the game starts", () => {
    const { core, selected } = retrieve(kb, { tags: ["spawn", "map", "expand"], urgent: ["spawn"] }, "spawn");
    expect(core.map((s) => s.title)).toEqual(["Core rules", "Time"]);
    expect(selected.map((s) => s.title)).toContain("Start in open plains");
    expect(selected.every((s) => s.when.includes("spawn") || s.when.includes("any"))).toBe(true);
  });

  it("derives tags from the situation, deterministically", async () => {
    const g = await startedGame({ ticks: 100 });
    const snap = observe(g);
    const graph = buildGraph(g);
    expect(phaseOf(snap)).toBe("early");
    const situation = situationTags(snap, graph);
    expect(situation.tags).toContain("expand");
    expect(situation.urgent).toContain("expand"); // lots of free land next to us
    const a = retrieve(kb, situation, "early").selected.map((s) => s.title);
    const b = retrieve(kb, situation, "early").selected.map((s) => s.title);
    expect(a).toEqual(b);
    expect(a).toContain("Taking unclaimed land");
  });

  it("puts urgent topics first", () => {
    const KEEP = "Keep troops near 40% of the cap";
    const calm = retrieve(kb, { tags: ["attack", "tribes", "nations", "diplomacy", "troops"], urgent: [] }, "mid").selected.map((s) => s.title);
    const full = retrieve(kb, { tags: ["attack", "tribes", "nations", "diplomacy", "troops"], urgent: ["troops"] }, "mid").selected.map((s) => s.title);
    const rank = (list: string[]) => (list.includes(KEEP) ? list.indexOf(KEEP) : Infinity);
    expect(full).toContain(KEEP);
    expect(rank(full)).toBeLessThan(rank(calm));
  });
});

/** Numbers stated as facts in knowledge/*.md, checked against the engine. */
describe("knowledge facts match the engine", async () => {
  const g = await startedGame({ ticks: 50 });
  const game = g.game;
  const config = game.config();
  const me = g.me;
  const tribe = game.players().find((p) => p.type() === PlayerType.Bot)!;
  const nation = game.players().find((p) => p.type() === PlayerType.Nation)!;
  const cost = (u: UnitType) => game.unitInfo(u).cost(game, me);

  it("rules and opponents", () => {
    expect(config.msPerTick()).toBe(100);
    expect(config.spawnImmunityDuration()).toBe(50);
    expect(config.percentageTilesOwnedToWin(0)).toBe(80);
    expect(config.startManpower(me.info())).toBe(25_000);
    expect(config.startManpower(nation.info())).toBe(18_750);
    expect(config.startManpower(tribe.info())).toBe(10_000);
    expect(config.attackAmount(tribe, me)).toBe(tribe.troops() / 20);
  });

  it("economy", () => {
    expect(config.goldAdditionRate(me)).toBe(100n);
    expect(config.goldAdditionRate(tribe)).toBe(50n);
    expect(config.maxTroops(me)).toBeCloseTo(2 * (1000 * me.numTilesOwned() ** 0.6 + 50_000), 3);
    expect(config.cityTroopIncrease()).toBe(250_000);
    expect(cost(UnitType.City)).toBe(125_000n);
    expect(cost(UnitType.Port)).toBe(125_000n);
    expect(cost(UnitType.Factory)).toBe(125_000n);
    expect(cost(UnitType.DefensePost)).toBe(50_000n);
    expect(config.structureMinDist()).toBe(15);
  });

  it("combat, boats and diplomacy", () => {
    expect(config.boatMaxNumber()).toBe(3);
    expect(config.defensePostRange()).toBe(30);
    expect(config.traitorDuration()).toBe(300);
    expect(config.allianceRequestDuration()).toBe(200);
    expect(config.allianceRequestCooldown()).toBe(300);
    expect(config.allianceDuration()).toBe(3000);
    expect(config.temporaryEmbargoDuration()).toBe(3000);
  });

  it("Tasmania is an island: no land path to the mainland nations", () => {
    const start = game.nations().find((n) => n.playerInfo.name === "Tasmania")!.spawnCell!;
    const victoria = game.nations().find((n) => n.playerInfo.name === "Victoria")!.spawnCell!;
    const seen = new Uint8Array(game.width() * game.height());
    const queue = [game.ref(start.x, start.y)];
    seen[queue[0]] = 1;
    while (queue.length > 0) {
      const t = queue.pop()!;
      for (const n of game.neighbors(t)) {
        if (!seen[n] && game.isLand(n)) {
          seen[n] = 1;
          queue.push(n);
        }
      }
    }
    expect(seen[game.ref(victoria.x, victoria.y)]).toBe(0);
  });
});
