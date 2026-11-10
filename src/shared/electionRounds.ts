import type { Candidate, Position, PositionDetail } from "./protocol";
import { countRound } from "./election";

export type RoundResult = "Elected" | "Dropped" | "Runoff" | "Undecided";

export interface RoundLine {
  round: number;
  ballots: number;
  lines: { candidate: Candidate; picks: number; result: RoundResult }[];
}

// Each round's picks and what became of every candidate on that round's ballot. Tallies only hold candidates who got a pick,
// and the room drops candidates from the ballot as rounds close, so who was on each ballot is rebuilt by counting the rounds
// again, which is how the Worker counted them.
export function roundLines(
  { seats, status }: Pick<Position, "seats" | "status">,
  { candidates, rounds, live }: PositionDetail,
): RoundLine[] {
  const lines: RoundLine[] = [];
  let ballot = candidates;
  let seatsOpen = seats;

  rounds.forEach((tally, index) => {
    const outcome = countRound({
      seatsOpen,
      ballots: tally.ballots,
      candidates: ballot.map(({ id }) => ({ id, picks: tally.picks[id] ?? 0 })),
    });
    const elected = new Set(outcome.elected);
    const next = new Set(outcome.nextBallot);

    lines.push({
      round: index + 1,
      ballots: tally.ballots,
      lines: ballot.map((candidate) => ({
        candidate,
        picks: tally.picks[candidate.id] ?? 0,
        result: elected.has(candidate.id) ? "Elected" : next.has(candidate.id) ? "Runoff" : "Dropped",
      })),
    });
    seatsOpen -= outcome.elected.length;
    ballot = candidates.filter(({ id }) => next.has(id));
  });

  // A round still open when voting ended, or one never opened, has no outcome.
  if (status === "voting" || (status === "pending" && rounds.length === 0)) {
    lines.push({
      round: rounds.length + 1,
      ballots: live.ballots,
      lines: ballot.map((candidate) => ({ candidate, picks: live.picks[candidate.id] ?? 0, result: "Undecided" })),
    });
  }
  return lines;
}
