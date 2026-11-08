import { describe, expect, it } from "vitest";
import { BOARD_WIDTH, layoutBoard, pathPoint, planPath, shuffleSides } from "../src/client/pegboard";
import { seeded } from "./random";

const CENTER = BOARD_WIDTH / 2;
const SIDES = ["yes", "no"] as const;

describe("layoutBoard", () => {
  it("fits every marble of a one-sided vote inside its bin", () => {
    for (const sides of [
      { yes: 12, no: 0 },
      { yes: 0, no: 400 },
      { yes: 200, no: 200 },
      { yes: 1, no: 1 },
    ]) {
      const board = layoutBoard(sides);
      for (const side of SIDES) {
        const bin = board.bins[side];
        expect(board.slots[side]).toHaveLength(sides[side]);
        for (const { x, y } of board.slots[side]) {
          expect(x - board.radius).toBeGreaterThanOrEqual(bin.left);
          expect(x + board.radius).toBeLessThanOrEqual(bin.right);
          expect(y - board.radius).toBeGreaterThanOrEqual(bin.top);
          expect(y + board.radius).toBeLessThanOrEqual(bin.bottom);
        }
      }
      expect(board.hopper).toHaveLength(sides.yes + sides.no);
    }
  });

  it("puts the Yes bin left of center and the No bin right of it", () => {
    const board = layoutBoard({ yes: 5, no: 5 });
    expect(board.bins.yes.right).toBeLessThanOrEqual(CENTER);
    expect(board.bins.no.left).toBeGreaterThanOrEqual(CENTER);
  });

  it("leaves room for a marble to pass between neighboring pegs", () => {
    const board = layoutBoard({ yes: 1, no: 1 });
    const gap = board.pegs[1]!.x - board.pegs[0]!.x;
    expect(gap - 2 * board.pegRadius).toBeGreaterThan(2 * board.radius * 1.2);
  });

  it("starts the hopper at the spout", () => {
    const board = layoutBoard({ yes: 20, no: 20 });
    expect(board.hopper[0]).toEqual(board.spout);
  });
});

describe("shuffleSides", () => {
  it("shuffles exactly the tally", () => {
    const sides = shuffleSides({ yes: 27, no: 13 }, seeded(1));
    expect(sides.filter((side) => side === "yes")).toHaveLength(27);
    expect(sides.filter((side) => side === "no")).toHaveLength(13);
  });
});

describe("planPath", () => {
  const board = layoutBoard({ yes: 30, no: 30 });
  const paths = (seed: number) => {
    const random = seeded(seed);
    return SIDES.flatMap((side) =>
      board.slots[side].map((slot) => ({ side, slot, path: planPath(board, side, slot, random) })),
    );
  };
  const lastRowY = board.pegs.at(-1)!.y;

  it("ends every planned path at its slot, on its own side", () => {
    for (const { slot, path } of paths(7)) {
      const end = pathPoint(path, path.duration, board.gravity);
      expect(end.x).toBeCloseTo(slot.x, 6);
      expect(end.y).toBeCloseTo(slot.y, 6);
    }
  });

  it("never crosses the center line once below the last peg row", () => {
    for (const { side, path } of paths(8)) {
      for (let t = 0; t <= path.duration; t += 1 / 240) {
        const { x, y } = pathPoint(path, t, board.gravity);
        if (y <= lastRowY) continue;
        if (side === "yes") expect(x).toBeLessThan(CENTER);
        else expect(x).toBeGreaterThan(CENTER);
      }
    }
  });

  it("hits one peg per row, each a neighbor of the last", () => {
    for (const { path } of paths(9)) {
      expect(path.arcs[0]!.peg).toBeNull();
      const hits = path.arcs.flatMap(({ peg }) => (peg === null ? [] : [board.pegs[peg]!]));
      expect(hits).toHaveLength(board.rows);
      expect(hits[0]!.x).toBe(CENTER);
      hits.forEach((peg, index) => {
        if (index === 0) return;
        const previous = hits[index - 1]!;
        expect(peg.y).toBeGreaterThan(previous.y);
        expect(Math.abs(Math.abs(peg.x - previous.x) - (board.pegs[1]!.x - board.pegs[0]!.x) / 2)).toBeLessThan(1e-9);
      });
    }
  });

  it("is continuous between arcs", () => {
    for (const { path } of paths(10)) {
      path.arcs.slice(1).forEach((arc, index) => {
        const previous = path.arcs[index]!;
        const end = pathPoint(path, previous.start + previous.duration - 1e-9, board.gravity);
        expect(end.x).toBeCloseTo(arc.x, 5);
        expect(end.y).toBeCloseTo(arc.y, 5);
      });
    }
  });

  it("uses both sides of the board for each bin", () => {
    const random = seeded(11);
    const middleRow = Math.floor(board.rows / 2);
    for (const side of SIDES) {
      const crossings = new Set<boolean>();
      for (let index = 0; index < 200; index++) {
        const path = planPath(board, side, board.slots[side][0]!, random);
        const hit = path.arcs.filter(({ peg }) => peg !== null)[middleRow]!;
        const x = board.pegs[hit.peg!]!.x;
        if (x !== CENTER) crossings.add(x < CENTER);
      }
      expect(crossings).toEqual(new Set([true, false]));
    }
  });
});
