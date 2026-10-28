import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType, TerrainType, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { Intent } from "@openfront/engine-api/Schemas";
import { getSpawnTiles } from "@openfront/engine/execution/Util";
import type { Game, Player } from "@openfront/engine/game/Game";
import type { OpenFrontGame } from "../engine/game";
import { fmt, Graph, neighboursOf, strength, UNCLAIMED } from "../state/graph";
import { directionFrom, playerKeys, regionOf, Snapshot } from "../state/observe";

/**
 * One thing the LLM can choose to do now. The menu only lists options the
 * engine would accept at this moment, so the LLM never has to guess a tile
 * coordinate or a player id: it picks an option `id`.
 */
export interface MenuOption {
  id: string;
  /** What the option does, in words the LLM reads. */
  label: string;
  /** Whether the option sends troops (the LLM then also picks a percentage). */
  usesTroops: boolean;
  /** The engine order for this option; `percent` is the share of troops to send. */
  toIntent(percent: number): Intent | null;
}

/**
 * Shares of the current troops the LLM may send, in %. I use a short list
 * rather than a free number because constrained decoding of a free number can
 * run away (0.0555555… until the token limit). 0 means "not a troop order".
 */
export const TROOP_PERCENTS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

/** Share used when the model gives 0 for an order that sends troops (the game's own default is 20%). */
export const DEFAULT_TROOP_PERCENT = 20;

