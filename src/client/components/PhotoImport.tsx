import { useEffect, useRef, useState } from "react";
import { isDrivePhoto } from "../../shared/csv";
import type { Pnm } from "../../shared/protocol";
import { ProgressBar } from "./ProgressBar";

// Few enough at once that Drive doesn't start refusing them.
const CONCURRENT_PHOTOS = 4;
const MAX_TRIES = 3;
const RETRY_MS = 2_000;

type Failure = "not_shared" | "other";

// Asks the server to copy one PNM's photo, retrying with a longer wait while Drive is busy.
// Returns null once it's saved, or why it couldn't be.
async function saveOne(code: string, hostKey: string, pnmId: string): Promise<Failure | null> {
  for (let attempt = 1; ; attempt++) {
    let status: string | undefined;

    try {
      const response = await fetch(`/api/rooms/${code}/photos/${pnmId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${hostKey}` },
      });
      if (response.ok) return null;
      ({ status } = (await response.json()) as { status?: string });
    } catch {
      status = "unavailable";
    }

    if (status === "not_shared") return "not_shared";
    if (status !== "unavailable" || attempt === MAX_TRIES) return "other";

    await new Promise((resolve) => setTimeout(resolve, RETRY_MS * attempt));
  }
}

// Copies Drive photos into the app's own storage once, so a room full of phones never loads from Drive.
// The list comes from the room, so a reloaded host screen carries on where it stopped.
export function PhotoImport({ code, hostKey, pnms }: { code: string; hostKey: string; pnms: Pnm[] }) {
  const pending = pnms.filter(({ photoUrl }) => photoUrl && isDrivePhoto(photoUrl));
  const pendingKey = pending.map(({ id }) => id).join();
  const saved = pnms.filter(({ photoUrl }) => photoUrl?.startsWith("/photos/")).length;
  const [failures, setFailures] = useState<Record<string, Failure>>({});
  // Bumped by Try again, to queue the failed photos a second time.
  const [round, setRound] = useState(0);

  // One shared queue drained by up to CONCURRENT_PHOTOS workers. `queued` stops a photo being
  // added twice while it's still on its way.
  const queued = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const workers = useRef(0);

  useEffect(() => {
    const work = async () => {
      workers.current++;
      for (let pnmId = queue.current.shift(); pnmId; pnmId = queue.current.shift()) {
        const failure = await saveOne(code, hostKey, pnmId);
        if (failure) setFailures((current) => ({ ...current, [pnmId!]: failure }));
      }
      workers.current--;
    };

    // Queues photos that weren't queued yet, then starts as many workers as there's work for.
    for (const id of pendingKey ? pendingKey.split(",") : []) {
      if (queued.current.has(id)) continue;
      queued.current.add(id);
      queue.current.push(id);
    }
    while (workers.current < CONCURRENT_PHOTOS && workers.current < queue.current.length) void work();
  }, [code, hostKey, pendingKey, round]);

  if (pending.length === 0) return null;

  const failed = pending.filter(({ id }) => failures[id]);
  const notShared = failed.filter(({ id }) => failures[id] === "not_shared").length;
  const running = failed.length < pending.length;
  const total = saved + pending.length;

  return (
    <section className="panel mb-5 p-5" aria-live="polite">
      <h2 className="type-headline tabular-nums">
        {running ? `Saving photos: ${saved} of ${total}` : `${saved} of ${total} photos saved`}
      </h2>
      <div className="mt-3">
        <ProgressBar value={saved} max={total} label="Photos saved" />
      </div>

      {!running && (
        <>
          <p className="mt-3 text-chalk">
            {notShared > 0
              ? `${notShared} photos are private. In Google Drive, share their folder with Anyone with the link, then try again.`
              : `${failed.length} photos could not be saved.`}{" "}
            Until then, those PNMs show initials on phones.
          </p>

          <button
            type="button"
            className="btn btn-secondary mt-3"

            onClick={() => {
              queued.current.clear();
              setFailures({});
              setRound(round + 1);
            }}
          >
            Try again
          </button>
        </>
      )}
    </section>
  );
}
