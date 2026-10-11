/**
 * The box maths of ~/orrama-redesign/mockups/orrsprite.py, so Orr stands in the app exactly
 * where he stands on the boards: same cell, same ground line, same scale.
 *
 *   pose(name, body)       the figure's box: `width` × `ground` is the wrapper (feet on its bottom
 *                          edge); the drawing is `width` × `height` from its top-left, so a shadow
 *                          or hanging legs overflow below. `body` is Hello's height in px.
 *   avatarCrop(name, d)    head and shoulders in a circle of diameter d.
 */
import { AVATARS, POSES, type SpriteSet } from "./sprites.js";

/** Hello's height ÷ the O's hole, measured on Jules's drawings. */
export const BODY_PER_HOLE = 5.35;

/** The median hole of a set: one scale for every figure in it. */
function hole(set: SpriteSet): number {
  const hs = Object.values(set.heads)
    .map((h) => h[2])
    .sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)]!;
}

export interface FigureBox {
  /** The wrapper: the figure's width, and its height down to the ground line. */
  width: number;
  ground: number;
  /** The drawing's full cell, anchored top-left in the wrapper. */
  height: number;
}

function figure(set: SpriteSet, body: number): FigureBox {
  const s = body / BODY_PER_HOLE / hole(set);
  const [cw, ch] = set.cell;
  return { width: cw * s, height: ch * s, ground: set.ground * s };
}

export const poseBox = (body: number): FigureBox => figure(POSES, body);
export const avatarBox = (body: number): FigureBox => figure(AVATARS, body);

export interface CropBox {
  /** The drawing's cell, scaled, and where its top-left sits inside the d × d circle. */
  width: number;
  height: number;
  left: number;
  top: number;
}

export function avatarCrop(name: string, d: number): CropBox {
  const head = AVATARS.heads[name];
  if (!head) throw new Error(`no avatar named ${name}`);
  const [hx, hy, h] = head;
  const ring = h * 2.07; // the O's outer diameter, from the logo
  const s = (0.5 * d) / ring;
  const [cw, ch] = AVATARS.cell;
  return { width: cw * s, height: ch * s, left: d / 2 - hx * s, top: 0.37 * d - hy * s };
}