export function buildMenu(g: OpenFrontGame, snap: Snapshot, graph: Graph): MenuOption[] {
  if (snap.spawnPhase) return spawnMenu(g.game);
  const game = g.game;
  const me = g.me;
  if (!me.isAlive()) return [WAIT];

  const keys = playerKeys(game);
  const byKey = new Map(game.players().map((p) => [keys.get(p.id())!, p]));
  const troops = (percent: number) => Math.max(1, Math.floor((me.troops() * percent) / 100));
  const options: MenuOption[] = [WAIT];

  // Troops already on the way, per target: re-sending an order adds to them.
  const running = new Map<string, number>();
  for (const a of me.outgoingAttacks()) {
    const t = a.target();
    const key = t.isPlayer() ? keys.get((t as Player).id())! : UNCLAIMED;
    running.set(key, (running.get(key) ?? 0) + a.troops());
  }
  const already = (key: string, what: string) =>
    running.has(key) ? `; ${what} is already running with ${fmt(running.get(key)!)} troops: this adds more` : "";

  // ── land attacks: one per neighbour on the graph ──
  const neighbours = neighboursOf(graph, snap.me.key);
  for (const n of neighbours) {
    if (n.key === UNCLAIMED) {
      options.push({
        id: "expand",
        label: `expand into unclaimed land (border ${n.border} tiles)${already(UNCLAIMED, "an expansion")}`,
        usesTroops: true,
        toIntent: (pct) => ({ type: "attack", targetID: null, troops: troops(pct) }),
      });
      continue;
    }
    const p = byKey.get(n.key);
    if (p === undefined || me.isFriendly(p) || !me.canAttackPlayer(p)) continue;
    options.push({
      id: `attack_${n.key}`,
      label:
        `attack ${p.displayName()} (${kindLabel(p)}, ${fmt(p.troops())} troops, ${strength(p.troops() / Math.max(1, me.troops()))}) ` +
        `over your ${n.border}-tile border${already(n.key, "an attack on them")}`,
      usesTroops: true,
      toIntent: (pct) => ({ type: "attack", targetID: p.id(), troops: troops(pct) }),
    });
  }

  // ── boats: to players (or unclaimed coast) you cannot reach by land ──
  if (snap.me.boatsAtSea < 3 && snap.me.coastal) {
    for (const target of boatTargets(game, me, graph, snap, byKey)) {
      options.push({
        id: target.id,
        label: target.label,
        usesTroops: true,
        toIntent: (pct) => ({ type: "boat", troops: troops(pct), dst: target.tile }),
      });
    }
  }

  // ── buildings: the site is chosen here, the LLM only decides what to build ──
  const threat = mainThreat(me, snap, byKey);
  const builds: [UnitType, string, string, () => TileRef[]][] = [
    [UnitType.City, "build_city", "build a city near the centre of your land (+troop cap)", () => centralTiles(game, me)],
    [UnitType.Port, "build_port", "build a port on your coast (trade gold, boats)", () => shoreTiles(game, me)],
    [UnitType.Factory, "build_factory", "build a factory near the centre of your land (trains earn gold)", () => centralTiles(game, me)],
    [
      UnitType.DefensePost,
      "build_defense_post",
      threat === null ? "" : `build a defense post on your border with ${threat.displayName()} (attackers lose 5x more troops near it)`,
      () => (threat === null ? [] : borderTilesFacing(game, me, threat)),
    ],
  ];
  for (const [unit, id, label, sites] of builds) {
    if (label === "" || game.config().isUnitDisabled(unit)) continue;
    const cost = game.unitInfo(unit).cost(game, me);
    if (me.gold() < cost) continue;
    const tile = firstBuildable(me, unit, sites());
    if (tile === null) continue;
    options.push({
      id,
      label: `${label}, costs ${fmt(Number(cost))} gold`,
      usesTroops: false,
      toIntent: () => ({ type: "build_unit", unit, tile }),
    });
  }

  // ── diplomacy ──
  for (const key of snap.me.allianceRequests) {
    const p = byKey.get(key);
    if (p === undefined) continue;
    options.push({
      id: `accept_${key}`,
      label: `accept the alliance request from ${p.displayName()}`,
      usesTroops: false,
      toIntent: () => ({ type: "allianceRequest", recipient: p.id() }),
    });
  }
  // I only offer alliances with nations that border us or attack us. Tribes
  // accept every request, but an allied tribe can no longer be attacked, and in
  // my first test games the model kept allying with the tribes it should have
  // been conquering. When I offered every nation, it sent 15 proposals in
  // 2 minutes, mostly to nations far away.
  const bordering = new Set(neighbours.map((n) => n.key));
  const attackers = new Set(snap.me.incomingAttacks.map((a) => a.from));
  for (const p of game.players()) {
    const key = keys.get(p.id())!;
    if (p === me || p.type() === PlayerType.Bot || me.isAlliedWith(p)) continue;
    if (!bordering.has(key) && !attackers.has(key)) continue;
    if (snap.me.allianceRequests.includes(key) || !me.canSendAllianceRequest(p)) continue;
    options.push({
      id: `ally_${key}`,
      label: `propose an alliance to ${p.displayName()} (${kindLabel(p)}, ${regionOf(game, centreOf(game, p))})`,
      usesTroops: false,
      toIntent: () => ({ type: "allianceRequest", recipient: p.id() }),
    });
  }
  return options;
}

const WAIT: MenuOption = {
  id: "wait",
  label: "do nothing new (running attacks and the plan's expansion waves continue on their own)",
  usesTroops: false,
  toIntent: () => null,
};

// ── spawn ──

/**
 * Spawn candidates: the free land tile nearest to the centre of each cell of a
 * 4×3 grid, described by what matters for a start (terrain, coast, nations).
 */
export function spawnMenu(game: Game): MenuOption[] {
  const nations = game.nations().filter((n) => n.spawnCell !== undefined);
  const options: MenuOption[] = [];
  const cols = 4;
  const rows = 3;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = Math.floor(((c + 0.5) * game.width()) / cols);
      const cy = Math.floor(((r + 0.5) * game.height()) / rows);
      const tile = nearestFreeLand(game, cx, cy, Math.floor(game.width() / cols / 2));
      if (tile === null) continue;
      const at = { x: game.x(tile), y: game.y(tile) };
      const nearest = nations
        .map((n) => ({ name: n.playerInfo.name, d: Math.hypot(n.spawnCell!.x - at.x, n.spawnCell!.y - at.y), dir: directionFrom(at, n.spawnCell!) }))
        .sort((a, b) => a.d - b.d)[0];
      const t = terrainAround(game, tile, 40);
      options.push({
        id: `spawn_${options.length + 1}`,
        label:
          `start in the ${regionOf(game, at)} of the map: ${t.plains}% plains, ${t.highland}% highland, ${t.mountain}% mountain` +
          `${t.water > 5 ? `, coast nearby` : ", inland"}` +
          (nearest ? `; nearest nation ${nearest.name}, ${Math.round(nearest.d)} tiles to the ${nearest.dir}` : ""),
        usesTroops: false,
        toIntent: () => ({ type: "spawn", tile }),
      });
    }
  }
  return options;
}

