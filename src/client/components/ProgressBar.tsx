import { motion } from "motion/react";
import { settle } from "../feel";

// An accessible bar that springs between values.
export function ProgressBar({
  value,
  max,
  label,
  className = "h-1.5",
}: {
  value: number;
  max: number;
  label: string;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-full bg-ivory/10 ${className}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
    >
      <motion.div
        className="h-full origin-left rounded-full bg-brass"
        initial={false}
        animate={{ scaleX: max ? value / max : 0 }}
        transition={settle}
      />
    </div>
  );
}
