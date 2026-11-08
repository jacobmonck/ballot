import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useParams } from "react-router-dom";
import type { ClientMessage, Snapshot } from "../../shared/protocol";
import { ImportPanel } from "../components/ImportPanel";
import { MemberList } from "../components/MemberList";
import { PhotoImport } from "../components/PhotoImport";
import { PnmPhoto } from "../components/PnmPhoto";
import { ProgressBar } from "../components/ProgressBar";
import { CenteredMessage, ConnectionBanner, Notice } from "../components/Status";
import { settle } from "../feel";
import { loadHostKey, saveHostKey } from "../storage";
import { useRoom } from "../useRoom";
import { Results } from "./Results";

type Send = (message: ClientMessage) => void;

// Tall enough for the header and 12 rows; the rest scroll. Row and header heights are set on the table.
const LIST_MAX_HEIGHT = "max-h-[calc(2.5rem+12*2.75rem)]";

// The host's control panel. Asks for the host key when this device doesn't have it saved.
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

// Asks for the host key on a device that doesn't have it, or after the saved one was refused.
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

// Everything before results: the header, the PNM list or setup, and the sidebar.
function Panel({ room, send }: { room: Snapshot; send: Send }) {
  return (
    <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8 sm:py-8">
      <RoomHeader room={room} send={send} />

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-5">
          {room.hostOnly && <PhotoImport code={room.code} hostKey={room.hostOnly.hostKey} pnms={room.pnms} />}
          {room.phase === "setup" ? <Setup room={room} send={send} /> : <LiveList room={room} send={send} />}
        </div>

        <Sidebar room={room} send={send} />
      </div>
    </div>
  );
}

// The room code for brothers to join with, where voting is up to, and links to the other screens.
function RoomHeader({ room, send }: { room: Snapshot; send: Send }) {
  // The key sits in the fragment, so it never reaches a server log or a Referer header.
  const projectorUrl = `${location.origin}/p/${room.code}#${room.hostOnly?.projectorKey}`;
  const focused = room.pnms.find(({ id }) => id === room.focusPnmId);
  const status = room.revote
    ? `Revote: ${room.revote.pnmIds.length} tied for ${room.revote.spots} ${room.revote.spots === 1 ? "spot" : "spots"}`
    : room.phase === "live" && focused
      ? `Voting on PNM ${focused.ordinal} of ${room.pnmCount}`
      : "Setting up";

  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-hairline pb-5">
      <div>
        <p className="type-caption text-chalk">Join at {location.host} with code</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="type-code text-[2.75rem]">{room.code}</p>
          <p className="text-chalk tabular-nums">{status}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <a className="btn btn-secondary" href={projectorUrl} target="_blank" rel="noreferrer">
          Open projector view
        </a>
        <a className="btn btn-secondary" href={`/r/${room.code}`} target="_blank" rel="noreferrer">
          Open my ballot
        </a>
        {room.phase === "live" && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (confirm("End voting for everyone? Votes freeze and this cannot be undone.")) {
                send({ type: "endSession" });
              }
            }}
          >
            End voting
          </button>
        )}
      </div>
    </header>
  );
}

// Before voting starts: a summary with a start button once PNMs are in, then the import panel.
function Setup({ room, send }: { room: Snapshot; send: Send }) {
  const first = room.pnms[0];
  const brothers = room.members.length;

  return (
    <>
      {first && (
        <section className="panel flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="min-w-0">
            <h1 className="type-title">{room.pnms.length} PNMs ready</h1>
            <p className="mt-1 text-chalk tabular-nums">
              {brothers} {brothers === 1 ? "brother" : "brothers"} joined.{" "}
              {room.budgetIsDefault ? "No class size set." : `Class size ${room.yesBudget}.`}
            </p>
          </div>

          <button
            type="button"
            className="btn btn-lg btn-primary"
            onClick={() => send({ type: "setFocus", pnmId: first.id })}
          >
            Start voting on {first.name}
          </button>
        </section>
      )}

      <ImportPanel pnms={room.pnms} onImport={(pnms) => send({ type: "importPnms", pnms })} />
    </>
  );
}

