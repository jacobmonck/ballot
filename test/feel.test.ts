import { describe, expect, it } from "vitest";
import { isFlick } from "../src/client/feel";

describe("isFlick", () => {
  it("counts a fast short flick and a slow long drag, not a twitch or a pull down", () => {
    expect(isFlick(-40, -900)).toBe(true);
    expect(isFlick(-130, 0)).toBe(true);
    expect(isFlick(-8, -2000)).toBe(false);
    expect(isFlick(60, -300)).toBe(false);
  });
});
