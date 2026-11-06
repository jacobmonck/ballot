import { animate, AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { ClassMember, ClientMessage, Pnm, Snapshot, Tally } from "../../shared/protocol";
import { MarblePit } from "../components/MarblePit";
import { MemberList } from "../components/MemberList";
import { PnmPhoto } from "../components/PnmPhoto";
import { ProgressBar } from "../components/ProgressBar";
import { CenteredMessage, ConnectionBanner } from "../components/Status";
import { flick, settle } from "../feel";
import { type Connection, useRoom } from "../useRoom";

const LOBBY_MIN_CAPACITY = 40;
const LOBBY_NAMES_SHOWN = 28;
const REVEAL_COUNT_S = 0.9;
const FINALE_INTRO_MS = 2600;
const FINALE_MAX_STEP_MS = 3200;
const FINALE_TOTAL_MS = 75_000;
const FINALE_SHOWER_MARBLES = 60;
const SEAT_RIPPLE_S = 0.05;
const SEAT_RIPPLE_MAX_S = 1.2;
const SEAT_MAX_VW = 13;
const SEAT_SHARE_OF_TILE = 0.82;
const SEAT_NAME_DELAY_S = 0.3;
// Room under each seat for two lines of name, plus the gap between rows.
const SEAT_LABEL_VW = 5;
const SEATS_WHILE_RUNNING = { width: 42, height: 74, minSeat: 6 };
const SEATS_WHEN_DONE = { width: 88, height: 64, minSeat: 7.5 };
const DRIFT_HOLD_MS = 4000;
const DRIFT_VW_PER_S = 2.5;

export function Projector() {
  const code = useParams().code!.toUpperCase();
  const projectorKey = useMemo(() => location.hash.slice(1), []);
  const join = useMemo<ClientMessage | null>(
    () => (projectorKey ? { type: "join", as: "projector", projectorKey } : null),
    [projectorKey],
  );
  const { room, connection, refusal } = useRoom(code, join);

  if (!projectorKey) return <CenteredMessage title="Open the projector view from the host screen" />;
  if (refusal) return <CenteredMessage title={refusal} />;
  if (!room) return <CenteredMessage title="Connecting" />;

  if (room.classReveal) return <Finale members={room.classReveal} connection={connection} />;

  if (room.phase === "ended") {
    return (
      <Stage scene="ended" count={0} capacity={1} yesShown={null} glow={0} celebrate={false}>
        <CenteredMessage title="Voting is closed" />
      </Stage>
    );
  }

  const pnm = room.pnms.find(({ id }) => id === room.focusPnmId);

  if (room.phase === "setup" || !pnm) {
    return (
      <Stage
        scene="lobby"
        count={room.members.length}
        capacity={Math.max(room.members.length, LOBBY_MIN_CAPACITY)}
        yesShown={null}
        glow={0.25}
        celebrate={false}
      >
        <ConnectionBanner connection={connection} />
        <Lobby room={room} />
      </Stage>
    );
  }

  const voted = room.progress?.voted ?? 0;
  const total = room.progress?.total ?? 0;
  const allIn = total > 0 && voted >= total;
  const revealed = room.revealed?.pnmId === pnm.id ? room.revealed : null;
  const place = room.revote
    ? `Revote ${room.revote.pnmIds.indexOf(pnm.id) + 1} of ${room.revote.pnmIds.length}`
    : `PNM ${pnm.ordinal} of ${room.pnmCount}`;

  return (
    <Stage
      scene={pnm.id}
      count={revealed ? revealed.yes + revealed.no : voted}
      capacity={total}
      yesShown={revealed?.yes ?? null}
      glow={total ? voted / total : 0}
      celebrate={allIn}
    >
      <ConnectionBanner connection={connection} />
      <main className="min-h-dvh overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          <Spotlight
            key={pnm.id}
            pnm={pnm}
            place={place}
            voted={voted}
            total={total}
            allIn={allIn}
            revealed={revealed}
          />
        </AnimatePresence>
      </main>
    </Stage>
  );
}

function Stage({
  scene,
  count,
  capacity,
  yesShown,
  glow,
  celebrate,
  children,
}: {
  scene: string;
  count: number;
  capacity: number;
  yesShown: number | null;
  glow: number;
  celebrate: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <div className="fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="aurora aurora-a" />
        <div className="aurora aurora-b" />
        <div className="aurora aurora-c" />
        <motion.div
          className="absolute inset-x-0 bottom-0 h-[60vh] bg-[radial-gradient(75%_100%_at_50%_100%,rgb(227_193_111/0.5),transparent)]"
          initial={false}
          animate={{ opacity: celebrate ? 1 : glow * 0.7 }}
          transition={settle}
        />
        <MarblePit scene={scene} count={count} capacity={capacity} yesShown={yesShown} celebrate={celebrate} />
      </div>
      <div className="relative">{children}</div>
    </>
  );
}

// The largest round seat that fits every member in the area. Below `minSeat` faces stop reading
// from the back of the room, so the seats hold that size and the wall scrolls instead.
function seatLayout(count: number, shape: number, { width, height, minSeat }: typeof SEATS_WHEN_DONE) {
  const heightInVw = height * shape;
  let best = { columns: 1, seat: 0 };
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const seat = Math.min(SEAT_MAX_VW, (width / columns) * SEAT_SHARE_OF_TILE, heightInVw / rows - SEAT_LABEL_VW);
    if (seat > best.seat) best = { columns, seat };
  }
  if (best.seat >= minSeat) return best;
  return { columns: Math.floor((width * SEAT_SHARE_OF_TILE) / minSeat), seat: minSeat };
}

