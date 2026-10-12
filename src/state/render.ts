import { PlayerType, Structures, TerrainType } from "@openfront/engine-api/game/GameTypes";
import type { Game, Player } from "@openfront/engine/game/Game";
import zlib from "node:zlib";

type RGB = [number, number, number];

const WATER: RGB = [32, 58, 96];
const TERRAIN: Record<number, RGB> = {
  [TerrainType.Plains]: [196, 204, 160],
  [TerrainType.Highland]: [178, 166, 128],
  [TerrainType.Mountain]: [148, 138, 126],
  [TerrainType.Impassable]: [90, 90, 90],
};
const YOU: RGB = [255, 200, 0];
/** Distinct colours for nations (in the engine's order); tribes are drawn grey. */
const NATION_COLOURS: RGB[] = [
  [214, 39, 40], [31, 119, 180], [44, 160, 44], [148, 103, 189],
  [23, 190, 207], [227, 119, 194], [140, 86, 75], [188, 189, 34],
];
const TRIBE: RGB = [120, 120, 120];

/** Colour of each player on the rendered map (exported for the report legend). */
export function playerColours(game: Game, me: Player): Map<number, RGB> {
  const colours = new Map<number, RGB>();
  let n = 0;
  for (const p of game.allPlayers()) {
    if (p === me) colours.set(p.smallID(), YOU);
    else if (p.type() === PlayerType.Nation) colours.set(p.smallID(), NATION_COLOURS[n++ % NATION_COLOURS.length]);
    else colours.set(p.smallID(), TRIBE);
  }
  return colours;
}

/**
 * The map as a PNG: water, unclaimed terrain, one colour per owner (you in
 * gold, nations in colour, tribes in grey), darker borders, white buildings.
 */
export function renderPNG(game: Game, me: Player): Buffer {
  const w = game.width();
  const h = game.height();
  const rgb = new Uint8Array(w * h * 3);
  const colours = playerColours(game, me);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = game.ref(x, y);
      let c: RGB;
      if (!game.isLand(t)) c = WATER;
      else if (game.hasOwner(t)) {
        c = colours.get(game.ownerID(t)) ?? TRIBE;
        if (game.isBorder(t)) c = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6];
      } else c = TERRAIN[game.terrainType(t)] ?? TERRAIN[TerrainType.Plains];
      rgb.set(c, (y * w + x) * 3);
    }
  }
  for (const u of game.units()) {
    if (!Structures.has(u.type())) continue;
    const ux = game.x(u.tile());
    const uy = game.y(u.tile());
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (ux + dx >= 0 && uy + dy >= 0 && ux + dx < w && uy + dy < h) rgb.fill(255, ((uy + dy) * w + ux + dx) * 3, ((uy + dy) * w + ux + dx) * 3 + 3);
      }
    }
  }
  return encodePNG(w, h, rgb);
}

/**
 * A coarse text map: `~` water, `.` unclaimed land, `@` you, a letter for each
 * of the largest other players (legend returned). I keep it for humans and
 * experiments; the agent reads the graph text, which a 9B model finds much
 * easier to use (see notebook 03).
 */
export function renderASCII(game: Game, me: Player, columns = 60): { text: string; legend: Record<string, string> } {
  const cell = Math.ceil(game.width() / columns);
  const cellH = cell * 2; // characters are about twice as tall as wide
  const top = game.players().filter((p) => p !== me).sort((a, b) => b.numTilesOwned() - a.numTilesOwned()).slice(0, 26);
  const letter = new Map(top.map((p, i) => [p.smallID(), String.fromCharCode(65 + i)]));
  const legend: Record<string, string> = { "@": `${me.displayName()} (you)` };
  top.forEach((p, i) => (legend[String.fromCharCode(65 + i)] = p.displayName()));
  const lines: string[] = [];
  for (let y0 = 0; y0 < game.height(); y0 += cellH) {
    let line = "";
    for (let x0 = 0; x0 < game.width(); x0 += cell) {
      const counts = new Map<number, number>();
      let water = 0;
      let all = 0;
      for (let y = y0; y < Math.min(game.height(), y0 + cellH); y += 2) {
        for (let x = x0; x < Math.min(game.width(), x0 + cell); x += 2) {
          const t = game.ref(x, y);
          all++;
          if (!game.isLand(t)) water++;
          else {
            const o = game.hasOwner(t) ? game.ownerID(t) : 0;
            counts.set(o, (counts.get(o) ?? 0) + 1);
          }
        }
      }
      if (water * 2 > all) {
        line += "~";
        continue;
      }
      const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      line += best === 0 ? "." : best === me.smallID() ? "@" : (letter.get(best) ?? "+");
    }
    lines.push(line);
  }
  return { text: lines.join("\n"), legend };
}

// ── minimal PNG encoder (no dependencies) ──

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePNG(width: number, height: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
