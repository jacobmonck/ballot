import { motion } from "motion/react";
import { useRef } from "react";
import type { VoteValue } from "../../shared/protocol";
import { flick, haptic, settle } from "../feel";

// Half the distance between marble centers: (5.5rem marble + 2.5rem gap) / 2.
const RING_OFFSET = { yes: "-4rem", no: "4rem" };

export function VoteButtons({
  value,
  yesDisabled,
  disabled,
  sending,
  onVote,
}: {
  value: VoteValue | undefined;
  yesDisabled: boolean;
  disabled: boolean;
  sending: boolean;
  onVote: (value: VoteValue | null) => void;
}) {
  // The ring stays where it was while it fades, so clearing a vote doesn't slide it.
  const ringSide = useRef<VoteValue>("yes");
  if (value) ringSide.current = value;

  const tap = (next: VoteValue) => {
    haptic();
    onVote(next);
  };

  return (
    <div>
      <div className="relative flex justify-center gap-10">
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 z-10 -mt-[3.375rem] -ml-[3.375rem] size-[6.75rem] rounded-full border-[3px] border-brass"
          initial={false}
          animate={{ x: RING_OFFSET[ringSide.current], opacity: value ? 1 : 0, scale: value ? 1 : 0.8 }}
          transition={flick}
        />
        <Marble
          label="Yes"
          ball="ball-yes"
          selected={value === "yes"}
          receded={value === "no"}
          unavailable={yesDisabled}
          disabled={disabled || yesDisabled}
          onClick={() => tap("yes")}
        />
        <Marble
          label="No"
          ball="ball-no"
          selected={value === "no"}
          receded={value === "yes"}
          unavailable={false}
          disabled={disabled}
          onClick={() => tap("no")}
        />
      </div>
      <div className="mt-3 h-6 text-center">
        {sending ? (
          <span role="status" className="type-caption text-brass">
            Sending your vote
          </span>
        ) : value && !disabled && (
          <button type="button" className="link type-caption" onClick={() => onVote(null)}>
            Clear my vote
          </button>
        )}
      </div>
    </div>
  );
}

function Marble({
  label,
  ball,
  selected,
  receded,
  unavailable,
  disabled,
  onClick,
}: {
  label: string;
  ball: string;
  selected: boolean;
  receded: boolean;
  unavailable: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      className={`flex size-[5.5rem] touch-manipulation items-center justify-center rounded-full font-display text-[1.75rem] font-bold tracking-tight ${ball}`}
      aria-pressed={selected}
      disabled={disabled}
      initial={false}
      animate={{ scale: selected ? 1.04 : receded ? 0.88 : 1, opacity: unavailable ? 0.35 : receded ? 0.75 : 1 }}
      whileTap={disabled ? undefined : { scale: 0.9, transition: { ...settle, visualDuration: 0.12 } }}
      transition={flick}
      onClick={onClick}
    >
      {label}
    </motion.button>
  );
}
