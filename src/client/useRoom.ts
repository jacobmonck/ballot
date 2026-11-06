import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  CLOSE_KICKED,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type Snapshot,
  type VoteValue,
} from "../shared/protocol";

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 8_000;
const VOTE_REJECTIONS: ErrorCode[] = ["budget_exhausted", "not_seen", "not_in_revote", "session_ended"];
const JOIN_REFUSALS: ErrorCode[] = ["bad_host_key", "bad_projector_key", "kicked", "session_ended", "room_full", "room_locked"];
const ROOM_CHECK_AFTER_ATTEMPTS = 3;

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

type Action =
  | { kind: "connection"; connection: Connection }
  | { kind: "refused"; message: string }
  | { kind: "voteTapped"; pnmId: string; value: VoteValue | null }
  | { kind: "server"; message: ServerMessage };

function applyToRoom(room: Snapshot, message: ServerMessage): Snapshot {
  switch (message.type) {
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

function reducer(state: RoomState, action: Action): RoomState {
  if (action.kind === "connection") {
    return state.connection === "refused" ? state : { ...state, connection: action.connection };
  }
  if (action.kind === "refused") return { ...state, connection: "refused", refusal: action.message };
  if (action.kind === "voteTapped") {
    return { ...state, pendingVotes: { ...state.pendingVotes, [action.pnmId]: action.value } };
  }

  const { message } = action;
  if (message.type === "snapshot") {
    return { ...state, room: message, connection: "open", snapshotCount: state.snapshotCount + 1 };
  }
  if (message.type === "error") {
    return {
      ...state,
      notice: { id: (state.notice?.id ?? 0) + 1, message: message.message },
      pendingVotes: VOTE_REJECTIONS.includes(message.code) ? {} : state.pendingVotes,
    };
  }
  if (message.type === "myVote" && state.pendingVotes[message.pnmId] === message.value) {
    const { [message.pnmId]: _confirmed, ...pendingVotes } = state.pendingVotes;
    return { ...state, pendingVotes, room: state.room && applyToRoom(state.room, message) };
  }
  return state.room ? { ...state, room: applyToRoom(state.room, message) } : state;
}

const initialState: RoomState = {
  connection: "connecting",
  room: null,
  notice: null,
  refusal: null,
  pendingVotes: {},
  snapshotCount: 0,
};

// `join` is null until the caller knows who this device is, e.g. a host key has been entered.
export function useRoom(code: string, join: ClientMessage | null) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<WebSocket | null>(null);
  const joinedRef = useRef(false);
  const joinKey = join && JSON.stringify(join);

  useEffect(() => {
    if (!joinKey) return;

    let stopped = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    let joinTimer: ReturnType<typeof setTimeout> | undefined;

    const clearSocketTimers = () => {
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
      clearTimeout(joinTimer);
    };

    // An expired room refuses the socket with nothing to read, so ask directly before retrying forever.
    const checkRoomExists = async () => {
      try {
        const response = await fetch(`/api/rooms/${code}`);
        if (response.status !== 404 || stopped) return;
        stopped = true;
        clearTimeout(reconnectTimer);
        dispatch({ kind: "refused", message: "This room no longer exists." });
      } catch {
        // Offline, so keep retrying.
      }
    };

    const scheduleReconnect = () => {
      const backoff = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
      attempt++;
      if (attempt === ROOM_CHECK_AFTER_ATTEMPTS) void checkRoomExists();
      // Jitter so a wifi blip doesn't bring every phone back at the same instant.
      reconnectTimer = setTimeout(connect, backoff * (0.5 + Math.random()));
    };

    // Abandons a socket without waiting for its close event, which a dead peer may never produce.
    const retire = (socket: WebSocket) => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      joinedRef.current = false;
      socket.onopen = socket.onmessage = socket.onclose = null;
      clearSocketTimers();
      socket.close();
      dispatch({ kind: "connection", connection: "reconnecting" });
      scheduleReconnect();
    };

    const checkAlive = () => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send("ping");
      clearTimeout(pongTimer);
      pongTimer = setTimeout(() => retire(socket), PONG_TIMEOUT_MS);
    };

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${location.host}/api/rooms/${code}/ws`);
      socketRef.current = socket;
      joinTimer = setTimeout(() => retire(socket), CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        socket.send(joinKey);
        pingTimer = setInterval(checkAlive, PING_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        if (event.data === "pong") {
          clearTimeout(pongTimer);
          return;
        }
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === "error" && !joinedRef.current && JOIN_REFUSALS.includes(message.code)) {
          stopped = true;
          clearSocketTimers();
          dispatch({ kind: "refused", message: message.message });
          socket.close();
          return;
        }
        if (message.type === "snapshot") {
          joinedRef.current = true;
          attempt = 0;
          clearTimeout(joinTimer);
        }
        dispatch({ kind: "server", message });
      };

      socket.onclose = (event) => {
        if (stopped) return;
        if (event.code === CLOSE_KICKED) {
          stopped = true;
          clearSocketTimers();
          dispatch({ kind: "refused", message: "You were removed from this room." });
          return;
        }
        retire(socket);
      };
    };

    // Phones suspend timers in the background, so check the moment they wake instead of waiting out a backoff.
    const onWake = () => {
      if (document.visibilityState !== "visible" || stopped) return;
      if (socketRef.current) {
        checkAlive();
      } else {
        clearTimeout(reconnectTimer);
        attempt = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    connect();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
      clearTimeout(reconnectTimer);
      clearSocketTimers();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [code, joinKey]);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const vote = useCallback(
    (pnmId: string, value: VoteValue | null) => {
      dispatch({ kind: "voteTapped", pnmId, value });
      send({ type: "vote", pnmId, value });
    },
    [send],
  );

  useEffect(() => {
    for (const [pnmId, value] of Object.entries(state.pendingVotes)) send({ type: "vote", pnmId, value });
    // Resend only on a fresh join, not whenever a tap adds to the pending list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.snapshotCount, send]);

  return { ...state, send, vote };
}
