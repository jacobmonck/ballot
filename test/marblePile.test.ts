import { describe, expect, it } from "vitest";
import { MarblePile } from "../src/client/marblePile";

function settle(pile: MarblePile, frames = 600) {
  let landings = 0;
  for (let frame = 0; frame < frames; frame++) {
    pile.step(1 / 60);
    landings += pile.takeLandings();
  }
  return landings;
}

describe("MarblePile", () => {
  it("reports each marble's landing once", () => {
    const pile = new MarblePile();
    pile.resize(800, 600);
    pile.setTarget(5, 10);
    expect(settle(pile)).toBe(5);
  });

  it("doesn't report draining marbles as landings", () => {
    const pile = new MarblePile();
    pile.resize(800, 600);
    pile.setTarget(5, 10);
    settle(pile);
    pile.drain();
    pile.setTarget(0, 10);
    expect(settle(pile)).toBe(0);
  });

  it("drops absorbed marbles off the bottom", () => {
    const pile = new MarblePile();
    pile.resize(800, 600);
    pile.absorb([
      { x: 100, y: 500, radius: 10, side: "yes" },
      { x: 700, y: 500, radius: 10, side: "no" },
    ]);
    expect(pile.marbles.map(({ side, flip }) => [side, flip])).toEqual([
      ["yes", 1],
      ["no", 1],
    ]);
    settle(pile, 120);
    expect(pile.marbles).toEqual([]);
  });

  it("keeps absorbed hopper marbles gold", () => {
    const pile = new MarblePile();
    pile.resize(800, 600);
    pile.absorb([{ x: 400, y: 100, radius: 10, side: null }]);
    expect(pile.marbles[0]!.flip).toBe(0);
  });

  it("hands over the settled pile and keeps what's already draining", () => {
    const pile = new MarblePile();
    pile.resize(800, 600);
    pile.setTarget(4, 10);
    settle(pile);
    pile.absorb([{ x: 400, y: 0, radius: 10, side: null }]);
    const taken = pile.takeAll();
    expect(taken).toHaveLength(4);
    expect(pile.marbles).toHaveLength(1);
    expect(pile.marbles[0]!.draining).toBe(true);
  });
});
