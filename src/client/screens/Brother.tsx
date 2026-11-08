import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import type { ClientMessage, Snapshot, VoteValue } from "../../shared/protocol";
import { BudgetMeter } from "../components/BudgetMeter";
import { MemberList } from "../components/MemberList";
import { PnmCard } from "../components/PnmCard";
import { Sheet } from "../components/Sheet";
import { CenteredMessage, ConnectionBanner, Notice } from "../components/Status";
import { VoteButtons } from "../components/VoteButtons";
import { project, settle } from "../feel";
import { memberIdentity } from "../storage";
import { useRoom } from "../useRoom";

const PNM_CHANGE_GUARD_MS = 700;
const SWIPE_DISTANCE = 140;
// How much the card follows the finger: 1:1-ish toward a neighbor, stiff at either end of the list.
const FREE_ELASTIC = 0.7;
const END_ELASTIC = 0.14;

const cardSlide = {
  enter: (direction: number) => ({ x: `${direction * 100}%`, opacity: 0.4 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: `${direction * -100}%`, opacity: 0.4 }),
};

// A brother's phone: the lobby until the first PNM, then the ballot.
export function Brother() {
  const code = useParams().code!.toUpperCase();
  const identity = useMemo(() => memberIdentity(code), [code]);
  const join = useMemo<ClientMessage | null>(
    () => identity && { type: "join", as: "brother", ...identity },
    [identity],
  );
  const { room, connection, notice, refusal, pendingVotes, vote } = useRoom(code, join);

  if (!identity) return <Navigate to={`/?code=${code}`} replace />;
  if (refusal) return <CenteredMessage title="You can't join this room">{refusal}</CenteredMessage>;
  if (!room) return <CenteredMessage title="Joining room" />;

  return (
    <>
      <ConnectionBanner connection={connection} />
      <Notice notice={notice} />
      {room.phase === "setup" && <Lobby room={room} />}
      {room.phase === "live" && <Ballot room={room} pendingVotes={pendingVotes} vote={vote} />}
      {room.phase === "ended" && (
        <CenteredMessage title="Voting is closed">Your votes are in. The host has the results.</CenteredMessage>
      )}
    </>
  );
}

function Lobby({ room }: { room: Snapshot }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <h1 className="type-display">You're in</h1>
      <p className="mt-2 text-lg text-chalk">Voting starts when the host puts up the first PNM.</p>
      <h2 className="type-headline mt-8 mb-3">{room.members.length} in the room</h2>
      <MemberList members={room.members} />
    </main>
  );
}

