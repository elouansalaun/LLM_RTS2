import type { Intent } from "@openfront/engine-api/Schemas";
import { z } from "zod";
import { DEFAULT_TROOP_PERCENT, MenuOption, TROOP_PERCENTS } from "../actions/menu";
import { KnowledgeSection, Phase, phaseOf, retrieve, situationTags } from "../knowledge/kb";
import type { ChatRequest, ChatResult, LLM } from "../llm/lmstudio";
import { clock, fmt, Graph, neighboursOf, UNCLAIMED } from "../state/graph";
import type { Snapshot } from "../state/observe";
import type { GameEvent } from "./events";
import {
  commanderSchema,
  commanderSystem,
  commanderUser,
  Plan,
  PRIORITIES,
  RESERVE_PERCENTS,
  strategistSchema,
  strategistSystem,
  strategistUser,
  TroopRules,
  WAVE_PERCENTS,
} from "./prompts";

export const AgentSettingsSchema = z
  .object({
    /** Game seconds between two turns (the code checks the game; the LLM is not always called). */
    decisionEverySeconds: z.number().positive().default(5),
    /** Game seconds between two scheduled strategist plans (major events re-plan sooner). */
    strategistEverySeconds: z.number().positive().default(30),
    /** A major event re-plans only if the current plan is at least this old (game seconds). */
    replanAfterSeconds: z.number().min(0).default(15),
    /** Orders the commander may give per call. */
    maxActions: z.number().int().min(1).max(4).default(2),
    /** Knowledge sections given to the strategist, besides the core rules. */
    knowledgeSections: z.number().int().min(0).max(20).default(6),
    /**
     * Troop budget: at most this share of the army leaves per window of game
     * time, counted across turns, so the decision cadence does not change it.
     * I first had a per-turn limit, and at a 1-second cadence it drained the
     * army in 10 s.
     */
    troopBudgetPercent: z.number().min(10).max(100).default(60),
    troopBudgetWindowSeconds: z.number().positive().default(5),
    /**
     * Reserve floor: the lowest reserve the strategist may choose, as a share of
     * the troop maximum (it chooses between this and 40%). Troop orders never
     * take the army below the plan's reserve. I added it because the model kept
     * citing "keep troops near 40%" while sitting at 0%. In my offline tests,
     * 25% kept the army safe without slowing the opening; 50% blocked all
     * expansion for the first 10 seconds.
     */
    minReservePercent: z.number().min(0).max(40).default(20),
    /** The commander is called when something changes, and at least this often (game seconds). */
    commanderHeartbeatSeconds: z.number().positive().default(15),
    /** Send orders that break the troop rules back to the commander once, with the numbers. */
    selfCheck: z.boolean().default(true),
  })
  // An event re-plan that waits longer than the scheduled plan can never fire.
  .transform((s) => ({ ...s, replanAfterSeconds: Math.min(s.replanAfterSeconds, s.strategistEverySeconds) }));
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

export type CommanderCall = LLMCall & { reason: string };

export interface CommanderTurn extends CommanderCall {
  /** Why the commander was called this turn. */
  why: string[];
  /** The second answer, when the first broke the troop rules (self-check). */
  revision: CommanderCall | null;
}

export interface Order {
  id: string;
  troopsPercent: number;
  /** What was asked, when the troop rules reduced it. */
  requestedPercent?: number;
  /** Which rule reduced it. */
  limitedBy?: "reserve" | "budget";
  /** Launched by the code from the plan (expansion waves), not by the commander. */
  standing?: boolean;
  label: string;
  intent: Intent | null;
}

export interface Turn {
  tick: number;
  seconds: number;
  strategist: StrategistTurn | null;
  /** null when nothing changed: no LLM call, the standing orders run. */
  commander: CommanderTurn | null;
  rules: TroopRules & { budgetLeftPercent: number; reserveAllowsPercent: number };
  orders: Order[];
}

const StrategistAnswer = z.object({
  assessment: z.string(),
  plan: z.string(),
  priorities: z.array(z.enum(PRIORITIES)).min(1),
  focus: z.string(),
  reserve_percent: z.number(),
  wave_percent: z.number(),
  knowledge_used: z.array(z.string()),
});

const CommanderAnswer = z.object({
  reason: z.string(),
  actions: z.array(z.object({ id: z.string(), troops_percent: z.number() })),
});

