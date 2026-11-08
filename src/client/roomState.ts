import type { ErrorCode, ServerMessage, Snapshot, VoteValue } from "../shared/protocol";

// Client room state and how server messages change it. Kept free of React and the DOM so it can be tested directly.

// Refusals that mean a tapped vote never landed, so it shouldn't be resent.
const VOTE_REJECTIONS: ErrorCode[] = ["budget_exhausted", "not_seen", "not_in_revote", "session_ended"];

export type Connection = "connecting" | "open" | "reconnecting" | "refused";

export interface RoomState {
  connection: Connection;
  room: Snapshot | null;
  notice: { id: number; message: string } | null;
  refusal: string | null;
  // Votes tapped but not yet confirmed. They are resent after every snapshot and overwrite safely.
  pendingVotes: Record<string, VoteValue | null>;
  snapshotCount: number;
}

export type Action =
  | { kind: "connection"; connection: Connection }
  | { kind: "refused"; message: string }
  | { kind: "voteTapped"; pnmId: string; value: VoteValue | null }
  | { kind: "server"; message: ServerMessage };

// Applies one server patch to the snapshot. Messages that don't change the room return it as is.
function applyToRoom(room: Snapshot, message: ServerMessage): Snapshot {
  switch (message.type) {
    // A new PNM on screen joins the list, which brothers only see up to the current one.
    case "focus": {
      const pnms = room.pnms.filter((pnm) => pnm.id !== message.pnm.id).concat(message.pnm);
      pnms.sort((a, b) => a.ordinal - b.ordinal);
      return { ...room, pnms, phase: "live", focusPnmId: message.pnm.id, progress: message.progress, revealed: null };
    }

    case "members":
      return { ...room, members: message.members };

    case "joinLock":
      return { ...room, joinLocked: message.locked };

    case "pnmPhoto":
      return {
        ...room,
        pnms: room.pnms.map((pnm) => (pnm.id === message.pnmId ? { ...pnm, photoUrl: message.photoUrl } : pnm)),
      };

    case "budget":
      return { ...room, yesBudget: message.yesBudget, budgetIsDefault: message.budgetIsDefault };

    // Progress for a PNM that's no longer on screen arrived late, so it's dropped.
    case "progress":
      return message.pnmId === room.focusPnmId
        ? { ...room, progress: { pnmId: message.pnmId, voted: message.voted, total: message.total } }
        : room;

    case "tally":
      return room.hostOnly
        ? {
            ...room,
            hostOnly: {
              ...room.hostOnly,
              tallies: { ...room.hostOnly.tallies, [message.pnmId]: { yes: message.yes, no: message.no } },
            },
          }
        : room;

    case "revealed":
      return { ...room, revealed: { pnmId: message.pnmId, yes: message.yes, no: message.no } };

    case "classRevealed":
      return { ...room, classReveal: message.members };

    // A cleared vote is removed rather than stored as null.
    case "myVote": {
      const myVotes = { ...room.myVotes };
      if (message.value === null) delete myVotes[message.pnmId];
      else myVotes[message.pnmId] = message.value;
      return { ...room, myVotes, yesUsed: message.yesUsed };
    }

    case "ended":
      return {
        ...room,
        phase: "ended",
        hostOnly: room.hostOnly && { ...room.hostOnly, results: message.results ?? null },
      };

    default:
      return room;
  }
}

// The room hook's reducer: connection changes, votes tapped on this device, and server messages.
export function reducer(state: RoomState, action: Action): RoomState {
  // A refused room stays refused, even if the socket reports another state on its way out.
  if (action.kind === "connection") {
    return state.connection === "refused" ? state : { ...state, connection: action.connection };
  }

  if (action.kind === "refused") return { ...state, connection: "refused", refusal: action.message };

  if (action.kind === "voteTapped") {
    return { ...state, pendingVotes: { ...state.pendingVotes, [action.pnmId]: action.value } };
  }

  const { message } = action;

  // A snapshot replaces the whole room, and counting them tells the hook when to resend pending votes.
  if (message.type === "snapshot") {
    return { ...state, room: message, connection: "open", snapshotCount: state.snapshotCount + 1 };
  }

  // Errors show as a notice. A rejected vote also drops every pending one, since the server said no.
  if (message.type === "error") {
    return {
      ...state,
      notice: { id: (state.notice?.id ?? 0) + 1, message: message.message },
      pendingVotes: VOTE_REJECTIONS.includes(message.code) ? {} : state.pendingVotes,
    };
  }

  // The server confirmed a vote this device sent, so it's no longer pending.
  if (message.type === "myVote" && state.pendingVotes[message.pnmId] === message.value) {
    const { [message.pnmId]: _confirmed, ...pendingVotes } = state.pendingVotes;
    return { ...state, pendingVotes, room: state.room && applyToRoom(state.room, message) };
  }

  return state.room ? { ...state, room: applyToRoom(state.room, message) } : state;
}

export const initialState: RoomState = {
  connection: "connecting",
  room: null,
  notice: null,
  refusal: null,
  pendingVotes: {},
  snapshotCount: 0,
};