function nearestFreeLand(game: Game, cx: number, cy: number, maxRadius: number): TileRef | null {
  for (let r = 0; r <= maxRadius; r += 4) {
    for (let dy = -r; dy <= r; dy += 4) {
      for (let dx = -r; dx <= r; dx += 4) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!game.isValidCoord(x, y)) continue;
        const t = game.ref(x, y);
        if (game.isLand(t) && !game.hasOwner(t) && getSpawnTiles(game.map(), t, true) !== null) return t;
      }
    }
  }
  return null;
}

function terrainAround(game: Game, tile: TileRef, radius: number) {
  const counts = { plains: 0, highland: 0, mountain: 0, water: 0, all: 0 };
  const x0 = game.x(tile);
  const y0 = game.y(tile);
  for (let dy = -radius; dy <= radius; dy += 3) {
    for (let dx = -radius; dx <= radius; dx += 3) {
      if (!game.isValidCoord(x0 + dx, y0 + dy) || dx * dx + dy * dy > radius * radius) continue;
      const t = game.ref(x0 + dx, y0 + dy);
      counts.all++;
      if (!game.isLand(t)) counts.water++;
      else if (game.terrainType(t) === TerrainType.Plains) counts.plains++;
      else if (game.terrainType(t) === TerrainType.Highland) counts.highland++;
      else counts.mountain++;
    }
  }
  const pct = (n: number) => Math.round((100 * n) / Math.max(1, counts.all));
  return { plains: pct(counts.plains), highland: pct(counts.highland), mountain: pct(counts.mountain), water: pct(counts.water) };
}

// ── boats ──

function boatTargets(
  game: Game,
  me: Player,
  graph: Graph,
  snap: Snapshot,
  byKey: Map<string, Player>,
): { id: string; label: string; tile: TileRef }[] {
  const adjacent = new Set(neighboursOf(graph, snap.me.key).map((n) => n.key));
  const out: { id: string; label: string; tile: TileRef }[] = [];
  const myCentre = snap.me.centre;
  // Other players without a land border, nearest first (each check runs a path search, so few).
  const far = snap.others
    .filter((p) => !adjacent.has(p.key))
    .sort((a, b) => Math.hypot(a.centre.x - myCentre.x, a.centre.y - myCentre.y) - Math.hypot(b.centre.x - myCentre.x, b.centre.y - myCentre.y))
    .slice(0, 3);
  for (const view of far) {
    const p = byKey.get(view.key);
    if (p === undefined || me.isFriendly(p) || !me.canAttackPlayer(p)) continue;
    const tile = firstBuildable(me, UnitType.TransportShip, nearestTo(game, shoreTiles(game, p), myCentre).slice(0, 3));
    if (tile === null) continue;
    out.push({
      id: `boat_${view.key}`,
      label: `send troops by boat to ${view.name} (${view.kind}, ${fmt(view.troops)} troops, ${directionFrom(myCentre, view.centre)} of you across the water)`,
      tile,
    });
  }
  // Unclaimed coast, only once no unclaimed land touches you.
  if (!adjacent.has(UNCLAIMED) && snap.unclaimedPct > 0.5) {
    const free = unclaimedShore(game);
    const tile = firstBuildable(me, UnitType.TransportShip, nearestTo(game, free, myCentre).slice(0, 4));
    if (tile !== null) {
      out.push({
        id: "boat_unclaimed",
        label: `send troops by boat to unclaimed land ${directionFrom(myCentre, { x: game.x(tile), y: game.y(tile) })} of you`,
        tile,
      });
    }
  }
  return out;
}

