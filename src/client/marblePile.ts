const GRAVITY = 2_200;
const BOUNCE = 0.3;
const WALL_BOUNCE = 0.4;
const ROLL_FRICTION = 0.97;
const AIR_DRAG = 0.9995;
const SUBSTEPS = 2;
const SOLVER_PASSES = 3;
const SPAWN_GAP_S = 0.035;
const FADE_PER_S = 3;
const QUIET_PIXELS = 0.3;
// How fast a falling marble must meet the pile for the hit to count as landing on it.
const LANDING_SPEED = 120;

import type { Point, Side } from "./pegboard";

export type { Side };

export interface Marble {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  draining: boolean;
  leaving: boolean;
  // Has come to rest on the floor or the pile at least once.
  landed: boolean;
  // Set only on marbles handed back from a finished pegboard, which are already their side's color.
  side: Side | null;
  // 0 is gold, 1 is fully its side's color.
  flip: number;
}

// A small circle-packing simulation: marbles fall, stack on the floor, and drain through it.
export class MarblePile {
  marbles: Marble[] = [];
  private width = 0;
  private height = 0;
  private target = 0;
  private radius = 10;
  private spawnClock = 0;
  private landings = 0;

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  setTarget(count: number, radius: number) {
    this.target = count;
    this.radius = radius;
    const settled = this.marbles.filter((marble) => !marble.draining && !marble.leaving);
    settled.sort((a, b) => a.y - b.y);
    for (const marble of settled.slice(0, Math.max(0, settled.length - count))) marble.leaving = true;
  }

  // Opens the floor. Everything on it falls away and new marbles start a fresh pile.
  drain() {
    for (const marble of this.marbles) marble.draining = true;
  }

  // Hands the pile to the pegboard: returns where each settled marble is and stops spawning more.
  takeAll(): Point[] {
    const live = this.marbles.filter((marble) => !marble.draining && !marble.leaving);
    this.marbles = this.marbles.filter((marble) => marble.draining || marble.leaving);
    this.target = 0;
    return live.map(({ x, y }) => ({ x, y }));
  }

  // Takes back marbles from the pegboard and lets them fall away like a drained pile.
  absorb(marbles: { x: number; y: number; radius: number; side: Side | null }[]) {
    for (const { x, y, radius, side } of marbles) {
      this.marbles.push({
        x,
        y,
        vx: 0,
        vy: 0,
        radius,
        alpha: 1,
        draining: true,
        leaving: false,
        landed: true,
        side,
        flip: 1,
      });
    }
  }

  private randomX(radius: number) {
    return radius + Math.random() * (this.width - radius * 2);
  }

  // Marbles that first landed since the last call.
  takeLandings() {
    const { landings } = this;
    this.landings = 0;
    return landings;
  }

  private land(marble: Marble) {
    if (marble.landed || marble.draining) return;
    marble.landed = true;
    this.landings++;
  }

  hop() {
    for (const marble of this.marbles) {
      if (marble.draining) continue;
      marble.vy -= 500 + Math.random() * 700;
      marble.vx += (Math.random() - 0.5) * 260;
    }
  }

  private spawn(dt: number) {
    this.spawnClock += dt;
    while (this.spawnClock >= SPAWN_GAP_S) {
      this.spawnClock -= SPAWN_GAP_S;
      const live = this.marbles.filter((marble) => !marble.draining && !marble.leaving).length;
      if (live >= this.target) {
        this.spawnClock = 0;
        return;
      }
      const { radius } = this;
      this.marbles.push({
        x: this.randomX(radius),
        y: -radius * 2,
        vx: (Math.random() - 0.5) * 120,
        vy: 300 + Math.random() * 200,
        radius,
        alpha: 1,
        draining: false,
        leaving: false,
        landed: false,
        side: null,
        flip: 0,
      });
    }
  }

  private collide() {
    const { marbles } = this;
    const cell = Math.max(this.radius, ...marbles.map(({ radius }) => radius)) * 2;
    const grid = new Map<number, number[]>();
    marbles.forEach(({ x, y }, index) => {
      const key = (Math.floor(x / cell) + 1) * 8192 + Math.floor(y / cell) + 1;
      const bucket = grid.get(key);
      if (bucket) bucket.push(index);
      else grid.set(key, [index]);
    });

    marbles.forEach((a, index) => {
      const column = Math.floor(a.x / cell) + 1;
      const row = Math.floor(a.y / cell) + 1;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const other of grid.get((column + dx) * 8192 + row + dy) ?? []) {
            if (other <= index) continue;
            const b = marbles[other]!;
            if (a.draining !== b.draining) continue;
            const nx = b.x - a.x;
            const ny = b.y - a.y;
            const reach = a.radius + b.radius;
            const distanceSquared = nx * nx + ny * ny;
            if (distanceSquared >= reach * reach || distanceSquared === 0) continue;
            const distance = Math.sqrt(distanceSquared);
            const push = (reach - distance) / 2 / distance;
            a.x -= nx * push;
            a.y -= ny * push;
            b.x += nx * push;
            b.y += ny * push;
            const approach = ((b.vx - a.vx) * nx + (b.vy - a.vy) * ny) / distance;
            if (approach >= 0) continue;
            if (-approach > LANDING_SPEED) {
              if (a.landed) this.land(b);
              if (b.landed) this.land(a);
            }
            const impulse = (-(1 + BOUNCE) * approach) / 2 / distance;
            a.vx -= nx * impulse;
            a.vy -= ny * impulse;
            b.vx += nx * impulse;
            b.vy += ny * impulse;
          }
        }
      }
    });
  }

  private contain() {
    const { width, height } = this;
    for (const marble of this.marbles) {
      const { radius } = marble;
      if (marble.x < radius) {
        marble.x = radius;
        marble.vx = Math.abs(marble.vx) * WALL_BOUNCE;
      } else if (marble.x > width - radius) {
        marble.x = width - radius;
        marble.vx = -Math.abs(marble.vx) * WALL_BOUNCE;
      }
      if (!marble.draining && marble.y > height - radius) {
        this.land(marble);
        marble.y = height - radius;
        marble.vy = -Math.abs(marble.vy) * BOUNCE;
        marble.vx *= ROLL_FRICTION;
      }
    }
  }

  // Returns true while anything is still visibly moving.
  step(dt: number) {
    this.spawn(dt);
    const before = this.marbles.map(({ x, y }) => [x, y] as const);
    const count = this.marbles.length;
    const substep = dt / SUBSTEPS;

    for (let pass = 0; pass < SUBSTEPS; pass++) {
      for (const marble of this.marbles) {
        marble.vy += GRAVITY * substep;
        marble.vx *= AIR_DRAG;
        marble.vy *= AIR_DRAG;
        marble.x += marble.vx * substep;
        marble.y += marble.vy * substep;
      }
      for (let solve = 0; solve < SOLVER_PASSES; solve++) {
        this.collide();
        this.contain();
      }
    }

    let moving = this.marbles.length < this.target;
    for (let index = 0; index < count; index++) {
      const marble = this.marbles[index]!;
      const [x, y] = before[index]!;
      if (Math.hypot(marble.x - x, marble.y - y) > QUIET_PIXELS) moving = true;
      if (marble.leaving) marble.alpha -= FADE_PER_S * dt;
    }

    this.marbles = this.marbles.filter((marble) => marble.alpha > 0 && marble.y < this.height + marble.radius * 2);
    return moving || this.marbles.some(({ draining, leaving }) => draining || leaving);
  }
}
