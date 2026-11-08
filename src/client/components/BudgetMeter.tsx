import { motion } from "motion/react";
import { flick } from "../feel";

const MAX_MARBLES = 60;

// A brother's remaining Yes votes, drawn as marbles when there are few enough to count at a glance.
export function BudgetMeter({ used, budget, isDefault }: { used: number; budget: number; isDefault: boolean }) {
  if (isDefault) return <p className="type-caption text-center text-chalk">Vote Yes as often as you like.</p>;

  const left = Math.max(0, budget - used);
  return (
    <div>
      {budget <= MAX_MARBLES && (
        <div className="flex flex-wrap justify-center gap-1" aria-hidden="true">
          {Array.from({ length: budget }, (_, index) => (
            <motion.span
              key={index}
              className={`size-3 rounded-full ${index < left ? "ball-yes" : "ball-spent"}`}
              initial={false}
              animate={{ scale: index < left ? 1 : 0.75 }}
              transition={flick}
            />
          ))}
        </div>
      )}
      <p className="type-caption mt-1.5 text-center text-chalk">
        {left} of {budget} Yes votes left
      </p>
    </div>
  );
}
