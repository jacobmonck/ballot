import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { materialize, settle } from "../feel";
import type { RoomState } from "../useRoom";

// Shown only while a dropped socket is reconnecting.
export function ConnectionBanner({ connection }: { connection: RoomState["connection"] }) {
  return (
    <AnimatePresence>
      {connection === "reconnecting" && (
        <motion.div
          {...materialize}
          transition={settle}
          role="status"
          className="glass-chip type-caption fixed inset-x-4 top-[max(0.75rem,env(safe-area-inset-top))] z-50 mx-auto flex w-fit items-center gap-2 rounded-full px-4 py-2 text-ivory"
        >
          <span className="size-2 shrink-0 rounded-full bg-brass" />
          Reconnecting. Saved votes are safe, and new taps send when you're back.
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Shows each new notice for a few seconds. A repeat of the same message still shows, since it has a new id.
export function Notice({ notice }: { notice: RoomState["notice"] }) {
  const [visibleId, setVisibleId] = useState<number | null>(null);

  useEffect(() => {
    if (!notice) return;

    setVisibleId(notice.id);
    const timer = setTimeout(() => setVisibleId(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <AnimatePresence>
      {notice && visibleId === notice.id && (
        <motion.div
          key={notice.id}
          {...materialize}
          transition={settle}
          role="alert"
          className="fixed inset-x-4 top-[max(1rem,env(safe-area-inset-top))] z-40 mx-auto max-w-md rounded-2xl bg-ivory px-4 py-3 font-medium text-ink shadow-[0_12px_32px_rgb(0_0_0/0.4)]"
        >
          {notice.message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// A full-screen message for loading, errors and dead ends.
export function CenteredMessage({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <motion.main
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, delay: 0.1 }}
    >
      <div className="mb-5 flex gap-2" aria-hidden="true">
        <span className="ball-yes size-6 rounded-full" />
        <span className="ball-no size-6 rounded-full" />
      </div>

      <h1 className="type-display">{title}</h1>

      {children && <div className="mt-3 text-lg text-chalk">{children}</div>}
    </motion.main>
  );
}
