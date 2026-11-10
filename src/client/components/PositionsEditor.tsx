import { type FormEvent, useState } from "react";
import type { ClientMessage, Position, PositionInput } from "../../shared/protocol";

// The same limits the Worker enforces in validate.ts.
const MAX_NAME = 80;
const MAX_CANDIDATES = 50;
const MAX_POSITIONS = 50;

// Turns the form into a position, or says what is wrong with it.
function parseForm(title: string, seats: string, names: string): { input: PositionInput } | { error: string } {
  const cleanTitle = title.trim();
  if (!cleanTitle || cleanTitle.length > MAX_NAME)
    return { error: `Give the position a title of 1 to ${MAX_NAME} characters.` };

  const candidates = names
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  if (candidates.length < 2) return { error: "Add at least two candidates, one per line." };
  if (candidates.length > MAX_CANDIDATES) return { error: `A position holds at most ${MAX_CANDIDATES} candidates.` };
  if (candidates.some((name) => name.length > MAX_NAME))
    return { error: `Each name must be ${MAX_NAME} characters or fewer.` };
  if (new Set(candidates.map((name) => name.toLowerCase())).size !== candidates.length) {
    return { error: "Each candidate can only appear once." };
  }

  const count = Number(seats);
  if (!Number.isInteger(count) || count < 1 || count > candidates.length - 1) {
    return { error: `Seats must be a whole number from 1 to ${candidates.length - 1}.` };
  }
  return { input: { title: cleanTitle, seats: count, candidates } };
}

// Adding, editing, removing and reordering positions. Only pending positions can change.
export function PositionsEditor({
  positions,
  send,
}: {
  positions: Position[];
  send: (message: ClientMessage) => void;
}) {
  const [title, setTitle] = useState("");
  const [seats, setSeats] = useState("1");
  const [names, setNames] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle("");
    setSeats("1");
    setNames("");
    setEditing(null);
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseForm(title, seats, names);
    if ("error" in parsed) return setError(parsed.error);

    send(
      editing
        ? { type: "updatePosition", positionId: editing, position: parsed.input }
        : { type: "addPosition", position: parsed.input },
    );
    reset();
  };

  const edit = (position: Position) => {
    setTitle(position.title);
    setSeats(String(position.seats));
    setNames(position.ballot.map(({ name }) => name).join("\n"));
    setEditing(position.id);
    setError(null);
  };

  const full = positions.length >= MAX_POSITIONS && !editing;

  return (
    <section>
      <h1 className="type-title">{editing ? "Edit position" : "Add a position"}</h1>

      <form className="mt-3 space-y-3" onSubmit={submit}>
        <div className="flex gap-3">
          <label className="block min-w-0 flex-1 text-chalk">
            Title
            <input
              className="field mt-1"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="President"
            />
          </label>
          <label className="block w-24 text-chalk">
            Seats
            <input
              type="number"
              min={1}
              className="field mt-1"
              value={seats}
              onChange={(event) => setSeats(event.target.value)}
            />
          </label>
        </div>

        <label className="block text-chalk">
          Candidates, one per line
          <textarea
            className="field mt-1 h-32 resize-y text-sm"
            value={names}
            onChange={(event) => setNames(event.target.value)}
          />
        </label>

        {error && (
          <p role="alert" className="text-alert">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary" disabled={full}>
            {editing ? "Save position" : "Add position"}
          </button>
          {editing && (
            <button type="button" className="btn btn-secondary" onClick={reset}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {positions.length > 0 && (
        <ol className="panel mt-6 divide-y divide-hairline">
          {positions.map((position, index) => (
            <li key={position.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <span className="w-6 text-right text-chalk tabular-nums">{position.ordinal}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{position.title}</p>
                <p className="type-caption text-chalk tabular-nums">
                  {position.seats} {position.seats === 1 ? "seat" : "seats"}, {position.ballot.length} candidates
                </p>
              </div>

              {position.status === "pending" && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="link type-caption"
                    aria-label={`Move ${position.title} up`}
                    disabled={index === 0}
                    onClick={() => send({ type: "movePosition", positionId: position.id, direction: -1 })}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="link type-caption"
                    aria-label={`Move ${position.title} down`}
                    disabled={index === positions.length - 1}
                    onClick={() => send({ type: "movePosition", positionId: position.id, direction: 1 })}
                  >
                    Down
                  </button>
                  <button type="button" className="link type-caption" onClick={() => edit(position)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="link type-caption"
                    onClick={() => {
                      if (editing === position.id) reset();
                      send({ type: "removePosition", positionId: position.id });
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
