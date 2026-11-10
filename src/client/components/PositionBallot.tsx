import { motion } from "motion/react";
import { useState } from "react";
import type { Position } from "../../shared/protocol";
import { haptic, materialize } from "../feel";

interface Props {
  position: Position;
  // This brother's picks for the current round, if any.
  picks: string[] | undefined;
  // True for a moment after the position changes, while the ballot ignores taps.
  disabled: boolean;
  // True while the picks are on their way to the server.
  sending: boolean;
  onPick: (candidateIds: string[]) => void;
}

// One position's ballot: toggle candidates up to the open seats, then cast. Callers key it by position and
// round, so a new round starts with a fresh selection.
export function PositionBallot({ position, picks, disabled, sending, onPick }: Props) {
  const { title, seatsOpen, ballot } = position;
  const cast = picks && picks.length > 0 ? picks : null;

  const [selected, setSelected] = useState<string[]>([]);
  // True while a brother whose ballot is in is choosing again.
  const [changing, setChanging] = useState(false);

  const toggle = (id: string) => {
    if (disabled) return;
    haptic();
    setSelected((current) => {
      if (current.includes(id)) return current.filter((other) => other !== id);
      // A 1-seat position swaps the selection; a bigger one stops at the open seats.
      if (seatsOpen === 1) return [id];
      return current.length >= seatsOpen ? current : [...current, id];
    });
  };

  const submit = () => {
    if (disabled || selected.length === 0) return;
    haptic();
    onPick(selected);
    setChanging(false);
  };

  const names = (ids: string[]) =>
    ids.map((id) => ballot.find((candidate) => candidate.id === id)?.name).filter((name) => name !== undefined);

  // A ballot that's in shows the chosen names with ways to change or clear it.
  if (cast && !changing) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
        <motion.div {...materialize}>
          <p className="type-caption text-chalk">{title}</p>
          <h1 className="type-display mt-1" role="status">
            Your ballot is in
          </h1>
          <ul className="type-title mt-4 space-y-1">
            {names(cast).map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>

          <div className="mt-6 flex h-6 gap-5">
            {sending ? (
              <span className="type-caption text-brass">Sending your ballot</span>
            ) : (
              !disabled && (
                <>
                  <button
                    type="button"
                    className="link type-caption"
                    onClick={() => {
                      setSelected(cast);
                      setChanging(true);
                    }}
                  >
                    Change my ballot
                  </button>
                  <button
                    type="button"
                    className="link type-caption"
                    onClick={() => {
                      setSelected([]);
                      onPick([]);
                    }}
                  >
                    Clear my ballot
                  </button>
                </>
              )
            )}
          </div>
        </motion.div>
      </main>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="px-4 pt-6 pb-3">
        <h1 className="type-display">{title}</h1>
        <p className="type-headline mt-1 text-chalk">{seatsOpen === 1 ? "Pick 1" : `Pick up to ${seatsOpen}`}</p>
      </header>

      <ul className="flex-1 space-y-2 px-4 pb-6">
        {ballot.map((candidate) => {
          const on = selected.includes(candidate.id);

          return (
            <li key={candidate.id}>
              <button
                type="button"
                className={`panel flex min-h-16 w-full touch-manipulation items-center gap-3 px-4 py-3 text-left text-xl transition-colors ${on ? "border-brass bg-brass/15 font-semibold" : ""}`}
                aria-pressed={on}
                disabled={disabled}
                onClick={() => toggle(candidate.id)}
              >
                <span className={`size-6 shrink-0 rounded-full ${on ? "ball-yes" : "ball-spent"}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">{candidate.name}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <footer className="glass sticky bottom-0 z-10 rounded-t-[1.75rem] px-4 pt-5 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          className="btn btn-primary btn-lg w-full"
          disabled={disabled || selected.length === 0}
          onClick={submit}
        >
          Cast
        </button>

        <div className="mt-3 flex h-6 justify-center gap-5 text-center">
          {changing && (
            <button type="button" className="link type-caption" onClick={() => setChanging(false)}>
              Keep my ballot
            </button>
          )}
          {!changing && selected.length > 0 && (
            <button type="button" className="link type-caption" onClick={() => setSelected([])}>
              Clear
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
