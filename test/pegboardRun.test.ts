import { describe, expect, it } from "vitest";
import { layoutBoard, shuffleSides, type Point } from "../src/client/pegboard";
import {
  type DropEvent,
  HOPPER_RISE_S,
  marbleSides,
  PegboardRun,
  releaseGaps,
  shownCount,
} from "../src/client/pegboardRun";
import { seeded } from "./random";

function drain(run: PegboardRun) {
  const events: DropEvent[] = [];
  for (let frame = 0; frame < 60 * 60 && run.moving; frame++) events.push(...run.step(1 / 60));
  return events;
}

function startRun(yes: number, no: number, from: Point[] = []) {
  const board = layoutBoard({ yes, no });
  return new PegboardRun(board, shuffleSides({ yes, no }, seeded(2)), from, seeded(3));
}

const scattered = (count: number) => Array.from({ length: count }, (_, index) => ({ x: 100 + index * 10, y: 800 }));

describe("PegboardRun", () => {
  it("lands exactly the tally in each bin and says done once", () => {
    const run = startRun(27, 13);
    const events = drain(run);
    expect(run.landed).toEqual({ yes: 27, no: 13 });
    expect(events.filter((event) => event.type === "thud")).toHaveLength(40);
    expect(events.filter((event) => event.type === "tock")).toHaveLength(40);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(run.done).toBe(true);
  });

  it("rests every marble in a slot of its own bin", () => {
    const run = startRun(21, 19);
    drain(run);
    expect(run.marbles).toHaveLength(40);
    for (const { x, y, side } of run.marbles) {
      const bin = run.board.bins[side!];
      expect(x).toBeGreaterThan(bin.left);
      expect(x).toBeLessThan(bin.right);
      expect(y).toBeGreaterThan(bin.top);
      expect(y).toBeLessThan(bin.bottom);
    }
  });

  it("fills the hopper with exactly the tally whatever the pile held", () => {
    for (const from of [scattered(25), scattered(60)]) {
      const run = startRun(30, 10, from);
      run.step(HOPPER_RISE_S);
      expect(run.marbles.filter(({ alpha }) => alpha > 0.99)).toHaveLength(40);
      expect(run.marbles.every(({ side }) => side === null)).toBe(true);
    }
  });

  it("keeps marbles gold until they leave the hopper", () => {
    const run = startRun(5, 5, scattered(10));
    run.step(HOPPER_RISE_S + 0.2);
    expect(run.marbles.every(({ side, flip }) => side === null && flip === 0)).toBe(true);
    let events: DropEvent[] = [];
    while (!events.some(({ type }) => type === "tock")) events = run.step(1 / 60);
    expect(run.marbles.filter(({ side }) => side !== null)).toHaveLength(1);
  });

  it("refills the spout from neighboring hopper slots only", () => {
    const run = startRun(120, 80);
    const board = run.board;
    const slotsOf = () =>
      new Map(run.marbles.filter(({ side }) => side === null).map((marble) => [marble, marble.hopperSlot!]));
    let before = slotsOf();
    for (let frame = 0; frame < 60 * 8; frame++) {
      run.step(1 / 60);
      const after = slotsOf();
      for (const [marble, slot] of after) {
        const previous = before.get(marble);
        if (previous === undefined || previous === slot) continue;
        const from = board.hopper[previous]!;
        const to = board.hopper[slot]!;
        expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeLessThan(board.radius * 2.3);
      }
      before = after;
    }
  });

  it("goes silent when cancelled", () => {
    const run = startRun(20, 20);
    for (let frame = 0; frame < 120; frame++) run.step(1 / 60);
    run.cancel();
    for (let frame = 0; frame < 100; frame++) expect(run.step(1 / 60)).toEqual([]);
    expect(run.moving).toBe(false);
  });

  it("starts finished when it was already revealed", () => {
    const board = layoutBoard({ yes: 7, no: 3 });
    const run = PegboardRun.finished(board, shuffleSides({ yes: 7, no: 3 }));
    expect(run.done).toBe(true);
    expect(run.landed).toEqual({ yes: 7, no: 3 });
    expect(run.step(1 / 60)).toEqual([]);
  });
});

describe("releaseGaps", () => {
  it("finishes a drop in 10 to 20 seconds for 20 to 400 voters", () => {
    for (const count of [20, 40, 62, 150, 400]) {
      const total = releaseGaps(count).reduce((sum, gap) => sum + gap, 0);
      expect(total).toBeGreaterThanOrEqual(10 - 1.5);
      expect(total).toBeLessThanOrEqual(20 - 1.5);
    }
  });

  it("slows down for the last five marbles", () => {
    const gaps = releaseGaps(40);
    expect(gaps).toHaveLength(39);
    const tail = gaps.slice(-5);
    tail.slice(1).forEach((gap, index) => expect(gap).toBeGreaterThan(tail[index]!));
    expect(tail[0]).toBeGreaterThan(gaps.at(-6)!);
  });

  it("has no gaps for a single marble", () => {
    expect(releaseGaps(1)).toEqual([]);
  });
});

describe("big rooms", () => {
  it("caps marbles and still counts to the exact tally", () => {
    expect(marbleSides({ yes: 600, no: 200 })).toEqual({ yes: 300, no: 100 });
    expect(marbleSides({ yes: 799, no: 1 }).no).toBe(1);
    expect(marbleSides({ yes: 799, no: 1 }).yes).toBe(399);
    expect(marbleSides({ yes: 30, no: 10 })).toEqual({ yes: 30, no: 10 });
    for (let landed = 0; landed <= 300; landed++) expect(shownCount(landed, 300, 600)).toBe(landed * 2);
    expect(shownCount(1, 1, 1)).toBe(1);
    expect(shownCount(0, 0, 0)).toBe(0);
  });
});