interface Chosen {
  option: MenuOption;
  pct: number;
  standing?: boolean;
}

/**
 * The LLM player: two roles played by the same local model, and the code
 * that enforces the plan between their calls.
 *
 * - The strategist runs rarely (every 30 s of game time, or on a major event).
 *   It reads the situation, the map graph and the knowledge base excerpts that
 *   match the situation, and writes a plan: priorities, a focus, the reserve
 *   to keep and the size of the expansion waves.
 * - The commander is called only when something changed (a new plan, an
 *   attack, a new option on the menu) or every 15 s. It picks up to 2 orders.
 * - Between calls, the code feeds the plan's expansion waves, and every troop
 *   order respects the plan's reserve and a troop budget per 5 s.
 *
 * In my games the 9B model was decent at broad plans and bad at repeating
 * small orders on time, so the model plans and the code does the repetition.
 */
export class LLMPlayer {
  plan: Plan | null = null;
  private core: KnowledgeSection[];
  private reserves: number[];
  /** Events since the last plan / the last commander call. */
  private sincePlan: string[] = [];
  private sinceCommander: string[] = [];
  /** When the commander was last called, and the menu it saw then. */
  private lastCommander: { seconds: number; menuIds: Set<string> } | null = null;
  /** Troop shares sent recently, for the budget window. */
  private sent: { seconds: number; percent: number }[] = [];
  /** The last orders, as the commander reads them. */
  private history: string[] = [];

  constructor(
    readonly llm: LLM,
    readonly kb: KnowledgeSection[],
    readonly settings: AgentSettings,
  ) {
    this.core = kb.filter((s) => s.tags.includes("core"));
    const allowed = RESERVE_PERCENTS.filter((r) => r >= settings.minReservePercent);
    this.reserves = allowed.length > 0 ? [...allowed] : [RESERVE_PERCENTS.at(-1)!];
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
    this.sinceCommander.push(...input.events.filter((e) => !e.routine).map((e) => e.text));

    const trigger = this.strategistTrigger(snap, input.events);
    const strategist = trigger === null ? null : await this.runStrategist(trigger, input);
    const rules = this.troopRules(snap);

    let commander: CommanderTurn | null = null;
    let chosen: Chosen[] = [];
    const why = this.commanderWhy(snap, input.events, menu, strategist !== null);
    if (why.length > 0) {
      const first = await this.runCommander(input, why, rules);
      commander = { ...first, why, revision: null };
      chosen = this.parse(first.answer, menu);
      // Self-check: orders that break the troop rules go back once, with the numbers.
      const asked = troopTotal(chosen);
      if (this.settings.selfCheck && !snap.spawnPhase && asked > rules.allowedPercent + 10) {
        const revision = await this.runCommander(input, why, rules, this.feedback(asked, rules, snap));
        commander.revision = revision;
        const revised = this.parse(revision.answer, menu);
        if (revision.error === null && revised.length > 0) chosen = revised;
      }
      this.lastCommander = { seconds: snap.seconds, menuIds: new Set(menu.map((o) => o.id)) };
      this.sinceCommander = [];
    }

    chosen.push(...this.standingOrders(snap, menu, chosen));
    const orders = this.applyRules(chosen, rules, snap, menu);
    for (const o of orders) this.history.push(`${clock(snap.seconds)} ${describeOrder(o)}`);
    this.history = this.history.slice(-5);
    return { tick: snap.tick, seconds: snap.seconds, strategist, commander, rules, orders };
  }

  // ── when each role runs ──

  private strategistTrigger(snap: Snapshot, events: GameEvent[]): string | null {
    if (this.plan === null) return snap.spawnPhase ? "choosing a start" : "first plan";
    // Rounded: game time advances in 0.1 s ticks, and 90.6 - 60.6 is not exactly 30 in floating point.
    const age = Math.round((snap.seconds - this.plan.seconds) * 10) / 10;
    if (age >= this.settings.strategistEverySeconds) return "scheduled";
    const major = events.find((e) => e.major);
    if (major !== undefined && age >= this.settings.replanAfterSeconds) return `event: ${major.text}`;
    return null;
  }

