import type { Transition } from "motion/react";

// Critically damped: the default for anything that wasn't thrown.
export const settle: Transition = { type: "spring", bounce: 0, visualDuration: 0.35 };
// A little overshoot, kept for motion the person physically caused.
export const flick: Transition = { type: "spring", bounce: 0.22, visualDuration: 0.32 };

// Where a release at this velocity would come to rest, using scroll-style decay.
export function project(velocity: number, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

// In pixels, upward.
const FLICK_DISTANCE = 120;
const FLICK_MIN_DRAG = 12;

// Whether a vertical release throws the marble up and away: far enough once its speed is counted,
// and moved on purpose rather than a twitch at the start of a tap.
export function isFlick(offsetY: number, velocityY: number) {
  return offsetY < -FLICK_MIN_DRAG && offsetY + project(velocityY) < -FLICK_DISTANCE;
}

// A short tap on phones that support it. Does nothing elsewhere, including iOS Safari.
// Typed by hand because the tests are type-checked without the DOM library.
export function haptic() {
  (navigator as { vibrate?: (pattern: number) => boolean }).vibrate?.(10);
}

// Enter and exit for content that appears in place, such as a new PNM card.
export const materialize = {
  initial: { opacity: 0, y: -10, scale: 0.96, filter: "blur(8px)" },
  animate: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" },
  exit: { opacity: 0, y: -10, scale: 0.96, filter: "blur(8px)" },
};