// While voting: the PNM on screen with reveal and next buttons, then every PNM with live tallies.
function LiveList({ room, send }: { room: Snapshot; send: Send }) {
  // A revote only walks through the tied PNMs.
  const pnms = room.revote ? room.pnms.filter(({ id }) => room.revote?.pnmIds.includes(id)) : room.pnms;
  const focusIndex = pnms.findIndex(({ id }) => id === room.focusPnmId);
  const next = pnms[focusIndex + 1];
  const focused = pnms[focusIndex];
  const revealed = !!focused && room.revealed?.pnmId === focused.id;

  const ballots = room.progress?.total ?? room.members.length;
  const tallies = room.hostOnly?.tallies ?? {};
  const waiting = room.progress ? room.progress.total - room.progress.voted : 0;

  const list = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  // Fades the bottom of the list while there are rows below it.
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
            <PnmPhoto
              name={focused.name}
              url={focused.photoUrl}
              className="size-24 shrink-0 rounded-[0.875rem] text-3xl"
            />
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

      {/* Every PNM with live counts. Only the host ever sees these. */}
      <motion.div
        ref={list}
        layoutScroll
        className={`mt-4 overflow-y-auto overscroll-contain rounded-[1.25rem] bg-stage-deep ${LIST_MAX_HEIGHT} ${moreBelow ? "scroll-fade" : ""}`}
        onScroll={updateMoreBelow}
      >
        <table className="isolate w-full table-fixed border-separate border-spacing-0 text-left">
          <thead className="type-caption text-chalk">
            <tr className="[&>th]:sticky [&>th]:top-0 [&>th]:z-10 [&>th]:h-10 [&>th]:bg-stage-deep">
              <th className="pr-3 pl-4 font-medium">PNM</th>
              <th className="w-14 text-right font-medium">Yes</th>
              <th className="w-14 text-right font-medium">No</th>
              <th className="hidden w-16 text-right font-medium sm:table-cell">Blank</th>
              <th className="w-16 sm:w-36" />
            </tr>
          </thead>

          <tbody>
            {pnms.map((pnm) => {
              const { yes, no } = tallies[pnm.id] ?? { yes: 0, no: 0 };
              const isFocus = pnm.id === room.focusPnmId;

              return (
                <tr key={pnm.id} className="group relative h-11 tabular-nums" data-focus={isFocus || undefined}>
                  <td className="truncate pr-3 pl-4" title={pnm.name}>
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
                  <td className="pr-4 text-right">
                    {isFocus ? (
                      <span className="type-caption text-brass">
                        <span className="sm:hidden">Now</span>
                        <span className="hidden sm:inline">On screen</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="link type-caption opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                        aria-label={`Put ${pnm.name} on screen`}
                        onClick={() => send({ type: "setFocus", pnmId: pnm.id })}
                      >
                        <span className="sm:hidden">Show</span>
                        <span className="hidden sm:inline">Put on screen</span>
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

// Who's in the room, the class size, and the host key.
function Sidebar({ room, send }: { room: Snapshot; send: Send }) {
  return (
    <aside className="space-y-3 lg:sticky lg:top-8 lg:self-start">
      <Members room={room} send={send} />
      {room.pnmCount > 0 && !room.revote && <BudgetSetting room={room} send={send} />}
      <HostKey hostKey={room.hostOnly?.hostKey ?? ""} />
    </aside>
  );
}

// The brothers in the room, with controls to close the room to new names and remove someone.
function Members({ room, send }: { room: Snapshot; send: Send }) {
  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="type-headline tabular-nums">{room.members.length} in the room</h2>
        {(room.members.length > 0 || room.joinLocked) && (
          <button
            type="button"
            className="link type-caption"
            aria-pressed={room.joinLocked}
            onClick={() => send({ type: "setJoinLocked", locked: !room.joinLocked })}
          >
            {room.joinLocked ? "Open to new names" : "Close to new names"}
          </button>
        )}
      </div>

      {room.joinLocked && (
        <p className="type-caption mt-1 text-brass">Closed. Brothers already here can still come back.</p>
      )}

      {room.members.length === 0 ? (
        <p className="mt-2 text-chalk">Names appear here as brothers join.</p>
      ) : (
        <motion.div layoutScroll className="mt-3 max-h-56 overflow-y-auto overscroll-contain">
          <MemberList
            members={room.members}
            onKick={(member) => {
              if (
                confirm(
                  `Remove ${member.name}? They can't vote again. Votes they already cast stay counted, because deleting them would reveal how they voted.`,
                )
              ) {
                send({ type: "kick", handle: member.handle });
              }
            }}
          />
        </motion.div>
      )}
    </section>
  );
}

// The class size, which sets both the cut line and how many Yes votes each brother gets.
function BudgetSetting({ room, send }: { room: Snapshot; send: Send }) {
  const [draft, setDraft] = useState(String(room.yesBudget));

  // Follows the server, so a change from another host device shows up here.
  useEffect(() => setDraft(String(room.yesBudget)), [room.yesBudget]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    send({ type: "setBudget", yesBudget: Number(draft) });
  };

  return (
    <section className="panel p-5">
      <form onSubmit={apply}>
        <label className="flex items-center justify-between gap-3">
          <span className="type-headline">Class size</span>
          <span className="flex gap-2">
            <input
              type="number"
              min={1}
              max={room.pnmCount}
              className="field w-20 py-2 font-normal"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              required
            />
            <button type="submit" className="btn btn-secondary">
              Set size
            </button>
          </span>
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

// The host key behind a disclosure, so it can be copied to a second device.
function HostKey({ hostKey }: { hostKey: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <details className="panel group p-5">
      <summary className="type-headline flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        Host key
        <svg
          viewBox="0 0 12 12"
          className="size-3 text-chalk transition-transform group-open:rotate-180"
          aria-hidden="true"
        >
          <path
            d="M2 4l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>

      <p className="type-caption mt-2 text-chalk">
        Save this. If this device dies, paste it on another one to keep running the room.
      </p>

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
    </details>
  );
}
