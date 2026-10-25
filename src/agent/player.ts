import type { Intent } from "@openfront/engine-api/Schemas";
import { z } from "zod";
import { DEFAULT_TROOP_PERCENT, MenuOption, TROOP_PERCENTS } from "../actions/menu";
import { KnowledgeSection, Phase, phaseOf, retrieve, situationTags } from "../knowledge/kb";
import type { ChatRequest, ChatResult, LLM } from "../llm/lmstudio";
import { Graph, neighboursOf, UNCLAIMED } from "../state/graph";
import type { Snapshot } from "../state/observe";
import type { GameEvent } from "./events";
import {
  commanderSchema,
  commanderSystem,
  commanderUser,
  Plan,
  PRIORITIES,
  strategistSchema,
  strategistSystem,
  strategistUser,
} from "./prompts";

export const AgentSettingsSchema = z.object({
  /** Game seconds between two commander turns. */
  decisionEverySeconds: z.number().positive().default(5),
  /** Game seconds between two scheduled strategist plans (major events re-plan sooner). */
  strategistEverySeconds: z.number().positive().default(30),
  /** A major event re-plans only if the current plan is at least this old (game seconds). */
  replanAfterSeconds: z.number().min(0).default(15),
  /** Orders the commander may give per turn. */
  maxActions: z.number().int().min(1).max(4).default(2),
  /** Knowledge sections given to the strategist, besides the core rules. */
  knowledgeSections: z.number().int().min(0).max(20).default(6),
  /**
   * Safety rule: the orders of one turn never send more than this share of the
   * troops in total; larger requests are scaled down. In my test games the
   * model sent 40% + 50% into two wars in the same turn, against its own plan.
   * 100 disables the rule.
   */
  maxTroopsPercentPerTurn: z.number().min(10).max(100).default(60),
});
export type AgentSettings = z.output<typeof AgentSettingsSchema>;

export interface LLMCall {
  system: string;
  user: string;
  answer: unknown;
  text: string;
  ms: number;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
}

export interface StrategistTurn extends LLMCall {
  trigger: string;
  phase: Phase;
  tags: string[];
  urgent: string[];
  knowledge: string[];
  plan: Plan;
}

export interface Order {
  id: string;
  troopsPercent: number;
  /** What the model asked for, when the safety rule scaled it down. */
  requestedPercent?: number;
  label: string;
  intent: Intent | null;
}

export interface Turn {
  tick: number;
  seconds: number;
  strategist: StrategistTurn | null;
  commander: LLMCall & { reason: string };
  orders: Order[];
}

const StrategistAnswer = z.object({
  assessment: z.string(),
  plan: z.string(),
  priorities: z.array(z.enum(PRIORITIES)).min(1),
  focus: z.string(),
  knowledge_used: z.array(z.string()),
});

const CommanderAnswer = z.object({
  reason: z.string(),
  actions: z.array(z.object({ id: z.string(), troops_percent: z.number() })),
});

/**
 * The LLM player: two roles played by the same local model.
 *
 * - The strategist runs rarely (every 30 s of game time, or on a major event).
 *   It reads the situation, the map graph and the knowledge base excerpts that
 *   match the situation, and writes a plan.
 * - The commander runs every turn (every 5 s). It reads the plan, the current
 *   situation and the menu of legal options, and picks up to 2 orders.
 *
 * Splitting the work keeps each prompt short and focused, which matters for a
 * 9B model: the commander does not have to re-derive the strategy every turn,
 * and the strategist does not have to deal with option ids.
 */
export class LLMPlayer {
  plan: Plan | null = null;
  private core: KnowledgeSection[];
  /** Events since the last plan: the strategist reads them all, not only the last turn's. */
  private sincePlan: string[] = [];

  constructor(
    readonly llm: LLM,
    readonly kb: KnowledgeSection[],
    readonly settings: AgentSettings,
  ) {
    this.core = kb.filter((s) => s.tags.includes("core"));
  }

  async takeTurn(input: {
    snap: Snapshot;
    graph: Graph;
    menu: MenuOption[];
    situation: string;
    events: GameEvent[];
  }): Promise<Turn> {
    const { snap, menu } = input;
    this.sincePlan.push(...input.events.map((e) => e.text));
    const trigger = this.strategistTrigger(snap, input.events);
    const strategist = trigger === null ? null : await this.runStrategist(trigger, input);
    const commander = await this.runCommander(input);
    return { tick: snap.tick, seconds: snap.seconds, strategist, commander, orders: this.orders(commander.answer, menu, snap) };
  }

  private strategistTrigger(snap: Snapshot, events: GameEvent[]): string | null {
    if (this.plan === null) return snap.spawnPhase ? "choosing a start" : "first plan";
    // Rounded: game time advances in 0.1 s ticks, and 90.6 - 60.6 is not exactly 30 in floating point.
    const age = Math.round((snap.seconds - this.plan.seconds) * 10) / 10;
    if (age >= this.settings.strategistEverySeconds) return "scheduled";
    const major = events.find((e) => e.major);
    if (major !== undefined && age >= this.settings.replanAfterSeconds) return `event: ${major.text}`;
    return null;
  }

