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
});
