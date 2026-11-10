import { toCsv } from "../../shared/csv";
import type { Position, PositionDetail, Snapshot } from "../../shared/protocol";
import { roundLines } from "../../shared/electionRounds";
import { formatPercent, pickPercent } from "../percent";

// Saves every round of every position as a CSV, one row per candidate per round.
function download(code: string, positions: Position[], details: Record<string, PositionDetail>) {
  const rows: (string | number)[][] = [["Position", "Round", "Candidate", "Picks", "Ballots", "Percent", "Result"]];

  for (const position of positions) {
    const detail = details[position.id];
    if (!detail) continue;

    for (const { round, ballots, lines } of roundLines(position, detail)) {
      for (const { candidate, picks, result } of lines) {
        rows.push([
          position.title,
          round,
          candidate.name,
          picks,
          ballots,
          formatPercent(pickPercent(picks, ballots)),
          result,
        ]);
      }
    }
  }

  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `voting-election-${code}.csv`;
  link.click();

  // Some browsers start the download after click() returns, so the URL has to outlive this call.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Every position's rounds and winners for the host, with the slate reveal and a CSV download.
export function ElectionResults({ room, onRevealSlate }: { room: Snapshot; onRevealSlate: () => void }) {
  const details = room.hostOnly?.positionDetails ?? {};
  const slateRevealed = room.slate !== null;

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="type-display">Results</h1>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => download(room.code, room.positions, details)}
          >
            Download CSV
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={slateRevealed}
            onClick={() => {
              if (confirm("Show the officer slate on the projector?")) onRevealSlate();
            }}
          >
            {slateRevealed ? "Slate revealed" : "Reveal slate on projector"}
          </button>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        {room.positions.map((position) => {
          const detail = details[position.id];
          const decided = position.status === "decided";

          return (
            <section key={position.id} className="panel p-5">
              <h2 className="type-title wrap-anywhere">{position.title}</h2>
              <p className={`mt-1 wrap-anywhere ${decided ? "text-brass" : "text-chalk"}`}>
                {decided
                  ? position.winners?.length
                    ? position.winners.map(({ name }) => name).join(", ")
                    : "No winners"
                  : "Undecided"}
              </p>

              {detail &&
                roundLines(position, detail).map(({ round, ballots, lines }) => (
                  <div key={round} className="mt-4">
                    <h3 className="type-caption text-chalk tabular-nums">
                      Round {round}, {ballots} {ballots === 1 ? "ballot" : "ballots"}
                    </h3>
                    <ul className="mt-1">
                      {lines.map(({ candidate, picks }) => (
                        <li key={candidate.id} className="flex items-center gap-3 py-1 tabular-nums">
                          <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                          <span className="w-10 text-right font-semibold">{picks}</span>
                          <span className="w-16 text-right text-chalk">
                            {formatPercent(pickPercent(picks, ballots))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </section>
          );
        })}
      </div>
    </main>
  );
}
