import { describe, expect, it } from "vitest";
import { formatPercent, yesPercent } from "../src/client/percent";
import { watchReveal } from "../src/client/revealWatch";

describe("yesPercent", () => {
  it("formats the percent like the results screen", () => {
    expect(formatPercent(yesPercent({ yes: 27, no: 13 }))).toBe("67.5%");
    expect(formatPercent(yesPercent({ yes: 2, no: 1 }))).toBe("66.7%");
    expect(formatPercent(yesPercent({ yes: 3, no: 0 }))).toBe("100%");
    expect(yesPercent({ yes: 0, no: 0 })).toBe(0);
  });
});

describe("watchReveal", () => {
  it("plays a reveal it watched happen", () => {
    let watched = watchReveal(null, "a", false, "open");
    watched = watchReveal(watched, "a", true, "open");
    expect(watched).toBe("a");
  });

  it("doesn't replay a reveal that was already there on load", () => {
    expect(watchReveal(null, "a", true, "open")).toBeNull();
  });

  it("doesn't replay a reveal that happened while disconnected", () => {
    let watched = watchReveal(null, "a", false, "open");
    watched = watchReveal(watched, "a", false, "reconnecting");
    expect(watched).toBeNull();
    expect(watchReveal(watched, "a", true, "open")).toBeNull();
  });

  it("keeps playing a watched reveal through a dropped connection", () => {
    let watched = watchReveal(null, "a", false, "open");
    watched = watchReveal(watched, "a", true, "open");
    watched = watchReveal(watched, "a", true, "reconnecting");
    expect(watched).toBe("a");
    expect(watchReveal(watched, "a", true, "open")).toBe("a");
  });

  it("forgets the last PNM when the next comes up", () => {
    expect(watchReveal("a", "b", false, "open")).toBe("b");
    expect(watchReveal("a", null, false, "open")).toBeNull();
  });
});
