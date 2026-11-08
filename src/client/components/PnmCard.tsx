import type { PnmInput } from "../../shared/protocol";
import { PnmPhoto } from "./PnmPhoto";

// A PNM's photo, name and form answers, as brothers read them while voting.
export function PnmCard({ pnm }: { pnm: PnmInput }) {
  return (
    <article>
      <PnmPhoto
        name={pnm.name}
        url={pnm.photoUrl}
        className="aspect-square w-full rounded-[1.75rem] text-7xl shadow-[0_18px_44px_rgb(0_0_0/0.35)]"
      />
      <h1 className="type-display mt-5">{pnm.name}</h1>
      {pnm.answers.length === 0 ? (
        <p className="mt-3 text-chalk">No form answers for this PNM.</p>
      ) : (
        <dl className="panel mt-4 divide-y divide-hairline">
          {pnm.answers.map(({ q, a }) => (
            <div key={q} className="px-4 py-3.5">
              <dt className="type-caption text-chalk">{q}</dt>
              <dd className="mt-1 text-[1.0625rem] leading-snug whitespace-pre-wrap">{a}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}
