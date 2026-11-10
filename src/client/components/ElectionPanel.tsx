import type { ClientMessage, Position, Snapshot } from "../../shared/protocol";
import { roundLines } from "../../shared/electionRounds";
import { formatPercent, pickPercent } from "../percent";
import { ProgressBar } from "./ProgressBar";

const STATUS_LABELS = { pending: "Pending", voting: "Voting", runoff: "Runoff", decided: "Decided" } as const;

function statusLabel({ status, revealed }: Position) {
  return revealed ? "Revealed" : STATUS_LABELS[status];
}

function RowAction({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-secondary shrink-0" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

// While voting in an election: the position on screen with round controls, then every position with its status.
export function ElectionPanel({ room, send }: { room: Snapshot; send: (message: ClientMessage) => void }) {
  const { positions } = room;
  const focused = positions.find(({ id }) => id === room.focusPositionId);
  const detail = focused && room.hostOnly?.positionDetails[focused.id];
  // The round being voted on, or between rounds the one that just closed, with everyone who was on its ballot.
  const shown = focused && detail ? roundLines(focused, detail).at(-1) : undefined;

  const ballots = room.positionProgress?.total ?? room.members.length;
  const voted = room.positionProgress?.voted ?? 0;
  const waiting = ballots - voted;
  // Only one round can be open at a time, so every other position waits for it to close.
  const open = positions.some(({ status }) => status === "voting");

  return (
    <section>
      <div className="panel flex flex-col gap-5 p-4 sm:p-5">
        <div className="min-w-0">
          <h1 className="type-display wrap-anywhere">{focused?.title}</h1>
          {focused && (
            <p className="mt-1 text-chalk tabular-nums">
              Round {focused.round}, {focused.seatsOpen} {focused.seatsOpen === 1 ? "seat" : "seats"} open
            </p>
          )}

          {focused?.status === "voting" && (
            <>
              <p className="mt-1 text-chalk tabular-nums" aria-live="polite">
                Waiting on {waiting} of {ballots}
              </p>
              <div className="mt-3 max-w-xs">
                <ProgressBar value={voted} max={ballots} label="Brothers who have voted" />
              </div>
            </>
          )}
        </div>

        {/* Live picks. Only the host ever sees these. */}
        {shown && (
          <ul className="divide-y divide-hairline rounded-[1.25rem] bg-stage-deep px-4">
            {shown.lines.map(({ candidate, picks }) => {
              return (
                <li key={candidate.id} className="flex items-center gap-3 py-2.5 tabular-nums">
                  <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                  <span className="w-10 text-right font-semibold">{picks}</span>
                  <span className="w-16 text-right text-chalk">{formatPercent(pickPercent(picks, shown.ballots))}</span>
                </li>
              );
            })}
          </ul>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          {focused?.status === "voting" && (
            <button
              type="button"
              className="btn btn-lg btn-secondary"
              onClick={() => send({ type: "closeRound", positionId: focused.id })}
            >
              Close round
            </button>
          )}

          {focused?.status === "runoff" && (
            <button
              type="button"
              className="btn btn-lg btn-primary"
              onClick={() => send({ type: "openRound", positionId: focused.id })}
            >
              Open runoff
            </button>
          )}

          {focused?.status === "decided" && !focused.revealed && (
            <button
              type="button"
              className="btn btn-lg btn-primary"
              onClick={() => send({ type: "revealWinners", positionId: focused.id })}
            >
              Reveal winners
            </button>
          )}
        </div>
      </div>

      <ol className="panel mt-4 divide-y divide-hairline">
        {positions.map((position) => (
          <li key={position.id} className="flex items-center gap-3 px-4 py-3">
            <span className="w-6 text-right text-chalk tabular-nums">{position.ordinal}</span>
            <span className={`min-w-0 flex-1 truncate ${position.id === focused?.id ? "font-semibold" : ""}`}>
              {position.title}
            </span>
            <span className={`type-caption ${position.id === focused?.id ? "text-brass" : "text-chalk"}`}>
              {statusLabel(position)}
            </span>
            {position.status === "pending" && (
              <RowAction
                label="Open"
                disabled={open}
                onClick={() => send({ type: "openRound", positionId: position.id })}
              />
            )}
            {position.status === "runoff" && (
              <RowAction
                label="Open runoff"
                disabled={open}
                onClick={() => send({ type: "openRound", positionId: position.id })}
              />
            )}
            {position.status === "decided" && !position.revealed && (
              <RowAction
                label="Reveal winners"
                disabled={open}
                onClick={() => send({ type: "revealWinners", positionId: position.id })}
              />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
