import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useParams } from "react-router-dom";
import type { ClientMessage, Snapshot } from "../../shared/protocol";
import { ImportPanel } from "../components/ImportPanel";
import { MemberList } from "../components/MemberList";
import { PnmPhoto } from "../components/PnmPhoto";
import { ProgressBar } from "../components/ProgressBar";
import { CenteredMessage, ConnectionBanner, Notice } from "../components/Status";
import { settle } from "../feel";
import { loadHostKey, saveHostKey } from "../storage";
import { useRoom } from "../useRoom";
import { Results } from "./Results";

type Send = (message: ClientMessage) => void;

// Tall enough for the header and 12 rows; the rest scroll. Row and header heights are set on the table.
const LIST_MAX_HEIGHT = "max-h-[calc(2.25rem+12*2.75rem)]";

export function Host() {
  const code = useParams().code!.toUpperCase();
  const hostKey = useMemo(() => loadHostKey(code), [code]);
  const join = useMemo<ClientMessage | null>(() => (hostKey ? { type: "join", as: "host", hostKey } : null), [hostKey]);
  const { room, connection, notice, refusal, send } = useRoom(code, join);

  if (!hostKey || refusal) {
    return (
      <KeyPrompt
        error={refusal}
        onSubmit={(key) => {
          // A refused socket stops retrying, so a fresh page load is the clean way to try a new key.
          saveHostKey(code, key);
          location.reload();
        }}
      />
    );
  }
  if (!room?.hostOnly) return <CenteredMessage title="Connecting" />;

  return (
    <>
      <ConnectionBanner connection={connection} />
      <Notice notice={notice} />
      {room.phase === "ended" && room.hostOnly.results ? (
        <Results
          code={room.code}
          results={room.hostOnly.results}
          classRevealed={room.classReveal !== null}
          onRevote={() => send({ type: "startRevote" })}
          onRevealClass={() => send({ type: "revealClass" })}
        />
      ) : (
        <Panel room={room} send={send} />
      )}
    </>
  );
}

function KeyPrompt({ error, onSubmit }: { error: string | null; onSubmit: (key: string) => void }) {
  const [key, setKey] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(key.trim());
  };
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <h1 className="type-display">Host this room</h1>
      <p className="mt-2 text-lg text-chalk">Paste the host key copied from the device that started the room.</p>
      <form className="mt-6" onSubmit={submit}>
        <input
          className="field"
          aria-label="Host key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          required
        />
        {error && (
          <p role="alert" className="mt-2 text-alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-lg btn-primary mt-4 w-full">
          Take over as host
        </button>
      </form>
    </main>
  );
}

function Panel({ room, send }: { room: Snapshot; send: Send }) {
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-8 px-5 py-6 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="min-w-0">
        {room.phase === "setup" ? (
          <>
            <ImportPanel pnms={room.pnms} onImport={(pnms) => send({ type: "importPnms", pnms })} />
            {room.pnms.length > 0 && (
              <button
                type="button"
                className="btn btn-lg btn-primary mt-6"
                onClick={() => send({ type: "setFocus", pnmId: room.pnms[0]!.id })}
              >
                Start voting on {room.pnms[0]!.name}
              </button>
            )}
          </>
        ) : (
          <LiveList room={room} send={send} />
        )}
        <Members room={room} send={send} />
      </div>
      <Sidebar room={room} send={send} />
    </div>
  );
}

