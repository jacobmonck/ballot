import { useSound } from "../sound";

// Browsers won't play sound until someone clicks, so the projector asks once, then keeps a small
// mute switch in the corner for the rest of the night.
export function SoundToggle() {
  const { status, enable, toggleMute } = useSound();

  if (status === "off") {
    return (
      <button type="button" className="btn btn-secondary fixed right-[1.5vw] bottom-[1.5vw] z-20" onClick={enable}>
        Turn on sound
      </button>
    );
  }

  const on = status === "on";
  return (
    <button
      type="button"
      className={`btn btn-secondary fixed right-[1.5vw] bottom-[1.5vw] z-20 size-11 p-0 ${on ? "" : "text-chalk"}`}
      aria-pressed={on}
      aria-label={on ? "Sound on" : "Sound off"}
      onClick={toggleMute}
    >
      <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
        <path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor" />
        <path
          d={on ? "M13 7.5a3.5 3.5 0 0 1 0 5M15.5 5a7 7 0 0 1 0 10" : "M13 8l4 4M17 8l-4 4"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
