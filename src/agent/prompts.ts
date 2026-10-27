import type { MenuOption } from "../actions/menu";
import { TROOP_PERCENTS } from "../actions/menu";
import { KnowledgeSection, renderSection } from "../knowledge/kb";
import { clock } from "../state/graph";

export const PRIORITIES = ["expand", "attack", "defend", "economy", "diplomacy", "naval"] as const;

/**
 * Reserves the strategist may choose: share of the troop maximum always kept
 * at home. Only the values at or above minReservePercent are offered, so 0
 * (no floor) exists only when the setting allows it.
 */
export const RESERVE_PERCENTS = [0, 25, 30, 40, 50, 60] as const;

export interface Plan {
  assessment: string;
  plan: string;
  priorities: string[];
  focus: string;
  /** Share of the troop maximum to keep at home; the code enforces it. */
  reserve_percent: number;
  knowledge_used: string[];
  /** Game time when the plan was written. */
  seconds: number;
}

const GAME = "OpenFront is a real-time strategy game: players conquer territory on a map by sending troops, build cities and ports with gold, and make or break alliances. You play one player against the game's own AI: nations (strong) and tribes (weak).";

function coreRules(core: KnowledgeSection[]): string {
  return core.map((s) => s.text).join("\n");
}

// ── strategist ──

export function strategistSystem(core: KnowledgeSection[], reserves: readonly number[]): string {
  return [
    GAME,
    "",
    "You are the STRATEGIST. Every 30 seconds of game time, and whenever something important happens, you study the situation and write a short plan. A separate commander reads your plan and gives the concrete orders.",
    "",
    "How the game works:",
    coreRules(core),
    "",
    "You also get excerpts from a knowledge base. [fact] excerpts are verified game mechanics. [strategy idea] excerpts are ideas to weigh against the situation, not rules: use them when they fit.",
    "",
    "Answer with a JSON object:",
    '- "assessment": one or two sentences (at most 400 characters) on the situation: the main threat and the main opportunity.',
    '- "plan": what to do for the next 30 seconds, in one to three short sentences (at most 600 characters). Be concrete: name the target and the share of your troops to send, as a percentage (for example "attack Fijian Territory with 30% of the troops").',
    `- "priorities": one to three of ${PRIORITIES.join(", ")}, most important first.`,
    '- "focus": the one player that matters most right now (to attack or to watch), "unclaimed", or "none".',
    `- "reserve_percent": the share of your troop maximum to always keep at home, one of ${reserves.join(", ")}. Troops at home defend your land and keep growing; the commander cannot send troops below this reserve.`,
    '- "knowledge_used": the titles of the knowledge excerpts your plan relies on (up to three).',
  ].join("\n");
}

export function strategistUser(input: {
  situation: string;
  events: string[];
  previous: Plan | null;
  knowledge: KnowledgeSection[];
  spawnOptions?: MenuOption[];
}): string {
  const parts = ["## Situation", input.situation];
  if (input.spawnOptions) {
    parts.push("", "## Possible starting places", ...input.spawnOptions.map((o) => `- ${o.id}: ${o.label}`));
    parts.push("Your plan should say which start to pick and why.");
  }
  if (input.events.length > 0) parts.push("", "## What happened since the last plan", ...input.events.map((e) => `- ${e}`));
  if (input.previous) {
    const p = input.previous;
    parts.push(
      "",
      `## Your previous plan (written at ${clock(p.seconds)})`,
      p.plan,
      `Reserve: ${p.reserve_percent}% of the maximum.`,
    );
  }
  parts.push("", "## Knowledge base excerpts", ...input.knowledge.map(renderSection));
  return parts.join("\n");
}

