import { spawnMenu } from "../src/actions/menu";
import { OpenFrontGame } from "../src/engine/game";

/** A started Australia game: the LLM's seat spawned on the given candidate, plus `ticks` of play. */
export async function startedGame(opts: { spawn?: number; ticks?: number; seed?: string } = {}): Promise<OpenFrontGame> {
  const g = await OpenFrontGame.create({ seed: opts.seed ?? "test-seed", bots: 10 });
  g.advance(1);
  const option = spawnMenu(g.game)[opts.spawn ?? 6];
  g.submit(option.toIntent(0)!);
  g.advance(5);
  if (opts.ticks) g.advance(opts.ticks);
  return g;
}
