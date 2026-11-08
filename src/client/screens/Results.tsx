import { AnimatePresence, motion } from "motion/react";
import { Fragment, useState } from "react";
import { toCsv } from "../../shared/csv";
import type { ResultRow, Results as ResultsData, Tally } from "../../shared/protocol";
import { PnmPhoto } from "../components/PnmPhoto";
import { settle } from "../feel";

const REVEAL_STEP_S = 0.035;
const REVEAL_LAST_STEP = 14;
const slowSettle = { ...settle, visualDuration: 0.8 };

function formatPercent(percent: number) {
  return `${Number(percent.toFixed(1))}%`;
}

function share({ yes, no }: Tally) {
  return yes + no === 0 ? 0 : (yes / (yes + no)) * 100;
}

function download(code: string, results: ResultsData) {
  const rows: (string | number)[][] = [
    ["Rank", "Name", "Percent Yes", "Yes", "No", "No response", "Brothers", "Revotes"],
  ];
  results.rows.forEach((row, index) => {
    const revotes = row.revotes.map(({ yes, no }) => `${yes} Yes ${no} No`).join("; ");
    rows.push([index + 1, row.name, formatPercent(row.percent), row.yes, row.no, row.noResponse, row.total, revotes]);
  });
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `voting-results-${code}.csv`;
  link.click();
  // Some browsers start the download after click() returns, so the URL has to outlive this call.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// The ranked results for the host, with the cut line, any tie, and a CSV download.
export function Results({
  code,
  results,
  classRevealed,
  onRevote,
  onRevealClass,
}: {
  code: string;
  results: ResultsData;
  classRevealed: boolean;
  onRevote: () => void;
  onRevealClass: () => void;
}) {
  const { tie, cutLine, rows } = results;
  const clearCount = tie ? cutLine - tie.spots : cutLine;
  const tiedNames = tie ? rows.filter(({ pnmId }) => tie.pnmIds.includes(pnmId)).map(({ name }) => name) : [];

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="type-display">Results</h1>
          <p className="mt-1 text-chalk tabular-nums">
            {clearCount} of {rows.length} {tie ? "in so far" : "made the class"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => download(code, results)}>
            Download CSV
          </button>
          {!tie && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={classRevealed}
              onClick={() => {
                if (confirm(`Show the ${clearCount} who made the class on the projector? Percentages stay private.`)) {
                  onRevealClass();
                }
              }}
            >
              {classRevealed ? "Class revealed" : "Reveal class on projector"}
            </button>
          )}
        </div>
      </div>

      {tie && (
        <section className="panel mt-6 flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="min-w-56 flex-1">
            <h2 className="type-headline text-brass">
              {tie.pnmIds.length} PNMs tied for {tie.spots} {tie.spots === 1 ? "spot" : "spots"}
            </h2>
            <p className="mt-1 text-chalk">{tiedNames.join(", ")}</p>
          </div>
          <button type="button" className="btn btn-lg btn-primary" onClick={onRevote}>
            Start revote
          </button>
        </section>
      )}

      <ol className="mt-6">
        {rows.map((row, index) => (
          <Fragment key={row.pnmId}>
            <Row row={row} rank={index + 1} made={index < clearCount} tied={!!tie?.pnmIds.includes(row.pnmId)} />
            {index + 1 === clearCount && index + 1 < rows.length && (
              <li className="type-caption flex items-center gap-3 py-3 text-brass">
                <span className="h-px flex-1 bg-brass" />
                {tie ? `${clearCount} in, tied below` : `Cut line at ${cutLine}`}
                <span className="h-px flex-1 bg-brass" />
              </li>
            )}
          </Fragment>
        ))}
      </ol>
    </main>
  );
}

function Row({ row, rank, made, tied }: { row: ResultRow; rank: number; made: boolean; tied: boolean }) {
  const [open, setOpen] = useState(false);
  const latestRevote = row.revotes.at(-1);
  return (
    <motion.li
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...settle, delay: Math.min(rank, REVEAL_LAST_STEP) * REVEAL_STEP_S }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-3.5 rounded-2xl px-2 py-2.5 text-left transition-colors hover:bg-ivory/5 active:bg-ivory/10"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="w-7 shrink-0 text-right font-display text-lg font-semibold text-chalk tabular-nums">
          {rank}
        </span>
        <PnmPhoto name={row.name} url={row.photoUrl} className="size-11 shrink-0 rounded-full text-sm" />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[1.0625rem] font-medium ${made || tied ? "" : "text-chalk"}`}>
            {row.name}
          </span>
          <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-ivory/10" aria-hidden="true">
            <motion.span
              className={`block h-full origin-left rounded-full ${made || tied ? "bg-brass" : "bg-chalk/50"}`}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: row.percent / 100 }}
              transition={{ ...slowSettle, delay: 0.15 + Math.min(rank, REVEAL_LAST_STEP) * REVEAL_STEP_S }}
            />
          </span>
        </span>
        {tied && <span className="type-caption text-brass">Tied</span>}
        {latestRevote && (
          <span className="type-caption text-chalk tabular-nums">Revote {formatPercent(share(latestRevote))}</span>
        )}
        <span className="w-[4.5rem] shrink-0 text-right font-display text-xl font-bold tabular-nums">
          {formatPercent(row.percent)}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="overflow-hidden pl-[3.625rem] text-chalk"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={settle}
          >
            <p className="pb-1">
              {row.yes} Yes, {row.no} No, {row.noResponse} no response, out of {row.total} brothers
            </p>
            {row.revotes.map(({ yes, no }, round) => (
              <p key={round} className="pb-1">
                Revote {round + 1}: {yes} Yes, {no} No
              </p>
            ))}
            <span className="block pb-2" />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}
