import type { Transition } from "motion/react";

// Critically damped: the default for anything that wasn't thrown.
export const settle: Transition = { type: "spring", bounce: 0, visualDuration: 0.35 };
// A little overshoot, kept for motion the person physically caused.
export const flick: Transition = { type: "spring", bounce: 0.22, visualDuration: 0.32 };

// Where a release at this velocity would come to rest, using scroll-style decay.
export function project(velocity: number, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

export function haptic() {
  navigator.vibrate?.(10);
}

export const materialize = {
  initial: { opacity: 0, y: -10, scale: 0.96, filter: "blur(8px)" },
  animate: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" },
  exit: { opacity: 0, y: -10, scale: 0.96, filter: "blur(8px)" },
};
