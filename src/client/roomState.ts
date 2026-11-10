import type { ErrorCode, ServerMessage, Snapshot, VoteValue } from "../shared/protocol";

// Client room state and how server messages change it. Kept free of React and the DOM so it can be tested directly.

// Refusals that mean a tapped vote never landed, so it shouldn't be resent.
const VOTE_REJECTIONS: ErrorCode[] = ["budget_exhausted", "not_seen", "not_in_revote", "session_ended"];

// Refusals that mean tapped picks never landed.
const PICK_REJECTIONS: ErrorCode[] = ["not_voting", "bad_ballot", "session_ended"];

const sameIds = (a: string[] | undefined, b: string[]) =>
  a !== undefined && a.length === b.length && a.every((id) => b.includes(id));

export type Connection = "connecting" | "open" | "reconnecting" | "refused";

export interface RoomState {
  connection: Connection;
  room: Snapshot | null;
  notice: { id: number; message: string } | null;
  refusal: string | null;
  // Votes tapped but not yet confirmed. They are resent after every snapshot and overwrite safely.
  pendingVotes: Record<string, VoteValue | null>;
  // Election picks tapped but not yet confirmed, resent after every snapshot like votes.
  pendingPicks: Record<string, { round: number; candidateIds: string[] }>;
  snapshotCount: number;
}

export type Action =
  | { kind: "connection"; connection: Connection }
  | { kind: "refused"; message: string }
  | { kind: "voteTapped"; pnmId: string; value: VoteValue | null }
  | { kind: "picksTapped"; positionId: string; round: number; candidateIds: string[] }
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

    // Progress for a position that's no longer on screen arrived late, so it's dropped.
    case "positionProgress":
      return message.positionId === room.focusPositionId
        ? {
            ...room,
            positionProgress: { positionId: message.positionId, voted: message.voted, total: message.total },
          }
        : room;

    case "positionTally": {
      const detail = room.hostOnly?.positionDetails[message.positionId];
      return room.hostOnly && detail
        ? {
            ...room,
            hostOnly: {
              ...room.hostOnly,
              positionDetails: {
                ...room.hostOnly.positionDetails,
                [message.positionId]: { ...detail, live: { ballots: message.ballots, picks: message.picks } },
              },
            },
          }
        : room;
    }

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

    // A cleared pick is removed rather than stored as an empty list.
    case "myPicks": {
      const myPicks = { ...room.myPicks };
      if (message.candidateIds.length === 0) delete myPicks[message.positionId];
      else myPicks[message.positionId] = message.candidateIds;
      return { ...room, myPicks };
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

  if (action.kind === "picksTapped") {
    return {
      ...state,
      pendingPicks: {
        ...state.pendingPicks,
        [action.positionId]: { round: action.round, candidateIds: action.candidateIds },
      },
    };
  }

  const { message } = action;

  // A snapshot replaces the whole room, and counting them tells the hook when to resend pending votes.
  // Pending picks from a round that has since closed are dropped, so they can't be replayed into the next one.
  if (message.type === "snapshot") {
    const pendingPicks = Object.fromEntries(
      Object.entries(state.pendingPicks).filter(([positionId, pending]) => {
        const position = message.positions.find(({ id }) => id === positionId);
        return position?.status === "voting" && position.round === pending.round;
      }),
    );
    return { ...state, room: message, connection: "open", pendingPicks, snapshotCount: state.snapshotCount + 1 };
  }

  // Errors show as a notice. A rejected vote also drops every pending one, since the server said no.
  if (message.type === "error") {
    return {
      ...state,
      notice: { id: (state.notice?.id ?? 0) + 1, message: message.message },
      pendingVotes: VOTE_REJECTIONS.includes(message.code) ? {} : state.pendingVotes,
      pendingPicks: PICK_REJECTIONS.includes(message.code) ? {} : state.pendingPicks,
    };
  }

  // The server confirmed a vote this device sent, so it's no longer pending.
  if (message.type === "myVote" && state.pendingVotes[message.pnmId] === message.value) {
    const { [message.pnmId]: _confirmed, ...pendingVotes } = state.pendingVotes;
    return { ...state, pendingVotes, room: state.room && applyToRoom(state.room, message) };
  }

  // The server confirmed these picks, in whatever order it stored them, so they're no longer pending.
  if (
    message.type === "myPicks" &&
    sameIds(state.pendingPicks[message.positionId]?.candidateIds, message.candidateIds)
  ) {
    const { [message.positionId]: _confirmed, ...pendingPicks } = state.pendingPicks;
    return { ...state, pendingPicks, room: state.room && applyToRoom(state.room, message) };
  }

  return state.room ? { ...state, room: applyToRoom(state.room, message) } : state;
}

export const initialState: RoomState = {
  connection: "connecting",
  room: null,
  notice: null,
  refusal: null,
  pendingVotes: {},
  pendingPicks: {},
  snapshotCount: 0,
};
