import type { RoomMode } from "../../shared/protocol";

const MODES: { value: RoomMode; label: string }[] = [
  { value: "recruitment", label: "Recruitment" },
  { value: "election", label: "Elections" },
];

// Two segmented buttons for what the room is for. Only shown before anything has been added.
export function ModePicker({ mode, onChange }: { mode: RoomMode; onChange: (mode: RoomMode) => void }) {
  return (
    <div className="flex gap-2" role="group" aria-label="Room mode">
      {MODES.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          className={`btn flex-1 ${mode === value ? "btn-primary" : "btn-secondary"}`}
          aria-pressed={mode === value}
          onClick={() => value !== mode && onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