  /** Reasons to call the commander now; none means the standing orders are enough. */
  private commanderWhy(snap: Snapshot, events: GameEvent[], menu: MenuOption[], newPlan: boolean): string[] {
    if (snap.spawnPhase) return ["the game starts: choose where"];
    if (this.lastCommander === null) return ["first orders"];
    const why: string[] = [];
    if (newPlan) why.push("a new plan");
    for (const e of events.filter((x) => !x.routine).slice(0, 3)) why.push(e.text.replace(/\.$/, ""));
    const seen = this.lastCommander.menuIds;
    const fresh = menu.map((o) => o.id).filter((id) => id !== "wait" && !seen.has(id));
    if (fresh.length > 0) why.push(`new options on the menu: ${fresh.slice(0, 4).join(", ")}`);
    const silent = Math.round((snap.seconds - this.lastCommander.seconds) * 10) / 10;
    if (why.length === 0 && silent >= this.settings.commanderHeartbeatSeconds) why.push("regular check");
    return why;
  }

  // ── the troop rules ──

  /** How many troops may leave now: the plan's reserve and the budget window, whichever is tighter. */
  private troopRules(snap: Snapshot): Turn["rules"] {
    const reservePercent = Math.max(this.settings.minReservePercent, this.plan?.reserve_percent ?? this.settings.minReservePercent);
    const reserveTroops = (snap.me.troopCap * reservePercent) / 100;
    const troops = snap.me.troops;
    const reserveAllowsPercent = troops > 0 ? Math.max(0, Math.floor((100 * (troops - reserveTroops)) / troops)) : 0;
    const windowStart = snap.seconds - this.settings.troopBudgetWindowSeconds;
    this.sent = this.sent.filter((s) => s.seconds > windowStart + 0.01);
    const budgetLeftPercent = Math.max(0, this.settings.troopBudgetPercent - this.sent.reduce((n, s) => n + s.percent, 0));
    const allowedPercent = Math.min(reserveAllowsPercent, budgetLeftPercent);
    return {
      reservePercent,
      reserveTroops: Math.round(reserveTroops),
      allowedPercent,
      allowedTroops: Math.round((troops * allowedPercent) / 100),
      budgetLeftPercent,
      reserveAllowsPercent,
    };
  }

  private feedback(asked: number, rules: Turn["rules"], snap: Snapshot): string {
    const window = this.settings.troopBudgetWindowSeconds;
    const cause =
      rules.reserveAllowsPercent <= rules.budgetLeftPercent
        ? `you keep a reserve of ${rules.reservePercent}% of your maximum (${fmt(rules.reserveTroops)} troops) and you have ${fmt(snap.me.troops)}`
        : `at most ${this.settings.troopBudgetPercent}% of your army may leave per ${window} s of game time, and ${this.settings.troopBudgetPercent - rules.budgetLeftPercent}% already left in the last ${window} s`;
    const limit = rules.allowedPercent > 0 ? `at most ${rules.allowedPercent}% can leave now` : "no troops can leave now";
    return `You asked to send ${asked}% of your troops in total, but ${limit}: ${cause}. Give your orders again within the limit: send less, choose orders that do not send troops (build, alliance), or wait.`;
  }

  /**
   * The plan's standing order: while unclaimed land touches us, feed the
   * expansion with the plan's wave share on every turn; the troop rules decide
   * how much really leaves. (I used to wait for each wave to end before
   * sending the next. That was slower: a wave made small by the reserve runs
   * for a long time and holds up the next one.)
   */
  private standingOrders(snap: Snapshot, menu: MenuOption[], chosen: Chosen[]): Chosen[] {
    if (snap.spawnPhase || this.plan === null || this.plan.wave_percent <= 0) return [];
    const expand = menu.find((o) => o.id === "expand");
    if (expand === undefined || chosen.some((c) => c.option.id === "expand")) return [];
    return [{ option: expand, pct: this.plan.wave_percent, standing: true }];
  }

