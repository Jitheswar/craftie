// Schematic files -> builder cells. Reads WorldEdit/Sponge .schem (v1-v3) and Litematica .litematic
// from ~/.craftie/schematics/. Only facing and half are kept from block states (what the builder places).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import nbt from 'prismarine-nbt';
import type { Cell } from './builder.ts';

export const SCHEM_DIR = join(homedir(), '.craftie', 'schematics');
const SKIP = new Set(['air', 'cave_air', 'void_air', 'structure_void', 'barrier']);

export function listSchematics(): string[] {
  if (!existsSync(SCHEM_DIR)) return [];
  return readdirSync(SCHEM_DIR).filter((f) => /\.(schem|litematic)$/i.test(f)).map((f) => basename(f, extname(f)));
}

/** Find a schematic by (fuzzy) name: exact, then case-insensitive, then "contains". */
function findFile(name: string): string | null {
  const files = existsSync(SCHEM_DIR) ? readdirSync(SCHEM_DIR).filter((f) => /\.(schem|litematic)$/i.test(f)) : [];
  const norm = (s: string) => s.toLowerCase().replace(/\.(schem|litematic)$/, '').replace(/[\s_-]+/g, '');
  const n = norm(name);
  const f = files.find((f) => basename(f, extname(f)) === name) ?? files.find((f) => norm(f) === n) ?? files.find((f) => norm(f).includes(n) || n.includes(norm(f)));
  return f ? join(SCHEM_DIR, f) : null;
}

function cell(x: number, y: number, z: number, state: string): Cell | null {
  const m = state.match(/^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/);
  if (!m) return null;
  const block = m[1];
  if (SKIP.has(block)) return null;
  const props = Object.fromEntries((m[2] ?? '').split(',').filter(Boolean).map((kv) => kv.split('=')));
  const facing = ['north', 'south', 'east', 'west'].includes(props.facing) ? props.facing : undefined;
  const half = props.half === 'top' || props.type === 'top' ? 'top' : props.half === 'bottom' ? 'bottom' : undefined;
  // Doors and beds are two blocks; the builder places the whole thing from the lower/foot part.
  if (/_door$/.test(block) && props.half === 'upper') return null;
  if (/_bed$/.test(block) && props.part === 'head') return null;
  return { x, y, z, block, facing: facing as any, half: /_door$/.test(block) ? undefined : half };
}

function readVarints(bytes: Buffer | number[], n: number): number[] {
  const out: number[] = [];
  let i = 0;
  while (out.length < n && i < bytes.length) {
    let v = 0, shift = 0, b: number;
    do { b = bytes[i++] & 0xff; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    out.push(v);
  }
  return out;
}

function sponge(root: any): Cell[] {
  const s = root.Schematic ?? root; // v3 wraps everything in "Schematic"
  const W = s.Width, H = s.Height, L = s.Length;
  const blocks = s.Blocks ?? s; // v3: Blocks.{Palette,Data}; v1/v2: Palette + BlockData at top level
  const palette: Record<string, number> = blocks.Palette;
  const data = blocks.Data ?? s.BlockData;
  if (!palette || !data) throw new Error('not a block schematic');
  const byId: string[] = [];
  for (const [state, id] of Object.entries(palette)) byId[id as number] = state;
  const ids = readVarints(Buffer.from(data.map((b: number) => b & 0xff)), W * H * L);
  const cells: Cell[] = [];
  ids.forEach((id, i) => {
    const x = i % W, z = Math.floor(i / W) % L, y = Math.floor(i / (W * L));
    const c = cell(x, y, z, byId[id] ?? 'air');
    if (c) cells.push(c);
  });
  return cells;
}

function litematic(root: any): Cell[] {
  const cells: Cell[] = [];
  const regions = Object.values(root.Regions ?? {}) as any[];
  // Regions are placed relative to each other; shift everything so the lowest corner is 0,0,0.
  const boxes = regions.map((r) => {
    const sx = r.Size.x, sy = r.Size.y, sz = r.Size.z;
    const ox = r.Position.x + (sx < 0 ? sx + 1 : 0), oy = r.Position.y + (sy < 0 ? sy + 1 : 0), oz = r.Position.z + (sz < 0 ? sz + 1 : 0);
    return { r, X: Math.abs(sx), Y: Math.abs(sy), Z: Math.abs(sz), ox, oy, oz };
  });
  const mx = Math.min(...boxes.map((b) => b.ox)), my = Math.min(...boxes.map((b) => b.oy)), mz = Math.min(...boxes.map((b) => b.oz));
  for (const { r, X, Y, Z, ox, oy, oz } of boxes) {
    const pal: string[] = (r.BlockStatePalette ?? []).map((p: any) => {
      const props = p.Properties ? Object.entries(p.Properties).map(([k, v]) => `${k}=${v}`).join(',') : '';
      return props ? `${p.Name}[${props}]` : p.Name;
    });
    const bits = Math.max(2, Math.ceil(Math.log2(pal.length)));
    const longs: bigint[] = (r.BlockStates ?? []).map(([hi, lo]: [number, number]) => (BigInt.asUintN(32, BigInt(hi)) << 32n) | BigInt.asUintN(32, BigInt(lo)));
    const mask = (1n << BigInt(bits)) - 1n;
    for (let i = 0; i < X * Y * Z; i++) {
      const bit = BigInt(i * bits), li = Number(bit >> 6n), off = bit & 63n;
      let v = (longs[li] ?? 0n) >> off;
      if (off + BigInt(bits) > 64n) v |= (longs[li + 1] ?? 0n) << (64n - off);
      const id = Number(v & mask);
      const x = i % X, z = Math.floor(i / X) % Z, y = Math.floor(i / (X * Z));
      const c = cell(x + ox - mx, y + oy - my, z + oz - mz, pal[id] ?? 'air');
      if (c) cells.push(c);
    }
  }
  return cells;
}

/** Load a schematic by name into builder cells (bottom corner at 0,0,0). */
export async function loadSchematic(name: string): Promise<{ cells: Cell[]; file: string }> {
  const file = findFile(name);
  if (!file) {
    const have = listSchematics();
    throw new Error(`no schematic "${name}" in ${SCHEM_DIR}${have.length ? ` (have: ${have.join(', ')})` : ' (folder is empty)'}`);
  }
  const { parsed } = await nbt.parse(readFileSync(file));
  const root = nbt.simplify(parsed);
  const cells = extname(file).toLowerCase() === '.litematic' ? litematic(root) : sponge(root);
  return { cells, file: basename(file) };
}