// Height over width of the screen, kept current for a projector that goes full screen mid-reveal.
function useScreenShape() {
  const [shape, setShape] = useState(() => window.innerHeight / window.innerWidth);
  useEffect(() => {
    const update = () => setShape(window.innerHeight / window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return shape;
}

// Rolls a wall too tall for the screen up and down like credits, because nobody scrolls a projector.
// The host taking over with a wheel or a drag ends it.
function useCreditsDrift(wall: RefObject<HTMLDivElement | null>, active: boolean) {
  useEffect(() => {
    const element = wall.current;
    if (!element || !active) return;
    let timer: ReturnType<typeof setTimeout>;
    let controls: ReturnType<typeof animate> | undefined;

    const drift = (down: boolean) => {
      const room = element.scrollHeight - element.clientHeight;
      if (room <= 1) return;
      const pixelsPerSecond = (window.innerWidth * DRIFT_VW_PER_S) / 100;
      controls = animate(element.scrollTop, down ? room : 0, {
        duration: room / pixelsPerSecond,
        ease: "linear",
        onUpdate: (top) => {
          element.scrollTop = top;
        },
        onComplete: () => {
          timer = setTimeout(() => drift(!down), DRIFT_HOLD_MS);
        },
      });
    };
    const stop = () => {
      clearTimeout(timer);
      controls?.stop();
    };

    element.scrollTop = 0;
    timer = setTimeout(() => drift(true), DRIFT_HOLD_MS);
    element.addEventListener("wheel", stop, { passive: true });
    element.addEventListener("pointerdown", stop);
    return () => {
      stop();
      element.removeEventListener("wheel", stop);
      element.removeEventListener("pointerdown", stop);
    };
  }, [wall, active]);
}

function Finale({ members, connection }: { members: ClassMember[]; connection: Connection }) {
  const reducedMotion = useReducedMotion();
  const total = members.length;
  // 0 is the intro, 1 to total put that member in the spotlight, and total + 1 is the full class.
  const [step, setStep] = useState(reducedMotion ? total + 1 : 0);
  const done = step > total;
  const current = done || step === 0 ? null : members[step - 1]!;
  const area = done ? SEATS_WHEN_DONE : SEATS_WHILE_RUNNING;
  const { columns, seat } = seatLayout(total, useScreenShape(), area);
  const wall = useRef<HTMLDivElement>(null);
  useCreditsDrift(wall, done && !reducedMotion);

  // Brings the empty seat into view before its owner flies there.
  useEffect(() => {
    const element = wall.current;
    const target = element?.querySelector<HTMLElement>(`[data-seat="${step - 1}"]`);
    if (!element || !target || done) return;
    const top = target.offsetTop - (element.clientHeight - target.offsetHeight) / 2;
    element.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
  }, [step, done, reducedMotion]);

  useEffect(() => {
    if (reducedMotion) {
      setStep(total + 1);
      return;
    }
    if (done) return;
    const pause = step === 0 ? FINALE_INTRO_MS : Math.min(FINALE_MAX_STEP_MS, FINALE_TOTAL_MS / total);
    const timer = setTimeout(() => setStep(step + 1), pause);
    return () => clearTimeout(timer);
  }, [step, done, total, reducedMotion]);

  const capacity = total + FINALE_SHOWER_MARBLES;

  return (
    <Stage
      scene="finale"
      count={done ? capacity : Math.min(step, total)}
      capacity={capacity}
      yesShown={null}
      glow={step / (total + 1)}
      celebrate={done}
    >
      <ConnectionBanner connection={connection} />
      <main className={`flex h-dvh flex-col justify-center overflow-hidden px-[5vw] ${done ? "pb-[10vh]" : ""}`} aria-live="polite">
        {done && (
          <motion.h1
            className="mb-[2vh] text-center font-display text-[min(5.5vw,10vh)] leading-none font-bold tracking-[-0.03em]"
            initial={{ opacity: 0, y: "0.4em" }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...settle, delay: 0.3 }}
          >
            The new class
          </motion.h1>
        )}
        <div className="flex items-center justify-center gap-[3vw]">
          {!done && (
            <div className="relative h-[80vh] min-w-0 flex-1">
              <AnimatePresence initial={false}>
                <motion.div
                  key={current?.pnmId ?? "intro"}
                  className="absolute inset-0 flex flex-col items-center justify-center text-center"
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                >
                  {current ? <Inductee member={current} place={`${step} of ${total}`} /> : <FinaleIntro />}
                </motion.div>
              </AnimatePresence>
            </div>
          )}
          <motion.div
            ref={wall}
            layoutScroll
            className="seat-wall relative flex shrink-0 overflow-y-auto overscroll-contain"
            style={{ height: `${area.height}vh`, width: `${area.width + 2}vw` }}
          >
            <div
              className="m-auto grid gap-y-[1vw] py-[1.5vw]"
              style={{ gridTemplateColumns: `repeat(${columns}, ${seat / SEAT_SHARE_OF_TILE}vw)` }}
            >
              {members.map((member, index) => (
                <Seat
                  key={member.pnmId}
                  index={index}
                  member={member}
                  size={seat}
                  seated={index < step - 1}
                  rippleDelay={done ? Math.min(index * SEAT_RIPPLE_S, SEAT_RIPPLE_MAX_S) : null}
                />
              ))}
            </div>
          </motion.div>
        </div>
      </main>
    </Stage>
  );
}

function FinaleIntro() {
  return (
    <motion.h1
      className="font-display text-[6.5vw] leading-[1.02] font-bold tracking-[-0.03em]"
      initial={{ opacity: 0, y: "0.4em" }}
      animate={{ opacity: 1, y: 0 }}
      transition={settle}
    >
      Meet the new class
    </motion.h1>
  );
}

function Inductee({ member, place }: { member: ClassMember; place: string }) {
  return (
    <>
      <motion.div
        layoutId={member.pnmId}
        className="size-[50vh] max-w-[38vw] overflow-hidden rounded-full text-[17vh] shadow-[0_3vw_6vw_rgb(0_0_0/0.4)]"
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={flick}
      >
        <PnmPhoto name={member.name} url={member.photoUrl} className="size-full" />
      </motion.div>
      <motion.p
        className="mt-[3vh] max-w-full font-display text-[4.5vw] leading-[1.05] font-bold tracking-[-0.03em] wrap-anywhere"
        initial={{ opacity: 0, y: "0.4em" }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...settle, delay: 0.15 }}
      >
        {member.name}
      </motion.p>
      <p className="mt-[1vh] text-[1.8vw] text-chalk tabular-nums">{place}</p>
    </>
  );
}

function Seat({
  index,
  member,
  size,
  seated,
  rippleDelay,
}: {
  index: number;
  member: ClassMember;
  size: number;
  seated: boolean;
  rippleDelay: number | null;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center" data-seat={index}>
      <div className="relative" style={{ width: `${size}vw`, height: `${size}vw`, fontSize: `${size * 0.36}vw` }}>
        {seated ? (
          <motion.div layoutId={member.pnmId} className="size-full overflow-hidden rounded-full" transition={settle}>
            <PnmPhoto name={member.name} url={member.photoUrl} className="size-full" />
          </motion.div>
        ) : (
          <div className="size-full rounded-full border border-dashed border-ivory/20" />
        )}
        {rippleDelay !== null && (
          <motion.span
            className="absolute inset-0 rounded-full border-2 border-brass"
            initial={{ scale: 1, opacity: 0.9 }}
            animate={{ scale: 1.2, opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeOut", delay: 0.4 + rippleDelay }}
          />
        )}
      </div>
      <motion.p
        className="mt-[0.4vw] line-clamp-2 w-full px-[0.3vw] text-center leading-tight font-medium wrap-anywhere"
        style={{ fontSize: `${Math.max(1.15, size * 0.14)}vw` }}
        initial={false}
        animate={{ opacity: seated ? 1 : 0 }}
        transition={{ ...settle, delay: SEAT_NAME_DELAY_S }}
      >
        {member.name}
      </motion.p>
    </div>
  );
}

function Lobby({ room }: { room: Snapshot }) {
  const joinHost = useMemo(() => location.host, []);
  const newestFirst = room.members.slice(-LOBBY_NAMES_SHOWN).reverse();

  return (
    <main className="flex min-h-dvh flex-col justify-center overflow-hidden px-[6vw] pb-[8vh]">
      <p className="text-[2.5vw] text-chalk">Join at {joinHost}</p>
      <p className="type-code flex text-[17vw]" aria-label={room.code}>
        {[...room.code].map((letter, index) => (
          <motion.span
            key={index}
            aria-hidden="true"
            initial={{ y: "0.35em", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ ...flick, delay: index * 0.06 }}
          >
            {letter}
          </motion.span>
        ))}
      </p>
      <p className="type-headline mt-[2vw] text-[2vw] tabular-nums">{room.members.length} in the room</p>
      <div className="mt-[1vw] max-h-[9.7em] overflow-hidden text-[1.6vw]">
        <MemberList members={newestFirst} />
      </div>
    </main>
  );
}

function Spotlight({
  pnm,
  place,
  voted,
  total,
  allIn,
  revealed,
}: {
  pnm: Pnm;
  place: string;
  voted: number;
  total: number;
  allIn: boolean;
  revealed: Tally | null;
}) {
  return (
    <motion.div
      className="flex min-h-dvh items-center gap-[5vw] px-[6vw] pb-[7vh]"
      initial={{ x: "12%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "-12%", opacity: 0 }}
      transition={settle}
    >
      <motion.div
        className="relative shrink-0"
        initial={{ scale: 0.9 }}
        animate={{ scale: 1 }}
        transition={{ ...flick, visualDuration: 0.5 }}
      >
        {/* The photo's own colors spill onto the wall behind it. */}
        <div className="absolute inset-0 scale-110 opacity-60 blur-[4vw]" aria-hidden="true">
          <PnmPhoto name={pnm.name} url={pnm.photoUrl} className="size-full rounded-[2.5vw] text-transparent" />
        </div>
        <PnmPhoto
          name={pnm.name}
          url={pnm.photoUrl}
          className="relative aspect-square h-[66vh] max-w-[46vw] rounded-[2.5vw] text-[12vw] shadow-[0_3vw_6vw_rgb(0_0_0/0.4)]"
        />
      </motion.div>

      <div className="min-w-0 flex-1">
        <p className="text-[2vw] text-chalk tabular-nums">{place}</p>
        <h1 className="font-display text-[7vw] leading-[1.02] font-bold tracking-[-0.03em]">
          {pnm.name.split(/\s+/).map((word, index) => (
            <span key={index} className="inline-block overflow-hidden pr-[0.24em] pb-[0.12em] align-top last:pr-0">
              <motion.span
                className="inline-block"
                initial={{ y: "110%" }}
                animate={{ y: 0 }}
                transition={{ ...settle, delay: 0.12 + index * 0.09 }}
              >
                {word}
              </motion.span>
            </span>
          ))}
        </h1>

        {revealed ? (
          <Verdict tally={revealed} total={total} />
        ) : (
          <>
            <p className="mt-[2.5vw] flex items-baseline gap-[0.8vw] text-[2.5vw] font-medium tabular-nums" aria-live="polite">
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
            <div className="mt-[1.25vw] max-w-[34vw]">
              <ProgressBar value={voted} max={total} label="Brothers who have voted" className="h-[0.55vw]" />
            </div>

            <div className="mt-[1.5vw] h-[3vw]">
              <AnimatePresence>
                {allIn && (
                  <motion.p
                    className="font-display text-[2.6vw] leading-none font-bold tracking-[-0.02em] text-brass"
                    initial={{ opacity: 0, y: "0.5em", scale: 0.92 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={flick}
                  >
                    All votes in
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}

function Verdict({ tally, total }: { tally: Tally; total: number }) {
  const blank = total - tally.yes - tally.no;
  return (
    <div className="mt-[2.5vw]" aria-live="polite">
      <div className="flex items-center gap-[4vw]">
        <VerdictSide label="Yes" ball="ball-yes" value={tally.yes} />
        <VerdictSide label="No" ball="ball-no" value={tally.no} />
      </div>
      {blank > 0 && <p className="mt-[1.25vw] text-[1.8vw] text-chalk tabular-nums">{blank} didn't vote</p>}
    </div>
  );
}

function VerdictSide({ label, ball, value }: { label: string; ball: string; value: number }) {
  return (
    <motion.div
      className="flex items-center gap-[1.2vw]"
      initial={{ opacity: 0, y: "1vw" }}
      animate={{ opacity: 1, y: 0 }}
      transition={flick}
    >
      <span className={`size-[3.6vw] rounded-full ${ball}`} aria-hidden="true" />
      <span className="font-display text-[5.5vw] leading-none font-bold tracking-[-0.03em] tabular-nums">
        <CountUp to={value} />
      </span>
      <span className="text-[2.5vw] font-medium">{label}</span>
    </motion.div>
  );
}

function CountUp({ to }: { to: number }) {
  const reducedMotion = useReducedMotion();
  const [shown, setShown] = useState(reducedMotion ? to : 0);

  useEffect(() => {
    if (reducedMotion) {
      setShown(to);
      return;
    }
    const controls = animate(0, to, {
      duration: REVEAL_COUNT_S,
      ease: "easeOut",
      onUpdate: (value) => setShown(Math.round(value)),
    });
    return () => controls.stop();
  }, [to, reducedMotion]);

  return shown;
}
