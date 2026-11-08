import type { Tally } from "../shared/protocol";
import { type Board, MAX_MARBLES, type Path, pathPoint, planPath, type Point, type Side } from "./pegboard";

// The hopper: the pile rises into it, then it feeds the spout.
export const HOPPER_RISE_S = 0.9;
const FIRST_RELEASE_S = HOPPER_RISE_S + 0.3;
const HOPPER_EASE_PER_S = 12;
// How far a hopper marble may move to fill a gap, in marble radii: one neighboring place.
const HOPPER_REACH = 2.3;

// Pacing: the whole drop takes about DROP_SPREAD_S, with a slower finish for suspense.
const DROP_SPREAD_S = 13;
const MAX_GAP_S = 0.45;
// The gaps before each of the last five marbles.
const SLOW_FINISH_S = [0.42, 0.58, 0.74, 0.9, 1.06];

// How long a released marble takes to turn from gold to its side's color.
const FLIP_S = 0.25;
// Peg hits: the speed of the loudest tick, and the quietest a tick gets.
const TICK_SPEED = 900;
const MIN_TICK = 0.3;
const GLOW_DECAY_PER_S = 8;
const QUIET_GLOW = 0.01;
// The pause after the last marble lands before the result counts as done.
const DONE_AFTER_S = 0.5;

// Fewer marbles than ballots once a room passes MAX_MARBLES. A side with any votes keeps a marble.
export function marbleSides(tally: Tally, max = MAX_MARBLES) {
  const total = tally.yes + tally.no;
  if (total <= max) return { yes: tally.yes, no: tally.no };

  const scaled = (count: number) => (count ? Math.max(1, Math.round((count * max) / total)) : 0);
  const sides = { yes: scaled(tally.yes), no: scaled(tally.no) };

  // Rounding can overshoot by one, which comes off the bigger side.
  const larger = sides.yes >= sides.no ? "yes" : "no";
  sides[larger] -= Math.max(0, sides.yes + sides.no - max);
  return sides;
}

// The count beside a bin, which reaches the real tally as the last planned marble lands.
export function shownCount(landed: number, planned: number, tally: number) {
  return planned ? Math.round((tally * landed) / planned) : 0;
}

// Seconds between releases, so a drop takes about the same time however many voted.
export function releaseGaps(count: number) {
  const base = Math.min(MAX_GAP_S, DROP_SPREAD_S / count);

  return Array.from({ length: Math.max(0, count - 1) }, (_, index) => {
    const slow = SLOW_FINISH_S[index - (count - 1) + SLOW_FINISH_S.length];
    return Math.max(base, slow ?? 0);
  });
}

export type DropEvent =
  { type: "tock" } | { type: "tick"; peg: number; strength: number } | { type: "thud"; side: Side } | { type: "done" };

export interface DropMarble {
  x: number;
  y: number;
  radius: number;
  // Null while it's still gold in the hopper.
  side: Side | null;
  flip: number;
  alpha: number;
}

interface RunMarble extends DropMarble {
  // Where it sat on the pile before rising into the hopper.
  from: Point;
  // Its place in the hopper, or -1 once released, or null for a surplus marble fading out.
  hopperSlot: number | null;
  // True for a marble the pile didn't have, which fades in at its hopper place instead.
  fadeIn: boolean;
  path: Path | null;
  // Seconds along its path so far.
  flying: number;
  // The next arc whose peg hit hasn't been reported yet.
  nextArc: number;
}

// Plays a reveal back over time: the pile rises into the hopper, then marbles leave it one by one
// along planned paths. It only ever reports what the plan already decided.
export class PegboardRun {
  marbles: RunMarble[];
  pegGlow: number[];
  landed = { yes: 0, no: 0 };
  done = false;
  private clock = 0;
  private released = 0;
  private assigned = { yes: 0, no: 0 };
  private nextRelease = FIRST_RELEASE_S;
  private readonly gaps: number[];
  private lastThud: number | null = null;
  private cancelled = false;

  constructor(
    readonly board: Board,
    private readonly sides: Side[],
    from: Point[],
    private readonly random = Math.random,
  ) {
    this.pegGlow = board.pegs.map(() => 0);
    this.gaps = releaseGaps(sides.length);

    this.marbles = board.hopper.map((slot, index) => {
      const start = from[index] ?? slot;
      return this.marble(start, index, !from[index]);
    });
    // Ballots the pile held beyond the frozen tally quietly fade where they are.
    for (const point of from.slice(board.hopper.length)) this.marbles.push(this.marble(point, null, false));
  }

  // A drop that's already over, for a screen that loads after the reveal: every marble in its bin.
  static finished(board: Board, sides: Side[]) {
    const run = new PegboardRun(board, sides, []);

    const counts = { yes: 0, no: 0 };
    run.marbles = sides.map((side) => {
      const slot = board.slots[side][counts[side]++]!;
      return { ...run.marble(slot, -1, false), side, flip: 1 };
    });

    run.landed = counts;
    run.done = true;
    run.cancelled = true;
    return run;
  }

  // A gold marble at `at`, not yet given a side.
  private marble(at: Point, hopperSlot: number | null, fadeIn: boolean): RunMarble {
    return {
      x: at.x,
      y: at.y,
      radius: this.board.radius,
      side: null,
      flip: 0,
      alpha: fadeIn ? 0 : 1,
      from: at,
      hopperSlot,
      fadeIn,
      path: null,
      flying: 0,
      nextArc: 0,
    };
  }

  // Whether the frame loop needs to keep running: marbles still falling, or pegs still glowing.
  get moving() {
    if (this.cancelled) return false;
    return !this.done || this.pegGlow.some((glow) => glow > QUIET_GLOW);
  }

  // Freezes the run where it is, such as when the host moves on mid-drop.
  cancel() {
    this.cancelled = true;
  }

