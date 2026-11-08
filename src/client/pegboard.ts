// The pegboard reveal, planned before the first marble drops. Everything here works in a fixed
// 1600 by 900 space that the canvas scales to fit, so a projector going full screen mid-drop only
// rescales it. Nothing here is a physics simulation: each marble's path is a chain of arcs between
// peg contacts that ends in a slot of its own bin, so it can't land anywhere else.

export type Side = "yes" | "no";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 900;
export const MAX_MARBLES = 400;

// The board's layout: a triangle of pegs between the hopper above and the two bins below.
const CENTER = BOARD_WIDTH / 2;
const PEG_ROWS = 9;
const PEG_TOP = 220;
const ROW_GAP = 34;
const PEG_GAP = 52;
const PEG_RADIUS = 5;
const HOPPER: Rect = { left: 480, right: 1120, top: 20, bottom: 150 };
const BINS: Record<Side, Rect> = {
  yes: { left: 440, right: 794, top: 560, bottom: 880 },
  no: { left: 806, right: 1160, top: 560, bottom: 880 },
};
const GRAVITY = 2_600;

// Marble size: start as big as the pegs allow and shrink until every marble fits.
// Marbles must clear the gap between neighboring pegs with room to spare.
const MAX_RADIUS = 0.3 * (PEG_GAP - 2 * PEG_RADIUS);
const SHRINK = 0.97;
// Spacing between packed marbles, in radii. Hex rows sit closer than the marbles in a row.
const PACK_PITCH = 2.05;
const ROW_PITCH = PACK_PITCH * 0.87;

// Paths: how far off a peg's top a marble touches it, as shares of the two radii.
const CONTACT_SIDE = 0.45;
const CONTACT_TOP = 0.9;
// Flight times between contacts. The jitter keeps marbles from falling in lockstep.
const SPOUT_HOP_S = 0.16;
const PEG_HOP_S = 0.11;
const PEG_HOP_JITTER = 0.3;
// Slows the last fall into the bin a little, so landings are easier to follow.
const BIN_FALL_STRETCH = 1.1;

export interface Board {
  radius: number;
  pegRadius: number;
  // Row by row from the top. Row i holds i + 3 pegs.
  pegs: Point[];
  rows: number;
  // The tray the hopper's marbles sit in, with the spout under its middle.
  tray: Rect;
  spout: Point;
  // Slot 0 sits at the spout, the rest fan out and up from it.
  hopper: Point[];
  bins: Record<Side, Rect>;
  // Where each bin's marbles come to rest, bottom row first.
  slots: Record<Side, Point[]>;
  gravity: number;
}

// A peg's place in Board.pegs.
export function pegIndex(row: number, column: number) {
  // Rows before `row` hold 3 + 4 + ... + (row + 2) pegs.
  return (row * (row + 5)) / 2 + column;
}

// Where a peg sits. Each row is one peg wider than the last and stays centered.
function pegAt(row: number, column: number): Point {
  return { x: CENTER + (column - (row + 2) / 2) * PEG_GAP, y: PEG_TOP + row * ROW_GAP };
}

// Hex-packs up to `count` marbles into `area` from the bottom up, each row nearest `centerX` first.
function pack(area: Rect, radius: number, count: number, centerX: number): Point[] | null {
  const pitch = radius * PACK_PITCH;
  const points: Point[] = [];

  for (let row = 0; points.length < count; row++) {
    const y = area.bottom - radius - row * radius * ROW_PITCH;
    // Ran out of room before fitting everyone.
    if (y - radius < area.top) return null;

    // Every other row shifts half a marble, so it nests in the gaps below.
    const offset = row % 2 ? pitch / 2 : 0;
    const steps = Math.ceil((area.right - area.left) / pitch) + 1;
    const rowPoints: Point[] = [];
    for (let step = -steps; step <= steps; step++) {
      const x = centerX + offset + step * pitch;
      if (x - radius >= area.left && x + radius <= area.right) rowPoints.push({ x, y });
    }

    rowPoints.sort((a, b) => Math.abs(a.x - centerX) - Math.abs(b.x - centerX));
    points.push(...rowPoints.slice(0, count - points.length));
  }

  return points;
}

