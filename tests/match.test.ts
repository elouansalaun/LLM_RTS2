import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockLLM } from "../src/llm/mock";
import { MatchConfigSchema, playMatch, TurnRecord } from "../src/match";

describe("a full match with a stand-in LLM", () => {
  it("spawns, plays, and writes turns, maps and a report", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "llm-rts-"));
    const config = MatchConfigSchema.parse({ game: { bots: 10 }, maxMinutes: 2, mapEveryMinutes: 1 });
    const mock = new MockLLM();
    const result = await playMatch(config, mock, { outDir: out });

    expect(result.outcome).toBe("time limit");
    expect(result.seconds).toBeGreaterThanOrEqual(120);
    expect(result.me.tiles).toBeGreaterThan(0);
    const turns = fs.readFileSync(path.join(out, "turns.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as TurnRecord);
    expect(turns.length).toBe(result.turns);
    expect(turns[0].orders[0].id).toMatch(/^spawn_/);
    expect(turns[0].strategist?.trigger).toBe("choosing a start");
    // The strategist runs far less often than the commander.
    const plans = turns.filter((t) => t.strategist !== null).length;
    expect(plans).toBeGreaterThan(2);
    expect(plans).toBeLessThan(turns.length / 2);
    // Prompts carry the graph, the troop rules and the knowledge base.
    expect(turns[1].commander.user).toContain("Your land neighbours");
    expect(turns[1].commander.user).toContain("## Troop rules now");
    expect(turns.find((t) => t.strategist && t.seconds > 0)!.strategist!.user).toContain("## Knowledge base excerpts");
    for (const f of ["report.md", "summary.json", "final.png", "map-01min.png"]) expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    expect(fs.readFileSync(path.join(out, "report.md"), "utf8")).toContain("## The strategist's plans");
  });
});
