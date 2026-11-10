import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import type { Position, Snapshot } from "../../shared/protocol";
import { CenteredMessage, ConnectionBanner } from "../components/Status";
import { flick, settle } from "../feel";
import { watchReveal } from "../revealWatch";
import { sound } from "../sound";
import type { Connection } from "../useRoom";
import { Lobby, Stage } from "./Projector";

const LOBBY_MIN_CAPACITY = 40;
const SLATE_STEP_S = 0.45;

// The room's big screen in election mode. Candidate names appear only for revealed winners and the slate.
export function ProjectorElection({ room, connection }: { room: Snapshot; connection: Connection }) {
  const reducedMotion = useReducedMotion();
  const position = room.positions.find(({ id }) => id === room.focusPositionId) ?? null;

  // Only a reveal this screen watched happen rings the bell. One found on load shows finished.
  const watched = useRef<string | null>(null);
  const revealed = !!position?.revealed;
  watched.current = watchReveal(watched.current, position?.id ?? null, revealed, connection);
  const live = revealed && watched.current === position?.id;

  useEffect(() => {
    if (live) sound.bell();
  }, [live, position?.id]);

  if (room.slate) return <Slate room={room} connection={connection} reducedMotion={!!reducedMotion} />;

  if (room.phase === "ended") {
    return (
      <Stage scene="ended" count={0} capacity={1} glow={0} celebrate={false}>
        <CenteredMessage title="Voting is closed" />
      </Stage>
    );
  }

  if (room.phase === "setup" || !position) {
    return (
      <Stage
        scene="lobby"
        count={room.members.length}
        capacity={Math.max(room.members.length, LOBBY_MIN_CAPACITY)}
        glow={0.25}
        celebrate={false}
      >
        <ConnectionBanner connection={connection} />
        <Lobby room={room} />
      </Stage>
    );
  }

  const progress = room.positionProgress?.positionId === position.id ? room.positionProgress : null;
  const voted = progress?.voted ?? 0;
  const total = progress?.total ?? 0;
  const voting = position.status === "voting";
  const allIn = voting && total > 0 && voted >= total;

  return (
    <Stage
      scene={`${position.id}-${position.round}-${position.status}-${revealed}`}
      count={voting ? voted : 0}
      capacity={Math.max(total, 1)}
      glow={voting && total ? voted / total : 0}
      celebrate={allIn || revealed}
      clacks={voting}
    >
      <ConnectionBanner connection={connection} />
      <main className="flex min-h-dvh flex-col justify-center overflow-hidden px-[6vw] pb-[8vh]" aria-live="polite">
        <PositionBody position={position} voted={voted} total={total} allIn={allIn} />
      </main>
    </Stage>
  );
}

function Rise({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: "0.4em" }} animate={{ opacity: 1, y: 0 }} transition={{ ...settle, delay }}>
      {children}
    </motion.div>
  );
}

function PositionBody({
  position,
  voted,
  total,
  allIn,
}: {
  position: Position;
  voted: number;
  total: number;
  allIn: boolean;
}) {
  const title = (
    <h1 className="font-display text-[7vw] leading-[1.02] font-bold tracking-[-0.03em] wrap-anywhere">
      {position.title}
    </h1>
  );

  if (position.revealed) {
    const names = position.winners ?? [];
    return (
      <>
        <p className="text-[2vw] text-chalk">{position.title}</p>
        <ul className="mt-[1vw] flex flex-col gap-[1vw]">
          {names.map((winner, index) => (
            <motion.li
              key={winner.id}
              className="font-display text-[8vw] leading-[1.02] font-bold tracking-[-0.03em] text-brass wrap-anywhere"
              initial={{ opacity: 0, y: "0.4em" }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...settle, delay: 0.2 + index * 0.25 }}
            >
              {winner.name}
            </motion.li>
          ))}
        </ul>
      </>
    );
  }

  if (position.status === "voting") {
    return (
      <>
        <Rise>{title}</Rise>
        <p className="mt-[1.5vw] text-[2.5vw] text-chalk">Pick up to {position.seatsOpen}</p>
        <p className="mt-[2.5vw] flex items-baseline gap-[0.8vw] text-[2.5vw] font-medium tabular-nums">
          <motion.span
            key={voted}
            className={`font-display text-[5.5vw] leading-none font-bold tracking-[-0.03em] ${allIn ? "text-brass" : ""}`}
            initial={{ scale: voted ? 1.18 : 1 }}
            animate={{ scale: 1 }}
            transition={flick}
          >
            {voted}
          </motion.span>
          of {total} voted
        </p>
      </>
    );
  }

  return (
    <>
      <Rise>{title}</Rise>
      <p className="mt-[1.5vw] font-display text-[4vw] font-bold tracking-[-0.02em] text-brass">
        {position.status === "runoff" ? "No majority. Revote coming." : "Voting closed"}
      </p>
    </>
  );
}

// Every decided position and who won it, one entry at a time.
function Slate({
  room,
  connection,
  reducedMotion,
}: {
  room: Snapshot;
  connection: Connection;
  reducedMotion: boolean;
}) {
  return (
    <Stage scene="slate" count={0} capacity={1} glow={0.5} celebrate>
      <ConnectionBanner connection={connection} />
      <main className="flex min-h-dvh flex-col justify-center px-[6vw] py-[6vh]">
        <h1 className="mb-[2vw] font-display text-[5vw] leading-none font-bold tracking-[-0.03em]">The new slate</h1>
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(26vw,1fr))] gap-x-[3vw] gap-y-[2vw]">
          {room.slate?.map((entry, index) => (
            <motion.li
              key={entry.positionId}
              initial={reducedMotion ? false : { opacity: 0, y: "0.6em" }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...settle, delay: reducedMotion ? 0 : 0.3 + index * SLATE_STEP_S }}
            >
              <p className="text-[1.6vw] text-chalk">{entry.title}</p>
              <p className="font-display text-[2.8vw] leading-tight font-bold tracking-[-0.02em] wrap-anywhere">
                {entry.winners.join(", ")}
              </p>
            </motion.li>
          ))}
        </ul>
      </main>
    </Stage>
  );
}
