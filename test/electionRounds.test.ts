import { describe, expect, it } from "vitest";
import { roundLines } from "../src/shared/electionRounds";
import type { PositionDetail, PositionStatus } from "../src/shared/protocol";

const names = ["A", "B", "C", "D"];
const candidates = names.map((name) => ({ id: name.toLowerCase(), name }));
const empty = { ballots: 0, picks: {} };

function detail(rounds: PositionDetail["rounds"], live = empty): PositionDetail {
  return { candidates, rounds, live };
}

const summary = (rounds: ReturnType<typeof roundLines>) =>
  rounds.map(({ round, lines }) => ({
    round,
    results: lines.map(({ candidate, result }) => `${candidate.name}:${result}`),
  }));

describe("roundLines", () => {
  it("decides a one-seat position in round 1 and keeps a zero-pick candidate", () => {
    // D has no picks, so is missing from the tally keys.
    const lines = roundLines({ seats: 1, status: "decided" }, detail([{ ballots: 5, picks: { a: 4, b: 1 } }]));

    expect(lines).toHaveLength(1);
    expect(lines[0]!.lines.map(({ candidate, picks }) => [candidate.name, picks])).toEqual([
      ["A", 4],
      ["B", 1],
      ["C", 0],
      ["D", 0],
    ]);
    expect(summary(lines)[0]!.results).toEqual(["A:Elected", "B:Dropped", "C:Dropped", "D:Dropped"]);
  });

  it("elects one in round 1 and one in the runoff for two seats", () => {
    // Round 1: A clears 3 of 5. B and C tie for the last seat, D drops. Round 2: B beats C.
    const lines = roundLines(
      { seats: 2, status: "decided" },
      detail([
        { ballots: 5, picks: { a: 4, b: 3, c: 3 } },
        { ballots: 5, picks: { b: 4, c: 1 } },
      ]),
    );

    expect(summary(lines)).toEqual([
      { round: 1, results: ["A:Elected", "B:Runoff", "C:Runoff", "D:Dropped"] },
      { round: 2, results: ["B:Elected", "C:Dropped"] },
    ]);
  });

  it("leaves a round that was still voting when the session ended undecided", () => {
    const lines = roundLines({ seats: 1, status: "voting" }, detail([], { ballots: 2, picks: { b: 2 } }));

    expect(lines).toHaveLength(1);
    expect(lines[0]!.ballots).toBe(2);
    expect(summary(lines)[0]!.results).toEqual(["A:Undecided", "B:Undecided", "C:Undecided", "D:Undecided"]);
  });

  it.each<PositionStatus>(["runoff", "decided"])("adds no open round once %s", (status) => {
    const lines = roundLines({ seats: 1, status }, detail([{ ballots: 5, picks: { a: 3 } }]));
    expect(lines).toHaveLength(1);
  });
});
