import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  CLOSE_KICKED,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type VoteValue,
} from "../shared/protocol";
import { initialState, reducer } from "./roomState";

export type { Connection, RoomState } from "./roomState";

// Heartbeats catch a socket that died without closing, which phones do when wifi drops.
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 8_000;

// Refusals that retrying can't fix, so the socket stops and the screen says why.
const JOIN_REFUSALS: ErrorCode[] = [
  "bad_host_key",
  "bad_projector_key",
  "kicked",
  "session_ended",
  "room_full",
  "room_locked",
];
// Failed reconnects before asking whether the room still exists.
const ROOM_CHECK_AFTER_ATTEMPTS = 3;

// `join` is null until the caller knows who this device is, e.g. a host key has been entered.
export function useRoom(code: string, join: ClientMessage | null) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<WebSocket | null>(null);
  // True once this socket's join was accepted, so a later error isn't mistaken for a refusal.
  const joinedRef = useRef(false);
  // A string, so a new but equal join object doesn't reconnect.
  const joinKey = join && JSON.stringify(join);

  // Connects, joins, and keeps reconnecting with backoff until the room refuses or the screen closes.
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

    // Sends a ping and gives up on the socket if no pong comes back in time.
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
      // A socket that opens but never answers the join counts as dead too.
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

        // Turned away at the door: stop for good and show why.
        if (message.type === "error" && !joinedRef.current && JOIN_REFUSALS.includes(message.code)) {
          stopped = true;
          clearSocketTimers();
          dispatch({ kind: "refused", message: message.message });
          socket.close();
          return;
        }

        // The first snapshot means the join worked, so the next drop starts its backoff fresh.
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

  // Drops the message while disconnected. Votes are the only thing worth keeping, and they resend.
  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  // Shows a vote straight away as pending, then sends it.
  const vote = useCallback(
    (pnmId: string, value: VoteValue | null) => {
      dispatch({ kind: "voteTapped", pnmId, value });
      send({ type: "vote", pnmId, value });
    },
    [send],
  );

  // Shows picks straight away as pending, then sends them.
  const pick = useCallback(
    (positionId: string, round: number, candidateIds: string[]) => {
      dispatch({ kind: "picksTapped", positionId, round, candidateIds });
      send({ type: "pick", positionId, round, candidateIds });
    },
    [send],
  );

  // After every join or rejoin, sends any vote the server hasn't confirmed yet.
  useEffect(() => {
    for (const [pnmId, value] of Object.entries(state.pendingVotes)) send({ type: "vote", pnmId, value });
    for (const [positionId, { round, candidateIds }] of Object.entries(state.pendingPicks)) {
      send({ type: "pick", positionId, round, candidateIds });
    }
    // Resend only on a fresh join, not whenever a tap adds to the pending list.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [state.snapshotCount, send]);

  return { ...state, send, vote, pick };
}
