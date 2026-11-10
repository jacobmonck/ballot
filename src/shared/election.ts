export interface RoundInput {
  seatsOpen: number;
  ballots: number;
  // Every candidate still on the ballot, in setup order.
  candidates: { id: string; picks: number }[];
}

export interface RoundOutcome {
  elected: string[]; // candidate ids elected this round, most picks first
  nextBallot: string[]; // empty when decided
  decided: boolean;
}

type Candidate = RoundInput["candidates"][number];

// A strict majority of the ballots cast; zero ballots still needs one pick.
export function majority(ballots: number): number {
  return Math.floor(ballots / 2) + 1;
}

// Array.prototype.sort is stable, so equal picks keep setup order.
function byPicksDesc(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => b.picks - a.picks);
}

const ids = (candidates: Candidate[]): string[] => candidates.map((candidate) => candidate.id);

// Clearers take seats first. Otherwise the last place drops out until someone wins or the seats fill.
export function countRound({ seatsOpen, ballots, candidates }: RoundInput): RoundOutcome {
  const clearers = byPicksDesc(candidates.filter((candidate) => candidate.picks >= majority(ballots)));

  // A tie at the cut line goes back to a runoff among only the tied candidates.
  const cut = clearers[seatsOpen - 1];
  const below = clearers[seatsOpen];
  if (cut && below && clearers.length > seatsOpen && cut.picks === below.picks) {
    const tieValue = cut.picks;
    return {
      elected: ids(clearers.filter((candidate) => candidate.picks > tieValue)),
      nextBallot: ids(clearers.filter((candidate) => candidate.picks === tieValue)),
      decided: false,
    };
  }

  const elected = clearers.slice(0, seatsOpen);
  const remaining = seatsOpen - elected.length;
  if (remaining === 0) return { elected: ids(elected), nextBallot: [], decided: true };

  const electedIds = new Set(ids(elected));
  const rest = candidates.filter((candidate) => !electedIds.has(candidate.id));
  if (rest.length === 0) return { elected: ids(elected), nextBallot: [], decided: true };

  const fewest = Math.min(...rest.map((candidate) => candidate.picks));
  // Dropping the fewest picks leaves no one when everyone left is level, so the whole field revotes.
  const survivors = rest.filter((candidate) => candidate.picks > fewest);
  if (survivors.length === 0) return { elected: ids(elected), nextBallot: ids(rest), decided: false };
  if (survivors.length <= remaining) {
    return { elected: [...ids(elected), ...ids(byPicksDesc(survivors))], nextBallot: [], decided: true };
  }
  return { elected: ids(elected), nextBallot: ids(survivors), decided: false };
}
