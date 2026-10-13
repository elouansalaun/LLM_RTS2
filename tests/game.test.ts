import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { describe, expect, it } from "vitest";
import { OpenFrontGame, seedToGameID } from "../src/engine/game";
import { startedGame } from "./helpers";

describe("the headless engine", () => {
  it("creates an Australia game with the map's 7 nations and the requested tribes", async () => {
    const g = await OpenFrontGame.create({ bots: 10 });
    expect(g.game.width()).toBe(1000); // compact map
    g.advance(1);
    const nations = g.game.allPlayers().filter((p) => p.type() === PlayerType.Nation);
    expect(nations.map((p) => p.name()).sort()).toEqual(
      ["New South Wales", "Northern Territory", "Queensland", "South Australia", "Tasmania", "Victoria", "Western Australia"],
    );
    expect(g.me.name()).toBe("Qwen");
    expect(g.inSpawnPhase()).toBe(true);
  });

  it("ends the spawn phase when the LLM spawns, then runs the game", async () => {
    const g = await startedGame();
    expect(g.inSpawnPhase()).toBe(false);
    expect(g.me.numTilesOwned()).toBeGreaterThan(0);
    g.advance(300);
    expect(g.game.players().filter((p) => p.type() === PlayerType.Bot).length).toBe(10);
    expect(g.error).toBeNull();
  });

  it("is deterministic: same seed and same orders give the same game", async () => {
    const play = async () => {
      const g = await startedGame({ seed: "determinism" });
      g.submit({ type: "attack", targetID: null, troops: 5000 });
      g.advance(400);
      return g.game.players().map((p) => `${p.name()}:${p.numTilesOwned()}:${Math.round(p.troops())}`).join(",");
    };
    expect(await play()).toBe(await play());
  });

  it("turns any seed into a valid game id", () => {
    expect(seedToGameID("australia-1")).toMatch(/^[a-z0-9]{8}$/);
    expect(seedToGameID("a")).not.toBe(seedToGameID("b"));
  });
});
