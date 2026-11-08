import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { VoteValue } from "../../shared/protocol";
import { flick, haptic, isFlick, materialize, settle } from "../feel";

// Half the distance between marble centers: (5.5rem marble + 2.5rem gap) / 2.
const RING_OFFSET = { yes: "-4rem", no: "4rem" };
// How far each marble slides to reach the center once picked.
const TO_CENTER = { yes: "4rem", no: "-4rem" };
const PICKED_SCALE = 1.12;
const LAUNCH = { duration: 0.36, ease: "easeIn" } as const;
const LABEL: Record<VoteValue, string> = { yes: "Yes", no: "No" };
const OTHER: Record<VoteValue, VoteValue> = { yes: "no", no: "yes" };

interface Props {
  value: VoteValue | undefined;
  yesDisabled: boolean;
  disabled: boolean;
  sending: boolean;
  onVote: (value: VoteValue | null) => void;
}

// The ballot. Tapping a marble picks it, and flicking it up (or tapping it again) casts the vote.
// With reduced motion a tap casts straight away.
export function VoteButtons(props: Props) {
  const reducedMotion = useReducedMotion();
  return reducedMotion ? <TapButtons {...props} /> : <FlickButtons {...props} />;
}

function FlickButtons({ value, yesDisabled, disabled, sending, onVote }: Props) {
  // The marble picked but not cast yet.
  const [picked, setPicked] = useState<VoteValue | null>(null);
  // True while a brother who already voted is choosing again.
  const [changing, setChanging] = useState(false);
  // True while a cast marble flies off the top of the screen.
  const [launching, setLaunching] = useState(false);
  // Set when a press turns into a drag, so the click that follows doesn't count as a tap.
  const dragged = useRef(false);

  // Spending the last Yes elsewhere takes back a Yes that was picked but not cast.
  useEffect(() => {
    if (yesDisabled && picked === "yes" && !launching) setPicked(null);
  }, [yesDisabled, picked, launching]);

  const pick = (side: VoteValue) => {
    if (disabled) return;
    haptic();
    setPicked(side);
  };

  // The vote goes out the moment it's cast. The flight is only for show, so a PNM change mid-flight
  // can't lose it.
  const cast = () => {
    if (disabled || launching || !picked) return;
    haptic();
    onVote(picked);
    setLaunching(true);
  };

  const landed = () => {
    setPicked(null);
    setChanging(false);
    setLaunching(false);
  };

  // A vote that's in shows as a small marble with ways to change or clear it.
  if (value && !changing && !picked) {
    return (
      <motion.div className="flex h-[11.5rem] flex-col items-center justify-center text-center" {...materialize}>
        <span className={`size-7 rounded-full ${value === "yes" ? "ball-yes" : "ball-no"}`} aria-hidden="true" />
        <p className="type-headline mt-3" role="status">
          Your {LABEL[value]} is in
        </p>

        <div className="mt-2 flex h-6 gap-5">
          {sending ? (
            <span className="type-caption text-brass">Sending your vote</span>
          ) : (
            !disabled && (
              <>
                <button type="button" className="link type-caption" onClick={() => setChanging(true)}>
                  Change my vote
                </button>
                <button type="button" className="link type-caption" onClick={() => onVote(null)}>
                  Clear my vote
                </button>
              </>
            )
          )}
        </div>
      </motion.div>
    );
  }

  return (
    <div className="flex h-[11.5rem] flex-col justify-end">
      {/* The slot a picked marble is flicked into. */}
      <div className="flex h-12 flex-col items-center justify-start">
        <AnimatePresence>
          {picked && !launching && (
            <motion.div
              className="flex flex-col items-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={settle}
            >
              <span className="h-3 w-28 rounded-full bg-black shadow-[inset_0_2px_4px_rgb(0_0_0/0.9),0_1px_0_rgb(247_244_236/0.12)]" />

              <span className="type-caption mt-1 flex items-center gap-1 text-brass">
                <span className="nudge-up inline-block" aria-hidden="true">
                  ↑
                </span>
                Flick it up to cast
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* The two marbles. Picking one slides it to the center and hides the other. */}
      <div className="relative mt-2 flex justify-center gap-10">
        {(["yes", "no"] as const).map((side) => {
          const isPicked = picked === side;
          const hidden = picked !== null && !isPicked;
          const unavailable = side === "yes" && yesDisabled;

          return (
            <motion.button
              key={side}
              type="button"
              className={`flex size-[5.5rem] touch-manipulation items-center justify-center rounded-full font-display text-[1.75rem] font-bold tracking-tight ${side === "yes" ? "ball-yes" : "ball-no"} ${isPicked ? "z-10 touch-none" : ""} ${hidden ? "pointer-events-none" : ""}`}
              aria-label={isPicked ? `Cast ${LABEL[side]}` : `Pick ${LABEL[side]}`}
              aria-hidden={hidden}
              tabIndex={hidden ? -1 : undefined}
              disabled={disabled || unavailable}
              initial={false}
              animate={
                isPicked && launching
                  ? { x: TO_CENTER[side], y: "-70vh", scale: 0.5, opacity: 0 }
                  : {
                      x: isPicked ? TO_CENTER[side] : 0,
                      y: 0,
                      scale: isPicked ? PICKED_SCALE : hidden ? 0.6 : 1,
                      opacity: hidden ? 0 : unavailable ? 0.35 : 1,
                    }
              }
              transition={isPicked && launching ? LAUNCH : flick}
              whileTap={disabled || launching ? undefined : { scale: isPicked ? PICKED_SCALE * 0.94 : 0.9 }}
              drag={isPicked && !launching && !disabled ? "y" : false}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0.9, bottom: 0.1 }}
              onPointerDown={() => {
                dragged.current = false;
              }}
              onDragStart={() => {
                dragged.current = true;
              }}
              onDragEnd={(_, { offset, velocity }) => {
                if (isFlick(offset.y, velocity.y)) cast();
              }}
              onAnimationComplete={() => {
                if (isPicked && launching) landed();
              }}
              onClick={() => {
                // A drag that didn't make it can end in a click too, which must not cast.
                if (dragged.current) return;
                if (isPicked) cast();
                else pick(side);
              }}
            >
              {LABEL[side]}
            </motion.button>
          );
        })}
      </div>

      {/* One link at a time: sending, switch sides, or back out of changing a vote. */}
      <div className="mt-3 flex h-6 justify-center gap-5 text-center">
        {sending ? (
          <span role="status" className="type-caption text-brass">
            Sending your vote
          </span>
        ) : picked && !launching ? (
          !(picked === "no" && yesDisabled) && (
            <button type="button" className="link type-caption" onClick={() => pick(OTHER[picked])}>
              Pick {LABEL[OTHER[picked]]}
            </button>
          )
        ) : (
          changing &&
          !launching && (
            <button type="button" className="link type-caption" onClick={() => setChanging(false)}>
              Keep my {value ? LABEL[value] : "vote"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

// Today's ballot, kept for reduced motion: a tap casts.
function TapButtons({ value, yesDisabled, disabled, sending, onVote }: Props) {
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
        ) : (
          value &&
          !disabled && (
            <button type="button" className="link type-caption" onClick={() => onVote(null)}>
              Clear my vote
            </button>
          )
        )}
      </div>
    </div>
  );
}

// One big tappable marble on the reduced motion ballot.
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
