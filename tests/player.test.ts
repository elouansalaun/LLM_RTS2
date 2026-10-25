import { describe, expect, it } from "vitest";
import { buildMenu } from "../src/actions/menu";
import { AgentSettingsSchema, LLMPlayer } from "../src/agent/player";
import { loadKnowledge } from "../src/knowledge/kb";
import type { ChatRequest, ChatResult, LLM } from "../src/llm/lmstudio";
import { buildGraph, describeSituation } from "../src/state/graph";
import { observe } from "../src/state/observe";
import { startedGame } from "./helpers";

/** An LLM that always gives the same answers: a fixed plan and fixed orders. */
class ScriptedLLM implements LLM {
  readonly name = "scripted";
  constructor(private orders: { id: string; troops_percent: number }[]) {}
  async chat(request: ChatRequest): Promise<ChatResult> {
    const json =
      request.schemaName === "strategist_plan"
        ? { assessment: "a", plan: "attack with everything", priorities: ["attack"], focus: "none", knowledge_used: [] }
        : { reason: "r", actions: this.orders };
    return { json, text: JSON.stringify(json), ms: 1, promptTokens: null, completionTokens: null };
  }
}

/** A started game at 40 s, with the inputs of one turn. */
async function position() {
  const g = await startedGame({ ticks: 400 });
  const snap = observe(g);
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

  it("scales down a turn that would send more than the safety limit", async () => {
    const p = await position();
    const turn = await player(new ScriptedLLM([{ id: "expand", troops_percent: 50 }, { id: p.attack, troops_percent: 40 }])).takeTurn({ ...p, events: [] });
    expect(turn.orders.map((o) => o.troopsPercent)).toEqual([33, 26]); // 90% asked, 60% allowed
    expect(turn.orders.map((o) => o.requestedPercent)).toEqual([50, 40]);
  });

  it("can disable the safety limit", async () => {
    const p = await position();
    const turn = await player(new ScriptedLLM([{ id: "expand", troops_percent: 50 }, { id: p.attack, troops_percent: 40 }]), {
      maxTroopsPercentPerTurn: 100,
    }).takeTurn({ ...p, events: [] });
    expect(turn.orders.map((o) => o.troopsPercent)).toEqual([50, 40]);
  });

  it("uses the default share when a troop order comes with 0%", async () => {
    const p = await position();
    const turn = await player(new ScriptedLLM([{ id: "expand", troops_percent: 0 }])).takeTurn({ ...p, events: [] });
    expect(turn.orders[0].troopsPercent).toBe(20);
  });
});