  private async runStrategist(
    trigger: string,
    input: { snap: Snapshot; graph: Graph; menu: MenuOption[]; situation: string; events: GameEvent[] },
  ): Promise<StrategistTurn> {
    const { snap, graph } = input;
    const phase = phaseOf(snap);
    const situation = situationTags(snap, graph);
    const knowledge = retrieve(this.kb, situation, phase, this.settings.knowledgeSections).selected;
    const focus = [
      ...new Set([
        ...neighboursOf(graph, snap.me.key).map((n) => n.key).filter((k) => k !== UNCLAIMED),
        ...snap.others.filter((p) => p.kind === "nation").map((p) => p.key),
        UNCLAIMED,
        "none",
      ]),
    ];
    const request: ChatRequest = {
      system: strategistSystem(this.core),
      user: strategistUser({
        situation: input.situation,
        events: this.sincePlan.slice(-12),
        previous: this.plan,
        knowledge,
        ...(snap.spawnPhase ? { spawnOptions: input.menu } : {}),
      }),
      schema: strategistSchema(focus, knowledge.map((k) => k.title)),
      schemaName: "strategist_plan",
    };
    const call = await callWithRetry(this.llm, request);
    const parsed = StrategistAnswer.safeParse(call.answer);
    if (parsed.success) {
      this.plan = { ...parsed.data, priorities: parsed.data.priorities.slice(0, 3), seconds: snap.seconds };
      this.sincePlan = [];
    } else if (this.plan === null) {
      // No usable plan yet: start from a neutral default rather than nothing.
      this.plan = {
        assessment: "No plan could be made.",
        plan: "Expand into unclaimed land and build a city when affordable.",
        priorities: ["expand", "economy"],
        focus: UNCLAIMED,
        knowledge_used: [],
        seconds: snap.seconds,
      };
    }
    return {
      ...call,
      error: call.error ?? (parsed.success ? null : `invalid plan: ${parsed.error.issues[0]?.message}`),
      trigger,
      phase,
      tags: situation.tags,
      urgent: situation.urgent,
      knowledge: knowledge.map((k) => k.title),
      plan: this.plan,
    };
  }

  private async runCommander(input: {
    menu: MenuOption[];
    situation: string;
    events: GameEvent[];
  }): Promise<LLMCall & { reason: string }> {
    const request: ChatRequest = {
      system: commanderSystem(this.core, this.settings.maxActions, this.settings.maxTroopsPercentPerTurn),
      user: commanderUser({
        plan: this.plan,
        planKnowledge: this.kb.filter((s) => this.plan?.knowledge_used.includes(s.title)),
        situation: input.situation,
        events: input.events.map((e) => e.text),
        menu: input.menu,
      }),
      schema: commanderSchema(input.menu, this.settings.maxActions),
      schemaName: "commander_orders",
      maxTokens: 400,
    };
    const call = await callWithRetry(this.llm, request);
    const parsed = CommanderAnswer.safeParse(call.answer);
    return {
      ...call,
      error: call.error ?? (parsed.success ? null : `invalid orders: ${parsed.error.issues[0]?.message}`),
      reason: parsed.success ? parsed.data.reason : "",
    };
  }

  /** Turns the commander's answer into engine orders, keeping only valid, distinct menu ids. */
  private orders(answer: unknown, menu: MenuOption[], snap: Snapshot): Order[] {
    const parsed = CommanderAnswer.safeParse(answer);
    const byId = new Map(menu.map((o) => [o.id, o]));
    const seen = new Set<string>();
    const orders: Order[] = [];
    const chosen: { option: MenuOption; pct: number }[] = [];
    for (const a of parsed.success ? parsed.data.actions : []) {
      const option = byId.get(a.id);
      if (option === undefined || seen.has(a.id) || chosen.length >= this.settings.maxActions) continue;
      seen.add(a.id);
      const valid = (TROOP_PERCENTS as readonly number[]).includes(a.troops_percent) && a.troops_percent > 0;
      chosen.push({ option, pct: option.usesTroops ? (valid ? a.troops_percent : DEFAULT_TROOP_PERCENT) : 0 });
    }
    // All troop orders of a turn are computed on the same army: 40% + 50% sends 90% of it.
    const total = chosen.reduce((sum, c) => sum + c.pct, 0);
    const scale = total > this.settings.maxTroopsPercentPerTurn ? this.settings.maxTroopsPercentPerTurn / total : 1;
    for (const { option, pct } of chosen) {
      const final = Math.floor(pct * scale);
      orders.push({
        id: option.id,
        troopsPercent: final,
        ...(final !== pct ? { requestedPercent: pct } : {}),
        label: option.label,
        intent: option.toIntent(final),
      });
    }
    // The game cannot start without a spawn: fall back to the start the plan
    // names ("spawn_7"), else to the first candidate.
    if (snap.spawnPhase && !orders.some((o) => o.id.startsWith("spawn_")) && menu.length > 0) {
      const named = /spawn_\d+/.exec(this.plan?.plan ?? "")?.[0];
      const pick = menu.find((o) => o.id === named) ?? menu[0];
      orders.length = 0;
      orders.push({ id: pick.id, troopsPercent: 0, label: `${pick.label} (fallback)`, intent: pick.toIntent(0) });
    }
    return orders;
  }
}

/** One retry: a local model occasionally times out or gets cut off mid-answer. */
async function callWithRetry(llm: LLM, request: ChatRequest): Promise<LLMCall> {
  let lastError = "";
  let total = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = performance.now();
    try {
      const r: ChatResult = await llm.chat(request);
      return { system: request.system, user: request.user, answer: r.json, text: r.text, ms: total + r.ms, promptTokens: r.promptTokens, completionTokens: r.completionTokens, error: null };
    } catch (e) {
      total += Math.round(performance.now() - start);
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { system: request.system, user: request.user, answer: null, text: "", ms: total, promptTokens: null, completionTokens: null, error: lastError };
}