export function strategistSchema(focusOptions: string[], titles: string[], reserves: readonly number[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      // LM Studio enforces maxLength while decoding. I added these after an answer
      // grew until the token limit and its JSON never closed (notebook 8, lesson 6).
      assessment: { type: "string", maxLength: 400 },
      plan: { type: "string", maxLength: 600 },
      priorities: { type: "array", items: { type: "string", enum: [...PRIORITIES] }, minItems: 1, maxItems: 3 },
      focus: { type: "string", enum: focusOptions },
      reserve_percent: { type: "integer", enum: [...reserves] },
      knowledge_used: { type: "array", items: { type: "string", enum: titles.length > 0 ? titles : ["none"] }, maxItems: 3 },
    },
    required: ["assessment", "plan", "priorities", "focus", "reserve_percent", "knowledge_used"],
    additionalProperties: false,
  };
}

// ── commander ──

export function commanderSystem(core: KnowledgeSection[], maxActions: number): string {
  return [
    GAME,
    "",
    "You are the COMMANDER. Every few seconds of game time you give orders by picking options from a menu. A strategist writes the plan: follow it, unless the situation changed since it was written (for example a new attack on you).",
    "",
    "How the game works:",
    coreRules(core),
    "",
    "Answer with a JSON object:",
    '- "reason": one short sentence (at most 240 characters): why these orders.',
    `- "actions": 1 to ${maxActions} orders. Each is {"id": an option id from the menu, "troops_percent": the share of your current troops to send, in %}.`,
    "  For options marked [sends troops], choose troops_percent from the plan and the situation: 20-30 is a normal wave, 40-60 a serious attack. For all other options put 0.",
    "  All orders draw on the same army: 30% + 30% sends 60% of it. The code enforces the troop rules given in your message (the plan's reserve, and how much may leave right now); orders above them are reduced.",
    "Running attacks continue on their own: only repeat one to send more troops. Choose \"wait\" when the running orders already follow the plan.",
  ].join("\n");
}

export interface TroopRules {
  reservePercent: number;
  reserveTroops: number;
  /** Share of the current troops that may leave now (after the reserve and the budget). */
  allowedPercent: number;
  allowedTroops: number;
}

export function commanderUser(input: {
  plan: Plan | null;
  /** The knowledge sections the plan cites: the commander applies them too. */
  planKnowledge: KnowledgeSection[];
  situation: string;
  events: string[];
  menu: MenuOption[];
  rules: TroopRules;
}): string {
  const parts: string[] = [];
  if (input.plan) {
    parts.push(
      `## Plan from the strategist (written at ${clock(input.plan.seconds)})`,
      `Priorities: ${input.plan.priorities.join(", ")}. Focus: ${input.plan.focus}.`,
      input.plan.plan,
      "",
    );
    if (input.planKnowledge.length > 0) {
      parts.push("## Knowledge the plan relies on", ...input.planKnowledge.map(renderSection), "");
    }
  }
  parts.push("## Situation now", input.situation);
  if (input.events.length > 0) parts.push("", "## What happened since your last orders", ...input.events.map((e) => `- ${e}`));
  const r = input.rules;
  parts.push(
    "",
    "## Troop rules now",
    `Keep at least ${r.reservePercent}% of your maximum (${fmtN(r.reserveTroops)} troops) at home: that is the plan's reserve.`,
    r.allowedPercent > 0
      ? `At most ${r.allowedPercent}% of your current troops (${fmtN(r.allowedTroops)}) can leave now, for all your orders together.`
      : "No troops can leave now: choose orders that do not send troops, or wait.",
  );
  parts.push("", "## Menu", ...input.menu.map((o) => `- ${o.id}: ${o.label}${o.usesTroops ? " [sends troops]" : ""}`));
  return parts.join("\n");
}

function fmtN(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function commanderSchema(menu: MenuOption[], maxActions: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      reason: { type: "string", maxLength: 240 },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: menu.map((o) => o.id) },
            troops_percent: { type: "integer", enum: [...TROOP_PERCENTS] },
          },
          required: ["id", "troops_percent"],
          additionalProperties: false,
        },
        // At least one order: "wait" is the explicit way to do nothing.
        minItems: 1,
        maxItems: maxActions,
      },
    },
    required: ["reason", "actions"],
    additionalProperties: false,
  };
}
