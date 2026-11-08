import { useMemo, useState } from "react";
import { buildPnms, type ColumnKind, guessColumn, parseCsv } from "../../shared/csv";
import type { Pnm, PnmInput } from "../../shared/protocol";
import { PnmCard } from "./PnmCard";
import { PnmPhoto } from "./PnmPhoto";

const KINDS: { value: ColumnKind; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "photo", label: "Photo URL" },
  { value: "question", label: "Question" },
  { value: "ignore", label: "Ignore" },
];

export function ImportPanel({ pnms, onImport }: { pnms: Pnm[]; onImport: (pnms: PnmInput[]) => void }) {
  const [text, setText] = useState("");
  const [replacing, setReplacing] = useState(false);
  const showForm = pnms.length === 0 || replacing;
  const rows = useMemo(() => parseCsv(text), [text]);
  const headers = useMemo(() => rows[0] ?? [], [rows]);
  const [overrides, setOverrides] = useState<Record<string, ColumnKind>>({});
  const columns = useMemo(
    () => headers.map((header, index) => overrides[`${index}:${header}`] ?? guessColumn(header)),
    [headers, overrides],
  );
  const parsed = useMemo(() => buildPnms(rows, columns), [rows, columns]);
  const hasPhotoColumn = columns.includes("photo");

  return (
    <section>
      {showForm && (
        <>
          <h1 className="type-title">Import PNMs</h1>
          <label className="mt-1 block text-chalk">
            Paste form responses from Google Sheets or a downloaded CSV.
            <textarea
              className="field mt-3 h-36 resize-y text-sm text-ivory"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <p className="type-caption mt-2 text-chalk">
            Share Google Drive photos with Anyone with the link until they've been saved here.
          </p>
        </>
      )}

      {showForm && headers.length > 0 && (
        <>
          <h3 className="type-headline mt-6">Match each column</h3>
          <div className="panel mt-2 max-h-80 divide-y divide-hairline overflow-y-auto">
            {headers.map((header, index) => (
              <label key={`${index}:${header}`} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <span className="min-w-0 truncate">{header || `Column ${index + 1}`}</span>
                <select
                  className="field w-auto py-1.5 pr-2 pl-3 text-sm"
                  value={columns[index]}
                  onChange={(event) =>
                    setOverrides({ ...overrides, [`${index}:${header}`]: event.target.value as ColumnKind })
                  }
                >
                  {KINDS.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {parsed[0] ? (
            <>
              <h3 className="type-headline mt-6">First PNM preview</h3>
              <div className="mt-3 max-w-xs">
                <PnmCard pnm={parsed[0]} />
              </div>
            </>
          ) : (
            <p className="mt-4 text-alert">Choose a Name column to see PNMs.</p>
          )}
          {!hasPhotoColumn && <p className="mt-2 text-alert">No Photo URL column chosen. PNMs will show initials.</p>}

          <button
            type="button"
            disabled={parsed.length === 0}
            className="btn btn-primary mt-5"
            onClick={() => {
              onImport(parsed);
              setText("");
              setOverrides({});
              setReplacing(false);
            }}
          >
            Import {parsed.length} PNMs
          </button>
        </>
      )}

      {pnms.length > 0 && <PhotoCheck pnms={pnms} replacing={replacing} onReplace={() => setReplacing(!replacing)} />}
    </section>
  );
}

function PhotoCheck({ pnms, replacing, onReplace }: { pnms: Pnm[]; replacing: boolean; onReplace: () => void }) {
  // By address, so a photo that failed stops counting once it has been saved somewhere that works.
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const problems = pnms.filter(({ photoUrl }) => !photoUrl || broken.has(photoUrl)).length;

  return (
    <div className={replacing ? "mt-8" : ""}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="type-headline">Photo check</h2>
        <button type="button" className="link type-caption" onClick={onReplace}>
          {replacing ? "Keep this list" : "Replace list"}
        </button>
      </div>
      <p className={`mt-0.5 ${problems > 0 ? "text-alert" : "text-chalk"}`}>
        {problems > 0
          ? `${problems} without a working photo. They'll show initials.`
          : "Check that every photo loaded."}
      </p>
      <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-3">
        {pnms.map((pnm) => (
          <li key={pnm.id} className="type-caption">
            <PnmPhoto
              name={pnm.name}
              url={pnm.photoUrl}
              className="aspect-square w-full rounded-2xl text-2xl"
              onBroken={() => setBroken((current) => new Set(current).add(pnm.photoUrl ?? ""))}
            />
            <span className="mt-1.5 block truncate">{pnm.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