  /** Applies the troop rules to all orders together, then records what left. */
  private applyRules(chosen: Chosen[], rules: Turn["rules"], snap: Snapshot, menu: MenuOption[]): Order[] {
    const asked = troopTotal(chosen);
    const scale = asked > rules.allowedPercent ? rules.allowedPercent / asked : 1;
    const limitedBy = rules.reserveAllowsPercent <= rules.budgetLeftPercent ? "reserve" : "budget";
    const orders: Order[] = [];
    for (const { option, pct, standing } of chosen) {
      const final = option.usesTroops ? Math.floor(pct * scale) : 0;
      if (option.usesTroops && final < 1) continue; // nothing may leave: the order is dropped
      orders.push({
        id: option.id,
        troopsPercent: final,
        ...(option.usesTroops && final !== pct ? { requestedPercent: pct, limitedBy } : {}),
        ...(standing ? { standing: true } : {}),
        label: option.label,
        intent: option.toIntent(final),
      });
    }
    const sent = orders.reduce((n, o) => n + (sendsTroops(o) ? o.troopsPercent : 0), 0);
    if (sent > 0) this.sent.push({ seconds: snap.seconds, percent: sent });

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

  // ── the LLM calls ──

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
      system: strategistSystem(this.core, this.reserves),
      user: strategistUser({
        situation: input.situation,
        events: this.sincePlan.slice(-12),
        previous: this.plan,
        knowledge,
        ...(snap.spawnPhase ? { spawnOptions: input.menu } : {}),
      }),
      schema: strategistSchema(focus, knowledge.map((k) => k.title), this.reserves),
      schemaName: "strategist_plan",
    };
    const call = await callWithRetry(this.llm, request);
    const parsed = StrategistAnswer.safeParse(call.answer);
    if (parsed.success) {
      const d = parsed.data;
      this.plan = {
        ...d,
        priorities: d.priorities.slice(0, 3),
        reserve_percent: this.reserves.includes(d.reserve_percent) ? d.reserve_percent : this.reserves[0],
        wave_percent: (WAVE_PERCENTS as readonly number[]).includes(d.wave_percent) ? d.wave_percent : 30,
        seconds: snap.seconds,
      };
      this.sincePlan = [];
    } else if (this.plan === null) {
      // No usable plan yet: start from a neutral default rather than nothing.
      this.plan = {
        assessment: "No plan could be made.",
        plan: "Expand into unclaimed land and build a city when affordable.",
        priorities: ["expand", "economy"],
        focus: UNCLAIMED,
        reserve_percent: this.reserves.find((r) => r >= 30) ?? this.reserves[0],
        wave_percent: 30,
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

  private async runCommander(
    input: { menu: MenuOption[]; situation: string },
    why: string[],
    rules: TroopRules,
    feedback?: string,
  ): Promise<CommanderCall> {
    const request: ChatRequest = {
      system: commanderSystem(this.core, this.settings.maxActions),
      user: commanderUser({
        plan: this.plan,
        planKnowledge: this.kb.filter((s) => this.plan?.knowledge_used.includes(s.title)),
        situation: input.situation,
        events: this.sinceCommander.slice(-10),
        menu: input.menu,
        why,
        rules,
        lastOrders: this.history,
        ...(feedback ? { feedback } : {}),
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

  /** The commander's answer as menu options, keeping only valid, distinct ids. */
  private parse(answer: unknown, menu: MenuOption[]): Chosen[] {
    const parsed = CommanderAnswer.safeParse(answer);
    const byId = new Map(menu.map((o) => [o.id, o]));
    const chosen: Chosen[] = [];
    for (const a of parsed.success ? parsed.data.actions : []) {
      const option = byId.get(a.id);
      if (option === undefined || chosen.some((c) => c.option.id === a.id) || chosen.length >= this.settings.maxActions) continue;
      const valid = (TROOP_PERCENTS as readonly number[]).includes(a.troops_percent) && a.troops_percent > 0;
      chosen.push({ option, pct: option.usesTroops ? (valid ? a.troops_percent : DEFAULT_TROOP_PERCENT) : 0 });
    }
    return chosen;
  }
}

/** Whether an order sends troops (attacks, expansions and boats). */
function sendsTroops(o: Order): boolean {
  return o.intent?.type === "attack" || o.intent?.type === "boat";
}

function troopTotal(chosen: Chosen[]): number {
  return chosen.reduce((n, c) => n + (c.option.usesTroops ? c.pct : 0), 0);
}

function describeOrder(o: Order): string {
  const troops = sendsTroops(o) ? ` ${o.troopsPercent}%` : "";
  const notes = [
    ...(o.standing ? ["standing order from the plan"] : []),
    ...(o.requestedPercent !== undefined ? [`asked ${o.requestedPercent}%, reduced by the ${o.limitedBy}`] : []),
  ];
  return `${o.id}${troops}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
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
