import { AnimatePresence, motion } from "motion/react";
import type { MemberInfo } from "../../shared/protocol";
import { flick } from "../feel";

// Names in the room. With onKick, each gets a remove button and repeated names are flagged for the host.
export function MemberList({ members, onKick }: { members: MemberInfo[]; onKick?: (member: MemberInfo) => void }) {
  const counts = new Map<string, number>();
  for (const { name } of members) {
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return (
    <ul className="flex flex-wrap gap-[0.4em]">
      <AnimatePresence initial={false} mode="popLayout">
        {members.map((member) => {
          const duplicated = (counts.get(member.name.toLowerCase()) ?? 0) > 1;
          return (
            <motion.li
              layout
              key={member.handle}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={flick}
              className={`flex items-center gap-[0.35em] rounded-full bg-ivory/10 px-[0.8em] py-[0.3em] font-medium ${onKick ? "pr-[0.35em]" : ""} ${duplicated && onKick ? "ring-2 ring-alert" : ""}`}
            >
              {member.name}
              {onKick && (
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded-full text-chalk transition-colors hover:bg-ivory/15 hover:text-ivory active:bg-ivory/25"
                  aria-label={`Remove ${member.name}`}
                  onClick={() => onKick(member)}
                >
                  <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
                    <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
