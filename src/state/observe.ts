import { PlayerType, Relation, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { Game, Player } from "@openfront/engine/game/Game";
import type { OpenFrontGame } from "../engine/game";

export type PlayerKind = "you" | "nation" | "tribe" | "human";

/** One player as the LLM sees it. OpenFront has no fog of war: everything here is public. */
export interface PlayerView {
  /** Readable, unique and stable id used in prompts and action ids, e.g. "queensland". */
  key: string;
  /** The engine's player id. */
  id: string;
  name: string;
  kind: PlayerKind;
  tiles: number;
  /** Share of all land tiles, in %. */
  landPct: number;
  troops: number;
  gold: number;
  troopsPerTile: number;
  cities: number;
  ports: number;
  defensePosts: number;
  /** Where the territory's centre lies on the map ("north-east", "centre"…). */
  region: string;
  centre: { x: number; y: number };
  allied: boolean;
  /** How this nation feels about you (nations keep a relation to every player). */
  relation: "hostile" | "distrustful" | "neutral" | "friendly" | null;
  traitor: boolean;
}

export interface MeView extends PlayerView {
  alive: boolean;
  spawned: boolean;
  troopCap: number;
  troopsPctOfCap: number;
  rank: number;
  coastal: boolean;
  incomingAttacks: { from: string; troops: number }[];
  outgoingAttacks: { to: string; troops: number }[];
  boatsAtSea: number;
  allianceRequests: string[];
  alliances: { with: string; secondsLeft: number }[];
}

export interface Snapshot {
  tick: number;
  seconds: number;
  spawnPhase: boolean;
  me: MeView;
  /** Living opponents, largest first. */
  others: PlayerView[];
  unclaimedPct: number;
  playersAlive: number;
}

const RELATIONS = {
  [Relation.Hostile]: "hostile",
  [Relation.Distrustful]: "distrustful",
  [Relation.Neutral]: "neutral",
  [Relation.Friendly]: "friendly",
} as const;

/** Reads the game state from the LLM player's point of view. */
export function observe(g: OpenFrontGame): Snapshot {
  const game = g.game;
  const me = g.me;
  const keys = playerKeys(game);
  const land = game.numLandTiles();
  const centres = territoryCentres(game);

  const view = (p: Player): PlayerView => {
    const tiles = p.numTilesOwned();
    const centre = centres.get(p.smallID()) ?? spawnCentre(game, p);
    return {
      key: keys.get(p.id())!,
      id: p.id(),
      name: p.displayName(),
      kind: p === me ? "you" : kindOf(p),
      tiles,
      landPct: round((100 * tiles) / land, 2),
      troops: Math.round(p.troops()),
      gold: Number(p.gold()),
      troopsPerTile: tiles > 0 ? round(p.troops() / tiles, 1) : 0,
      cities: p.units(UnitType.City).length,
      ports: p.units(UnitType.Port).length,
      defensePosts: p.units(UnitType.DefensePost).length,
      region: regionOf(game, centre),
      centre,
      allied: p !== me && me.isAlliedWith(p),
      relation: p !== me && p.type() === PlayerType.Nation ? RELATIONS[p.relation(me)] : null,
      traitor: p.isTraitor(),
    };
  };

  const others = game
    .players()
    .filter((p) => p !== me && p.isAlive())
    .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
    .map(view);
  const cap = game.config().maxTroops(me);
  const owned = game.players().reduce((s, p) => s + p.numTilesOwned(), 0);
  const nameOf = (p: Player | { isPlayer(): boolean }) =>
    p.isPlayer() ? keys.get((p as Player).id())! : "unclaimed";
  const meView: MeView = {
    ...view(me),
    alive: me.isAlive(),
    spawned: me.hasSpawned(),
    troopCap: Math.round(cap),
    troopsPctOfCap: cap > 0 ? Math.round((100 * me.troops()) / cap) : 0,
    rank: 1 + others.filter((o) => o.tiles > me.numTilesOwned()).length,
    coastal: hasShore(game, me),
    incomingAttacks: me.incomingAttacks().map((a) => ({ from: nameOf(a.attacker()), troops: Math.round(a.troops()) })),
    outgoingAttacks: me.outgoingAttacks().map((a) => ({ to: nameOf(a.target()), troops: Math.round(a.troops()) })),
    boatsAtSea: me.units(UnitType.TransportShip).length,
    allianceRequests: me
      .incomingAllianceRequests()
      .filter((r) => r.status() === "pending")
      .map((r) => keys.get(r.requestor().id())!),
    alliances: me.alliances().map((a) => ({
      with: keys.get(a.other(me).id())!,
      secondsLeft: Math.max(0, Math.round((a.expiresAt() - game.ticks()) / 10)),
    })),
  };
  return {
    tick: game.ticks(),
    seconds: g.seconds(),
    spawnPhase: game.inSpawnPhase(),
    me: meView,
    others,
    unclaimedPct: round((100 * Math.max(0, land - owned)) / land, 1),
    playersAlive: others.length + (me.isAlive() ? 1 : 0),
  };
}

export function kindOf(p: Player): PlayerKind {
  switch (p.type()) {
    case PlayerType.Nation:
      return "nation";
    case PlayerType.Bot:
      return "tribe";
    default:
      return "human";
  }
}

/**
 * Readable keys from player names ("New South Wales" -> "new_south_wales").
 * Computed over all players in the engine's fixed order, so a key never changes.
 */
export function playerKeys(game: Game): Map<string, string> {
  const keys = new Map<string, string>();
  const used = new Set<string>();
  for (const p of game.allPlayers()) {
    const base = p.displayName().toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "player";
    let key = base;
    for (let i = 2; used.has(key); i++) key = `${base}_${i}`;
    used.add(key);
    keys.set(p.id(), key);
  }
  return keys;
}

/** Average tile position of every player's territory, in one pass over the map. */
function territoryCentres(game: Game): Map<number, { x: number; y: number }> {
  const sums = new Map<number, [number, number, number]>();
  const w = game.width();
  const h = game.height();
  // Every 2nd row and column is plenty for a centre.
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const t = game.ref(x, y);
      if (!game.hasOwner(t)) continue;
      const id = game.ownerID(t);
      const s = sums.get(id) ?? [0, 0, 0];
      s[0] += x;
      s[1] += y;
      s[2]++;
      sums.set(id, s);
    }
  }
  const out = new Map<number, { x: number; y: number }>();
  for (const [id, [sx, sy, n]] of sums) out.set(id, { x: Math.round(sx / n), y: Math.round(sy / n) });
  return out;
}

function spawnCentre(game: Game, p: Player): { x: number; y: number } {
  const t = p.spawnTile();
  return t === undefined ? { x: 0, y: 0 } : { x: game.x(t), y: game.y(t) };
}

/** Compass position on the map, from a 3×3 grid. */
export function regionOf(game: Game, c: { x: number; y: number }): string {
  const col = Math.min(2, Math.floor((3 * c.x) / game.width()));
  const row = Math.min(2, Math.floor((3 * c.y) / game.height()));
  const ns = ["north", "", "south"][row];
  const ew = ["west", "", "east"][col];
  return ns && ew ? `${ns}-${ew}` : ns || ew || "centre";
}

/** Compass direction from a to b ("north-east"), or "here" when they are close. */
export function directionFrom(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 15) return "around you";
  const names = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return names[(Math.round(angle / 45) + 8) % 8];
}

function hasShore(game: Game, p: Player): boolean {
  for (const t of p.borderTiles()) if (game.isShore(t)) return true;
  return false;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
