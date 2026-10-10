import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import type { MapFiles, MapManifest } from "@openfront/engine-api/game/MapFiles";
import {
  GameConfigSchema,
  GameStartInfo,
  GameStartInfoSchema,
  Intent,
  StampedIntent,
} from "@openfront/engine-api/Schemas";
import type { Game, Player } from "@openfront/engine/game/Game";
import { createGameRunner, GameRunner } from "@openfront/engine/GameRunner";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VENDOR = path.join(ROOT, "vendor/OpenFrontIO");

/** The game to play. Everything except the map is a normal OpenFront lobby option. */
export const GameSettingsSchema = z.object({
  map: z.string().default("Australia"),
  /** "Compact" is the game's own smaller version of a map (1/4 of the tiles): faster games. */
  mapSize: z.enum(["Normal", "Compact"]).default("Compact"),
  difficulty: z.enum(["Easy", "Medium", "Hard", "Impossible"]).default("Medium"),
  /** The map's nations (the game's strong AI): "default" = all of them. */
  nations: z.union([z.literal("default"), z.literal("disabled"), z.number().int().min(1)]).default("default"),
  /** Tribes (the game's weak AI), spawned at random. */
  bots: z.number().int().min(0).max(400).default(20),
  /** The engine seeds all its randomness from the game id, so the seed fixes the game. */
  seed: z.string().default("australia-1"),
  playerName: z.string().min(3).max(27).default("Qwen"),
});
export type GameSettings = z.output<typeof GameSettingsSchema>;

/** The LLM's seat. Client ids are 8-10 alphanumerics on the wire. */
const CLIENT_ID = "llmplayer1";

/**
 * One OpenFront game run headless, in this process, with one external player
 * (the LLM) against the game's own AI.
 *
 * It drives the engine through its production entry points, exactly like the
 * browser does: createGameRunner -> addTurn -> executeNextTick. One turn is one
 * tick, 100 ms of game time. Game time only moves when `advance` is called, so
 * the game waits while the LLM thinks.
 */
export class OpenFrontGame {
  /** Engine warnings and errors (rejected orders are reported this way). */
  readonly engineLog: { tick: number; message: string }[] = [];
  error: string | null = null;
  private pending: StampedIntent[] = [];
  private turnNumber = 0;

  private constructor(
    readonly settings: GameSettings,
    readonly gameStart: GameStartInfo,
    private runner: GameRunner,
  ) {}

  static async create(input: Partial<GameSettings> = {}): Promise<OpenFrontGame> {
    const settings = GameSettingsSchema.parse(input);
    const gameStart = buildGameStart(settings);
    const files = loadMapFiles(gameStart.config.gameMap, gameStart.config.gameMapSize);
    let self: OpenFrontGame | null = null;
    const runner = await quietly(
      (m) => self?.log(m),
      () =>
        createGameRunner(gameStart, undefined, files, (update) => {
          if ("errMsg" in update && self !== null) self.error = update.errMsg;
        }),
    );
    self = new OpenFrontGame(settings, gameStart, runner);
    return self;
  }

  /** The full engine state (players, map, units). */
  get game(): Game {
    return this.runner.game;
  }

  /** The LLM's player. */
  get me(): Player {
    const p = this.game.playerByClientID(CLIENT_ID);
    if (p === null) throw new Error("the LLM player is missing");
    return p;
  }

  tick(): number {
    return this.game.ticks();
  }

  seconds(): number {
    return (this.game.ticks() * this.game.config().msPerTick()) / 1000;
  }

  inSpawnPhase(): boolean {
    return this.game.inSpawnPhase();
  }

  /** The winning player once someone holds more than 80% of the land. */
  winner(): Player | null {
    const w = this.game.getWinner();
    return w !== null && typeof w !== "string" ? w : null;
  }

  /** Queues an order from the LLM's player; it travels in the next turn. */
  submit(intent: Intent): void {
    this.pending.push({ ...intent, clientID: CLIENT_ID } as StampedIntent);
  }

  /** Runs `ticks` turns. Queued orders go into the first one. */
  advance(ticks = 1): void {
    quietly(
      (m) => this.log(m),
      () => {
        for (let i = 0; i < ticks && this.error === null && this.winner() === null; i++) {
          this.runner.addTurn({ turnNumber: this.turnNumber++, intents: this.pending });
          this.pending = [];
          this.runner.executeNextTick();
        }
      },
    );
  }

  private log(message: string): void {
    this.engineLog.push({ tick: this.runner?.game.ticks() ?? 0, message });
    if (this.engineLog.length > 500) this.engineLog.shift();
  }
}

/** The lobby description the game server would send to every client. */
function buildGameStart(s: GameSettings): GameStartInfo {
  const mapType = Object.values(GameMapType).find(
    (m) => String(m).toLowerCase() === s.map.toLowerCase(),
  );
  if (mapType === undefined) throw new Error(`unknown map "${s.map}"`);
  const config = GameConfigSchema.parse({
    gameMap: mapType,
    gameMapSize: s.mapSize === "Compact" ? GameMapSize.Compact : GameMapSize.Normal,
    gameMode: GameMode.FFA,
    // Singleplayer, like playing against the AI in the browser: the spawn
    // phase ends as soon as the human player has chosen a spawn.
    gameType: GameType.Singleplayer,
    difficulty: Difficulty[s.difficulty],
    nations: s.nations,
    bots: s.bots,
    donateGold: false,
    donateTroops: false,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  });
  return GameStartInfoSchema.parse({
    gameID: seedToGameID(s.seed),
    lobbyCreatedAt: 0,
    config,
    players: [{ clientID: CLIENT_ID, username: s.playerName, clanTag: null }],
  });
}

/** Game ids are 8 alphanumerics; any seed string is hashed into one. */
export function seedToGameID(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).padEnd(8, "0").slice(0, 8);
}

/** Reads a map from vendor/OpenFrontIO/resources/maps, like the browser's map loader. */
function loadMapFiles(map: GameMapType, size: GameMapSize): MapFiles {
  const key = Object.keys(GameMapType).find((k) => GameMapType[k as keyof typeof GameMapType] === map)!;
  const dir = path.join(VENDOR, "resources/maps", key.toLowerCase());
  if (!fs.existsSync(dir)) {
    throw new Error(`map files missing in ${dir}: run \`MAPS="${key.toLowerCase()}" npm run setup\``);
  }
  const read = (f: string) => new Uint8Array(fs.readFileSync(path.join(dir, f)));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as MapManifest;
  return size === GameMapSize.Normal
    ? { map, mapSize: size, manifest, mapBin: read("map.bin"), map4xBin: read("map4x.bin") }
    : { map, mapSize: size, manifest, map4xBin: read("map4x.bin"), map16xBin: read("map16x.bin") };
}

/**
 * The engine reports rejected orders and problems only through console.*;
 * while `fn` runs, that output goes to `sink` instead of the terminal.
 */
function quietly<T>(sink: (message: string) => void, fn: () => T): T {
  const levels = ["log", "info", "warn", "error", "debug"] as const;
  const saved = levels.map((l) => console[l]);
  for (const l of levels) {
    console[l] = (...args: unknown[]) => {
      if (l === "warn" || l === "error") sink(args.map(String).join(" "));
    };
  }
  const restore = () => levels.forEach((l, i) => (console[l] = saved[i]));
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (e) {
    restore();
    throw e;
  }
}