function Ballot({
  room,
  pendingVotes,
  vote,
}: {
  room: Snapshot;
  pendingVotes: Record<string, VoteValue | null>;
  vote: (pnmId: string, value: VoteValue | null) => void;
}) {
  const [browsingId, setBrowsingId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [settling, setSettling] = useState(false);

  // Every phone jumps to the PNM the host just put up.
  useEffect(() => {
    setBrowsingId(null);
    setListOpen(false);
  }, [room.focusPnmId]);

  const shownId = browsingId ?? room.focusPnmId;

  // A tap aimed at the last PNM must not land on this one, and reading starts at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), PNM_CHANGE_GUARD_MS);
    return () => clearTimeout(timer);
  }, [shownId]);

  const pnm = room.pnms.find(({ id }) => id === shownId);

  // Moving to a later PNM enters from the right; an earlier one retraces the path.
  const travel = useRef({ id: pnm?.id, ordinal: pnm?.ordinal ?? 0, direction: 1 });
  if (pnm && pnm.id !== travel.current.id) {
    const direction = pnm.ordinal > travel.current.ordinal ? 1 : -1;
    travel.current = { id: pnm.id, ordinal: pnm.ordinal, direction };
  }

  if (!pnm) return <CenteredMessage title="Waiting for the next PNM" />;

  const sending = pnm.id in pendingVotes;
  const value = sending ? (pendingVotes[pnm.id] ?? undefined) : room.myVotes[pnm.id];
  const outOfYes = room.yesUsed >= room.yesBudget;
  const isFocus = pnm.id === room.focusPnmId;
  const ballot = room.revote ? room.pnms.filter(({ id }) => room.revote?.pnmIds.includes(id)) : room.pnms;
  const index = ballot.indexOf(pnm);
  const previous = ballot[index - 1];
  const next = ballot[index + 1];
  const showPnm = (id: string) => setBrowsingId(id === room.focusPnmId ? null : id);

  return (
    <>
      <div className="mx-auto flex min-h-dvh max-w-md flex-col" inert={listOpen}>
        <header className="scroll-edge flex items-center justify-between px-4 py-2.5">
          <span className="type-headline tabular-nums">
            {room.revote ? `Revote ${index + 1} of ${ballot.length}` : `PNM ${pnm.ordinal} of ${room.pnmCount}`}
          </span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setListOpen(true)}>
            All PNMs
          </button>
        </header>

        <main className="flex-1 overflow-x-clip px-4 pt-1 pb-6">
          <AnimatePresence initial={false} mode="popLayout" custom={travel.current.direction}>
            <motion.div
              key={pnm.id}
              custom={travel.current.direction}
              variants={cardSlide}
              initial="enter"
              animate="center"
              exit="exit"
              transition={settle}
              drag="x"
              dragDirectionLock
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={{ left: next ? FREE_ELASTIC : END_ELASTIC, right: previous ? FREE_ELASTIC : END_ELASTIC }}
              onDragEnd={(_, { offset, velocity }) => {
                const landing = offset.x + project(velocity.x);
                if (landing < -SWIPE_DISTANCE && next) showPnm(next.id);
                else if (landing > SWIPE_DISTANCE && previous) showPnm(previous.id);
              }}
            >
              <PnmCard pnm={pnm} />
            </motion.div>
          </AnimatePresence>
        </main>

        <footer className="glass sticky bottom-0 z-10 rounded-t-[1.75rem] px-4 pt-5 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {!isFocus && (
            <button
              type="button"
              className="btn btn-sm btn-secondary mx-auto mb-4 flex"
              onClick={() => setBrowsingId(null)}
            >
              Back to the current PNM
            </button>
          )}
          <VoteButtons
            value={value}
            yesDisabled={outOfYes && value !== "yes"}
            disabled={settling}
            sending={sending}
            onVote={(choice) => vote(pnm.id, choice)}
          />
          <div className="mt-2">
            <BudgetMeter used={room.yesUsed} budget={room.yesBudget} isDefault={room.budgetIsDefault} />
            {outOfYes && value !== "yes" && !room.budgetIsDefault && (
              <p className="type-caption mt-1 text-center text-brass">Clear an earlier Yes to free one.</p>
            )}
          </div>
        </footer>
      </div>

      <Sheet open={listOpen} title="All PNMs" onClose={() => setListOpen(false)}>
        <ul>
          {ballot.map((item) => {
            const myVote = room.myVotes[item.id];
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="flex min-h-12 w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left text-[1.0625rem] transition-colors active:bg-ivory/10"
                  aria-current={item.id === pnm.id ? "true" : undefined}
                  onClick={() => {
                    showPnm(item.id);
                    setListOpen(false);
                  }}
                >
                  <span
                    className={`size-5 shrink-0 rounded-full ${myVote === "yes" ? "ball-yes" : myVote === "no" ? "ball-no" : "ball-spent"}`}
                  />
                  <span className={`min-w-0 flex-1 truncate ${item.id === pnm.id ? "font-semibold" : ""}`}>
                    {item.name}
                  </span>
                  <span className="type-caption text-chalk">
                    {myVote === "yes" ? "Yes" : myVote === "no" ? "No" : "No vote"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Sheet>
    </>
  );
}