function unclaimedShore(game: Game): TileRef[] {
  const out: TileRef[] = [];
  for (let y = 0; y < game.height(); y += 2) {
    for (let x = 0; x < game.width(); x += 2) {
      const t = game.ref(x, y);
      if (game.isLand(t) && !game.hasOwner(t) && game.isShore(t)) out.push(t);
    }
  }
  return out;
}

// ── building sites ──

/**
 * Tries the sites in order. For a structure, canBuild returns the tile the
 * engine would really use. For a transport ship it returns the ship's start
 * tile, while the order needs the destination, so the site itself is kept.
 */
function firstBuildable(me: Player, unit: UnitType, sites: TileRef[]): TileRef | null {
  for (const t of sites.slice(0, 25)) {
    const at = me.canBuild(unit, t);
    if (at !== false) return unit === UnitType.TransportShip ? t : at;
  }
  return null;
}

function centralTiles(game: Game, p: Player): TileRef[] {
  const sample: TileRef[] = [];
  const stride = Math.max(1, Math.floor(p.numTilesOwned() / 400));
  let i = 0;
  for (const t of p.tiles()) if (i++ % stride === 0) sample.push(t);
  return nearestTo(game, sample, centreOf(game, p));
}

function shoreTiles(game: Game, p: Player): TileRef[] {
  const out: TileRef[] = [];
  for (const t of p.borderTiles()) if (game.isShore(t)) out.push(t);
  return nearestTo(game, out, centreOf(game, p));
}

/** Your border tiles that touch `enemy`, middle of that front first. */
function borderTilesFacing(game: Game, me: Player, enemy: Player): TileRef[] {
  const front: TileRef[] = [];
  const enemyID = enemy.smallID();
  for (const t of me.borderTiles()) {
    if (game.neighbors(t).some((n) => game.ownerID(n) === enemyID)) front.push(t);
  }
  if (front.length === 0) return [];
  const mid = {
    x: front.reduce((s, t) => s + game.x(t), 0) / front.length,
    y: front.reduce((s, t) => s + game.y(t), 0) / front.length,
  };
  return nearestTo(game, front, mid);
}

/** The neighbour to fortify against: the strongest attacker, else the strongest bordering player. */
function mainThreat(me: Player, snap: Snapshot, byKey: Map<string, Player>): Player | null {
  const attackers = me.incomingAttacks().map((a) => a.attacker()).sort((a, b) => b.troops() - a.troops());
  if (attackers.length > 0) return attackers[0];
  const bordering = snap.others
    .map((v) => byKey.get(v.key))
    .filter((p): p is Player => p !== undefined && me.sharesBorderWith(p) && !me.isFriendly(p))
    .sort((a, b) => b.troops() - a.troops());
  return bordering[0] ?? null;
}

function nearestTo(game: Game, tiles: TileRef[], c: { x: number; y: number }): TileRef[] {
  return tiles
    .map((t) => ({ t, d: (game.x(t) - c.x) ** 2 + (game.y(t) - c.y) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .map((e) => e.t);
}

function centreOf(game: Game, p: Player): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  const stride = Math.max(1, Math.floor(p.numTilesOwned() / 300));
  let i = 0;
  for (const t of p.tiles()) {
    if (i++ % stride !== 0) continue;
    sx += game.x(t);
    sy += game.y(t);
    n++;
  }
  if (n === 0) {
    const s = p.spawnTile();
    return s === undefined ? { x: 0, y: 0 } : { x: game.x(s), y: game.y(s) };
  }
  return { x: sx / n, y: sy / n };
}

function kindLabel(p: Player): string {
  return p.type() === PlayerType.Nation ? "nation" : p.type() === PlayerType.Bot ? "tribe" : "player";
}