  // Advances the drop by `dt` seconds and returns what happened, for the canvas to play as sound.
  step(dt: number): DropEvent[] {
    if (!this.moving) return [];

    const events: DropEvent[] = [];
    this.clock += dt;
    const decay = Math.exp(-GLOW_DECAY_PER_S * dt);
    this.pegGlow = this.pegGlow.map((glow) => glow * decay);

    // Release every marble whose time has come, which can be more than one on a slow frame.
    while (this.released < this.sides.length && this.clock >= this.nextRelease) {
      this.release();
      events.push({ type: "tock" });
      this.nextRelease += this.gaps[this.released - 1] ?? 0;
    }

    // The pile rises into the hopper along a smoothstep curve. After that, hopper marbles ease
    // toward their place as the ones below them leave.
    const rise = Math.min(1, this.clock / HOPPER_RISE_S);
    const eased = rise * rise * (3 - 2 * rise);
    const follow = 1 - Math.exp(-HOPPER_EASE_PER_S * dt);

    for (const marble of this.marbles) {
      if (marble.hopperSlot === null) {
        marble.alpha = 1 - rise;
      } else if (marble.hopperSlot >= 0) {
        const slot = this.board.hopper[marble.hopperSlot]!;
        if (rise < 1) {
          marble.x = marble.from.x + (slot.x - marble.from.x) * eased;
          marble.y = marble.from.y + (slot.y - marble.from.y) * eased;
        } else {
          marble.x += (slot.x - marble.x) * follow;
          marble.y += (slot.y - marble.y) * follow;
        }
        if (marble.fadeIn) marble.alpha = rise;
      } else if (marble.path) {
        events.push(...this.fly(marble, dt));
      }
    }

    this.marbles = this.marbles.filter((marble) => marble.hopperSlot !== null || marble.alpha > 0 || rise < 1);

    // Done a beat after the last marble lands.
    if (!this.done && this.lastThud !== null && this.landed.yes + this.landed.no === this.sides.length) {
      if (this.clock - this.lastThud >= DONE_AFTER_S) {
        this.done = true;
        events.push({ type: "done" });
      }
    }

    return events;
  }

  // Lets go of the marble at the spout. Its side is only decided, and shown, from here on.
  private release() {
    const waiting = this.marbles.filter(({ hopperSlot }) => hopperSlot !== null && hopperSlot >= 0);
    // The spout's slot is normally full. Should it ever not be, the nearest marble goes instead.
    const marble = waiting.reduce((best, next) => (next.hopperSlot! < best.hopperSlot! ? next : best));
    const hole = marble.hopperSlot!;

    const side = this.sides[this.released++]!;
    const slot = this.board.slots[side][this.assigned[side]++]!;

    marble.hopperSlot = -1;
    marble.side = side;
    marble.alpha = 1;
    marble.path = planPath(this.board, side, slot, this.random, { x: marble.x, y: marble.y });

    this.refill(
      hole,
      waiting.filter((other) => other !== marble),
    );
  }

  // Like grain in a funnel: the marble above a gap drops into it, or failing that one beside it rolls
  // over, and the gap moves on to where that marble was. Each marble only ever moves one place.
  private refill(hole: number, marbles: RunMarble[]) {
    const { hopper, radius } = this.board;
    let waiting = marbles;
    const reach = radius * HOPPER_REACH;

    for (let gap: number | null = hole; gap !== null;) {
      const at: Point = hopper[gap]!;

      // Candidates: marbles one place away, level with the gap or above it.
      const near = waiting.filter(({ hopperSlot }) => {
        const slot = hopper[hopperSlot!]!;
        return slot.y <= at.y + 0.5 && Math.hypot(slot.x - at.x, slot.y - at.y) < reach;
      });

      // Prefer the marble straight above, then whichever is closest sideways.
      const above = near.filter(({ hopperSlot }) => hopper[hopperSlot!]!.y < at.y - 0.5);
      const pick = (above.length ? above : near).reduce<RunMarble | null>(
        (best, next) =>
          !best || Math.abs(hopper[next.hopperSlot!]!.x - at.x) < Math.abs(hopper[best.hopperSlot!]!.x - at.x)
            ? next
            : best,
        null,
      );
      if (!pick) return;

      const vacated: number = pick.hopperSlot!;
      pick.hopperSlot = gap;
      waiting = waiting.filter((other) => other !== pick);
      gap = vacated;
    }
  }

  // Moves a released marble along its path, reporting each peg it hits and its landing.
  private fly(marble: RunMarble, dt: number): DropEvent[] {
    const path = marble.path!;
    if (marble.flying >= path.duration) return [];

    const events: DropEvent[] = [];
    marble.flying = Math.min(path.duration, marble.flying + dt);
    marble.flip = Math.min(1, marble.flying / FLIP_S);

    while (marble.nextArc < path.arcs.length && path.arcs[marble.nextArc]!.start <= marble.flying) {
      const index = marble.nextArc++;
      const { peg } = path.arcs[index]!;
      if (peg === null) continue;

      // Harder hits are louder: the speed the marble arrived at the peg with.
      const before = path.arcs[index - 1]!;
      const speed = Math.hypot(before.vx, before.vy + this.board.gravity * before.duration);
      this.pegGlow[peg] = 1;
      events.push({ type: "tick", peg, strength: Math.min(1, Math.max(MIN_TICK, speed / TICK_SPEED)) });
    }

    const point = pathPoint(path, marble.flying, this.board.gravity);
    marble.x = point.x;
    marble.y = point.y;

    if (marble.flying >= path.duration) {
      this.landed[marble.side!]++;
      this.lastThud = this.clock;
      events.push({ type: "thud", side: marble.side! });
    }

    return events;
  }
}