function LiveList({ room, send }: { room: Snapshot; send: Send }) {
  const pnms = room.revote ? room.pnms.filter(({ id }) => room.revote?.pnmIds.includes(id)) : room.pnms;
  const focusIndex = pnms.findIndex(({ id }) => id === room.focusPnmId);
  const next = pnms[focusIndex + 1];
  const focused = pnms[focusIndex];
  const ballots = room.progress?.total ?? room.members.length;
  const tallies = room.hostOnly?.tallies ?? {};
  const waiting = room.progress ? room.progress.total - room.progress.voted : 0;

  const revealed = !!focused && room.revealed?.pnmId === focused.id;

  const list = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const [moreBelow, setMoreBelow] = useState(false);

  const updateMoreBelow = () => {
    const element = list.current;
    if (element) setMoreBelow(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
  };

  // Keeps the PNM on screen centered so the ones coming up stay visible.
  useEffect(() => {
    const element = list.current;
    const row = element?.querySelector<HTMLElement>("[data-focus]");
    if (!element || !row) return;
    const top = row.offsetTop - (element.clientHeight - row.offsetHeight) / 2;
    element.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
    updateMoreBelow();
  }, [room.focusPnmId, pnms.length, reducedMotion]);

  return (
    <section>
      <div className="panel flex flex-col gap-5 p-4 sm:p-5">
        <div className="flex items-center gap-5">
          {focused && (
            <PnmPhoto name={focused.name} url={focused.photoUrl} className="size-24 shrink-0 rounded-[0.875rem] text-3xl" />
          )}
          <div className="min-w-0 flex-1">
            {room.revote && (
              <p className="type-headline text-brass">
                Revote: {room.revote.pnmIds.length} tied for {room.revote.spots}{" "}
                {room.revote.spots === 1 ? "spot" : "spots"}
              </p>
            )}
            <h1 className="type-display wrap-anywhere">{focused?.name}</h1>
            <p className="mt-1 text-chalk tabular-nums" aria-live="polite">
              Waiting on {waiting} of {ballots}
            </p>
            <div className="mt-3 max-w-xs">
              <ProgressBar value={ballots - waiting} max={ballots} label="Brothers who have voted" />
            </div>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {focused && (
            <button
              type="button"
              className="btn btn-lg btn-secondary"
              disabled={revealed || ballots === waiting}
              onClick={() => send({ type: "reveal", pnmId: focused.id })}
            >
              {revealed ? "Votes revealed" : "Reveal votes"}
            </button>
          )}
          {next && (
            <button
              type="button"
              className="btn btn-lg btn-primary min-w-0"
              onClick={() => send({ type: "setFocus", pnmId: next.id })}
            >
              <span className="truncate">Next: {next.name}</span>
            </button>
          )}
        </div>
      </div>

      <motion.div
        ref={list}
        layoutScroll
        className={`mt-5 overflow-y-auto overscroll-contain ${LIST_MAX_HEIGHT} ${moreBelow ? "scroll-fade" : ""}`}
        onScroll={updateMoreBelow}
      >
        <table className="isolate w-full border-separate border-spacing-0 text-left">
          <thead className="type-caption text-chalk">
            <tr className="[&>th]:sticky [&>th]:top-0 [&>th]:z-10 [&>th]:h-9 [&>th]:bg-stage">
              <th className="pr-3 pl-3 font-medium">PNM</th>
              <th className="w-14 text-right font-medium">Yes</th>
              <th className="w-14 text-right font-medium">No</th>
              <th className="hidden w-16 text-right font-medium sm:table-cell">Blank</th>
              <th className="w-36" />
            </tr>
          </thead>
          <tbody>
            {pnms.map((pnm) => {
              const { yes, no } = tallies[pnm.id] ?? { yes: 0, no: 0 };
              const isFocus = pnm.id === room.focusPnmId;
              return (
                <tr key={pnm.id} className="relative h-11 tabular-nums" data-focus={isFocus || undefined}>
                  <td className="pr-3 pl-3 wrap-anywhere">
                    {isFocus && (
                      <motion.span
                        layoutId="focus-row"
                        className="absolute inset-0 -z-10 rounded-xl bg-ivory/10"
                        transition={settle}
                      />
                    )}
                    <span className="mr-2.5 text-chalk">{pnm.ordinal}</span>
                    <span className={isFocus ? "font-semibold" : ""}>{pnm.name}</span>
                  </td>
                  <td className="text-right font-semibold">{yes}</td>
                  <td className="text-right font-semibold">{no}</td>
                  <td className="hidden text-right text-chalk sm:table-cell">{ballots - yes - no}</td>
                  <td className="pr-3 text-right">
                    {isFocus ? (
                      <span className="type-caption text-brass">On screen</span>
                    ) : (
                      <button
                        type="button"
                        className="link type-caption"
                        onClick={() => send({ type: "setFocus", pnmId: pnm.id })}
                      >
                        Put on screen
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </motion.div>
    </section>
  );
}

function Sidebar({ room, send }: { room: Snapshot; send: Send }) {
  const projectorUrl = `${location.origin}/p/${room.code}`;
  return (
    <aside className="space-y-3 lg:sticky lg:top-8 lg:self-start">
      <section className="panel p-5">
        <h2 className="type-caption text-chalk">Room code</h2>
        <p className="type-code mt-1 text-[3.25rem]">{room.code}</p>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1">
          <a className="link" href={projectorUrl} target="_blank" rel="noreferrer">
            Open projector view
          </a>
          <a className="link" href={`/r/${room.code}`} target="_blank" rel="noreferrer">
            Open my ballot
          </a>
        </div>
      </section>

      {room.pnmCount > 0 && !room.revote && <BudgetSetting room={room} send={send} />}

      <HostKey hostKey={room.hostOnly?.hostKey ?? ""} />

      {room.phase === "live" && (
        <button
          type="button"
          className="btn btn-danger w-full"
          onClick={() => {
            if (confirm("End voting for everyone? Votes freeze and this cannot be undone.")) {
              send({ type: "endSession" });
            }
          }}
        >
          End voting
        </button>
      )}
    </aside>
  );
}

function Members({ room, send }: { room: Snapshot; send: Send }) {
  return (
    <section className="panel mt-5 p-5">
      <h2 className="type-headline mb-3">{room.members.length} in the room</h2>
      {room.members.length === 0 ? (
        <p className="text-chalk">Names appear here as brothers join.</p>
      ) : (
        <motion.div layoutScroll className="max-h-56 overflow-y-auto overscroll-contain">
          <MemberList
            members={room.members}
            onKick={(member) => {
              if (confirm(`Remove ${member.name}? They can't vote again. Votes they already cast stay counted, because deleting them would reveal how they voted.`)) {
                send({ type: "kick", handle: member.handle });
              }
            }}
          />
        </motion.div>
      )}
    </section>
  );
}

function BudgetSetting({ room, send }: { room: Snapshot; send: Send }) {
  const [draft, setDraft] = useState(String(room.yesBudget));
  useEffect(() => setDraft(String(room.yesBudget)), [room.yesBudget]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    send({ type: "setBudget", yesBudget: Number(draft) });
  };

  return (
    <section className="panel p-5">
      <form onSubmit={apply}>
        <label className="type-headline">
          Class size
          <div className="mt-2 flex gap-2">
            <input
              type="number"
              min={1}
              max={room.pnmCount}
              className="field w-24 py-2 font-normal"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              required
            />
            <button type="submit" className="btn btn-secondary">
              Set size
            </button>
          </div>
        </label>
      </form>
      <p className="type-caption mt-2 text-chalk">
        {room.budgetIsDefault ? (
          "Not set: no cut line, and everyone can vote Yes on every PNM."
        ) : (
          <>
            Top {room.yesBudget} by percentage make it. Each brother gets {room.yesBudget} Yes votes.{" "}
            <button type="button" className="link" onClick={() => send({ type: "setBudget", yesBudget: null })}>
              Remove
            </button>
          </>
        )}
      </p>
    </section>
  );
}

function HostKey({ hostKey }: { hostKey: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel p-5">
      <h2 className="type-headline">Host key</h2>
      <p className="type-caption mt-1 text-chalk">Save this. If this device dies, paste it on another one to keep running the room.</p>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-black/25 px-2.5 py-2 text-sm">{hostKey}</code>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(hostKey).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </section>
  );
}
