import { describe, expect, it } from "vitest";
import { buildMenu } from "../src/actions/menu";
import { AgentSettingsSchema, LLMPlayer } from "../src/agent/player";
import { loadKnowledge } from "../src/knowledge/kb";
import type { ChatRequest, ChatResult, LLM } from "../src/llm/lmstudio";
import { buildGraph, describeSituation } from "../src/state/graph";
import { observe, Snapshot } from "../src/state/observe";
import { startedGame } from "./helpers";

type Orders = { id: string; troops_percent: number }[];

/** An LLM with fixed answers: one plan, and the same orders on every call. */
class ScriptedLLM implements LLM {
  readonly name = "scripted";
  constructor(
    private orders: Orders,
    private plan: { reserve_percent: number } = { reserve_percent: 25 },
  ) {}
  async chat(request: ChatRequest): Promise<ChatResult> {
    const json =
      request.schemaName === "strategist_plan"
        ? { assessment: "a", plan: "attack with everything", priorities: ["attack"], focus: "none", ...this.plan, knowledge_used: [] }
        : { reason: "r", actions: this.orders };
    return { json, text: JSON.stringify(json), ms: 1, promptTokens: null, completionTokens: null };
  }
}

/** A started game at 40 s, with the inputs of one turn; `edit` adjusts the snapshot. */
async function position(edit: (s: Snapshot) => Snapshot = (s) => s) {
  const g = await startedGame({ ticks: 400 });
  const snap = edit(observe(g));
  const graph = buildGraph(g);
  const menu = buildMenu(g, snap, graph);
  const attack = menu.find((o) => o.id.startsWith("attack_"))!.id;
  return { g, snap, graph, menu, attack, situation: describeSituation(snap, graph) };
}

function player(llm: LLM, settings = {}) {
  return new LLMPlayer(llm, loadKnowledge(), AgentSettingsSchema.parse(settings));
}

describe("the LLM player", () => {
  it("runs the strategist on its first turn and keeps the plan", async () => {
    const p = await position();
    const turn = await player(new ScriptedLLM([{ id: "wait", troops_percent: 0 }])).takeTurn({ ...p, events: [] });
    expect(turn.strategist?.trigger).toBe("first plan");
    expect(turn.strategist?.plan.plan).toBe("attack with everything");
    expect(turn.commander.user).toContain("attack with everything");
    expect(turn.commander.user).toContain("## Troop rules now");
  });

  it("re-plans exactly every 30 s of game time (no floating-point drift)", async () => {
    const p = await position();
    const agent = player(new ScriptedLLM([{ id: "wait", troops_percent: 0 }]));
    const turn = (seconds: number) => agent.takeTurn({ ...p, snap: { ...p.snap, seconds }, events: [] });
    expect((await turn(60.6)).strategist?.trigger).toBe("first plan");
    expect((await turn(85.6)).strategist).toBeNull();
    expect((await turn(90.6)).strategist?.trigger).toBe("scheduled"); // 90.6 - 60.6 = 29.999… in floating point
  });

  it("turns menu ids into engine orders and drops unknown or repeated ids", async () => {
    const p = await position();
    const turn = await player(
      new ScriptedLLM([
        { id: "expand", troops_percent: 30 },
        { id: "expand", troops_percent: 30 },
        { id: "not_on_the_menu", troops_percent: 10 },
      ]),
    ).takeTurn({ ...p, events: [] });
    expect(turn.orders.map((o) => o.id)).toEqual(["expand"]);
    const intent = turn.orders[0].intent as { type: string; troops: number };
    expect(intent.type).toBe("attack");
    expect(intent.troops).toBeCloseTo(p.g.me.troops() * 0.3, -1);
  });

  it("keeps the plan's reserve: orders never take the army below it", async () => {
    // 30% of the maximum at home, a 25% reserve: at most (30 - 25) / 30 = 16% may leave.
    const p = await position((s) => ({ ...s, me: { ...s.me, troops: Math.round(s.me.troopCap * 0.3) } }));
    const turn = await player(new ScriptedLLM([{ id: "expand", troops_percent: 30 }])).takeTurn({ ...p, events: [] });
    expect(turn.rules.reserveAllowsPercent).toBe(16);
    expect(turn.orders[0]).toMatchObject({ id: "expand", troopsPercent: 16, requestedPercent: 30, limitedBy: "reserve" });

    const low = await position((s) => ({ ...s, me: { ...s.me, troops: Math.round(s.me.troopCap * 0.2) } }));
    const empty = await player(new ScriptedLLM([{ id: "expand", troops_percent: 30 }, { id: "wait", troops_percent: 0 }])).takeTurn({ ...low, events: [] });
    expect(empty.rules.allowedPercent).toBe(0);
    expect(empty.orders.map((o) => o.id)).toEqual(["wait"]); // the troop order is dropped
  });

  it("counts the troop budget across turns, whatever the cadence", async () => {
    const p = await position((s) => ({ ...s, me: { ...s.me, troops: Math.round(s.me.troopCap * 0.9) } }));
    const agent = player(new ScriptedLLM([{ id: "expand", troops_percent: 40 }]));
    const at = (seconds: number) => agent.takeTurn({ ...p, snap: { ...p.snap, seconds }, events: [] });
    expect((await at(40)).orders[0].troopsPercent).toBe(40);
    expect((await at(41)).orders[0]).toMatchObject({ troopsPercent: 20, limitedBy: "budget" }); // 60 - 40 left
    expect((await at(42)).orders).toEqual([]); // budget spent until the window moves on
    expect((await at(46)).orders[0].troopsPercent).toBe(40); // 5 s later, the 40% of 0:40 left the window
  });

  it("scales several orders together to fit the troop rules", async () => {
    const p = await position((s) => ({ ...s, me: { ...s.me, troops: Math.round(s.me.troopCap * 0.9) } }));
    const turn = await player(new ScriptedLLM([{ id: "expand", troops_percent: 50 }, { id: p.attack, troops_percent: 40 }])).takeTurn({ ...p, events: [] });
    expect(turn.orders.map((o) => o.troopsPercent)).toEqual([33, 26]); // 90% asked, 60% allowed
    expect(turn.orders.every((o) => o.limitedBy === "budget")).toBe(true);
  });

  it("uses the default share when a troop order comes with 0%", async () => {
    const p = await position();
    const turn = await player(new ScriptedLLM([{ id: "expand", troops_percent: 0 }])).takeTurn({ ...p, events: [] });
    expect(turn.orders[0].troopsPercent).toBe(20);
  });
});
