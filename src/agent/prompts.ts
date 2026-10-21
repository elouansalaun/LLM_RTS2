import type { MenuOption } from "../actions/menu";
import { TROOP_PERCENTS } from "../actions/menu";
import { KnowledgeSection, renderSection } from "../knowledge/kb";
import { clock } from "../state/graph";

export const PRIORITIES = ["expand", "attack", "defend", "economy", "diplomacy", "naval"] as const;

export interface Plan {
  assessment: string;
  plan: string;
  priorities: string[];
  focus: string;
  knowledge_used: string[];
  /** Game time when the plan was written. */
  seconds: number;
}

const GAME = "OpenFront is a real-time strategy game: players conquer territory on a map by sending troops, build cities and ports with gold, and make or break alliances. You play one player against the game's own AI: nations (strong) and tribes (weak).";

function coreRules(core: KnowledgeSection[]): string {
  return core.map((s) => s.text).join("\n");
}

// ── strategist ──

export function strategistSystem(core: KnowledgeSection[]): string {
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
    '- "assessment": one or two sentences on the situation: the main threat and the main opportunity.',
    '- "plan": what to do for the next 30 seconds, in one to three short sentences. Be concrete: name the target and the share of your troops to send, as a percentage (for example "attack Fijian Territory with 30% of the troops").',
    `- "priorities": one to three of ${PRIORITIES.join(", ")}, most important first.`,
    '- "focus": the one player that matters most right now (to attack or to watch), "unclaimed", or "none".',
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
    parts.push("", `## Your previous plan (written at ${clock(input.previous.seconds)})`, input.previous.plan);
  }
  parts.push("", "## Knowledge base excerpts", ...input.knowledge.map(renderSection));
  return parts.join("\n");
}

export function strategistSchema(focusOptions: string[], titles: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      assessment: { type: "string" },
      plan: { type: "string" },
      priorities: { type: "array", items: { type: "string", enum: [...PRIORITIES] }, minItems: 1, maxItems: 3 },
      focus: { type: "string", enum: focusOptions },
      knowledge_used: { type: "array", items: { type: "string", enum: titles.length > 0 ? titles : ["none"] }, maxItems: 3 },
    },
    required: ["assessment", "plan", "priorities", "focus", "knowledge_used"],
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
    '- "reason": one short sentence: why these orders.',
    `- "actions": 0 to ${maxActions} orders. Each is {"id": an option id from the menu, "troops_percent": the share of your current troops to send, in %}.`,
    "  For options marked [sends troops], choose troops_percent from the plan and the situation: 20-30 is a normal expansion wave, 40-60 a serious attack. For all other options put 0.",
    "Running attacks continue on their own: only repeat one to send more troops. Choosing nothing (or \"wait\") is fine when the running orders already follow the plan.",
  ].join("\n");
}

export function commanderUser(input: {
  plan: Plan | null;
  /** The knowledge sections the plan cites: the commander applies them too. */
  planKnowledge: KnowledgeSection[];
  situation: string;
  events: string[];
  menu: MenuOption[];
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
  parts.push("", "## Menu", ...input.menu.map((o) => `- ${o.id}: ${o.label}${o.usesTroops ? " [sends troops]" : ""}`));
  return parts.join("\n");
}

export function commanderSchema(menu: MenuOption[], maxActions: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      reason: { type: "string" },
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
        maxItems: maxActions,
      },
    },
    required: ["reason", "actions"],
    additionalProperties: false,
  };
}