// Lays out the board for a drop, with marbles as big as they can be while the hopper and both bins
// still hold them all.
export function layoutBoard(sides: { yes: number; no: number }): Board {
  for (let radius = MAX_RADIUS; ; radius *= SHRINK) {
    const hopper = pack(HOPPER, radius, sides.yes + sides.no, CENTER);
    const yes = pack(BINS.yes, radius, sides.yes, (BINS.yes.left + BINS.yes.right) / 2);
    const no = pack(BINS.no, radius, sides.no, (BINS.no.left + BINS.no.right) / 2);
    if (!hopper || !yes || !no) continue;

    const pegs: Point[] = [];
    for (let row = 0; row < PEG_ROWS; row++)
      for (let column = 0; column < row + 3; column++) pegs.push(pegAt(row, column));

    return {
      radius,
      pegRadius: PEG_RADIUS,
      pegs,
      rows: PEG_ROWS,
      tray: HOPPER,
      spout: { x: CENTER, y: HOPPER.bottom - radius },
      hopper,
      bins: BINS,
      slots: { yes, no },
      gravity: GRAVITY,
    };
  }
}

// The order marbles leave the hopper in, shuffled so the drop doesn't give the result away early.
export function shuffleSides(sides: { yes: number; no: number }, random = Math.random): Side[] {
  const order: Side[] = [...Array<Side>(sides.yes).fill("yes"), ...Array<Side>(sides.no).fill("no")];

  // Fisher-Yates.
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap]!, order[index]!];
  }

  return order;
}

// One flight under gravity, from (x, y) at `start` with velocity (vx, vy).
export interface Arc {
  start: number;
  duration: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  // The peg hit at the start of this arc. Null for the drop out of the spout.
  peg: number | null;
}

// A marble's whole trip, arc after arc.
export interface Path {
  arcs: Arc[];
  duration: number;
}

// Plans a marble's whole trip, normally from the spout, to `slot`. The pegs decide only how it bounces: the
// left and right turns are random, and a run that would end on the wrong side is mirrored, which
// keeps both bins' paths alike while guaranteeing the bin.
export function planPath(board: Board, side: Side, slot: Point, random = Math.random, from = board.spout): Path {
  // True turns right. Nine turns can never cancel out, so the marble always leaves one side of center.
  let turns = Array.from({ length: board.rows }, () => random() < 0.5);
  const rights = turns.filter(Boolean).length;
  if (rights > board.rows - rights !== (side === "no")) turns = turns.map((right) => !right);

  const reach = board.radius + board.pegRadius;
  // `hop` is how long the flight that arrives at each point takes.
  const points: { at: Point; peg: number | null; hop: number }[] = [{ at: from, peg: null, hop: 0 }];

  // Walks down the rows. A right turn moves the marble one column over for the row below.
  let column = 1;
  turns.forEach((right, row) => {
    if (row > 0 && turns[row - 1]) column++;

    const peg = pegAt(row, column);
    // Touching a peg's left flank sends a marble left, and its right flank sends it right.
    const at = { x: peg.x + (right ? 1 : -1) * reach * CONTACT_SIDE, y: peg.y - reach * CONTACT_TOP };
    const hop = row === 0 ? SPOUT_HOP_S : PEG_HOP_S * (1 - PEG_HOP_JITTER / 2 + PEG_HOP_JITTER * random());
    points.push({ at, peg: pegIndex(row, column), hop });
  });

  // The last peg drops it straight into its slot, taking as long as falling that far would.
  const last = points.at(-1)!.at;
  points.push({ at: slot, peg: null, hop: Math.sqrt((2 * (slot.y - last.y)) / board.gravity) * BIN_FALL_STRETCH });

  // Each pair of points becomes one arc: the launch velocity that reaches the next point in time.
  const arcs: Arc[] = [];
  let start = 0;
  for (let index = 0; index < points.length - 1; index++) {
    const here = points[index]!;
    const to = points[index + 1]!;
    const duration = to.hop;

    arcs.push({
      start,
      duration,
      x: here.at.x,
      y: here.at.y,
      vx: (to.at.x - here.at.x) / duration,
      vy: (to.at.y - here.at.y - (board.gravity * duration * duration) / 2) / duration,
      peg: here.peg,
    });
    start += duration;
  }

  return { arcs, duration: start };
}

// Where a marble is `t` seconds into its path.
export function pathPoint(path: Path, t: number, gravity: number): Point {
  const time = Math.min(Math.max(t, 0), path.duration);

  let arc = path.arcs[0]!;
  for (const next of path.arcs) if (next.start <= time) arc = next;

  const elapsed = time - arc.start;
  return { x: arc.x + arc.vx * elapsed, y: arc.y + arc.vy * elapsed + (gravity * elapsed * elapsed) / 2 };
}
