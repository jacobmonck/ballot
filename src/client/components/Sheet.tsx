import { AnimatePresence, motion, useDragControls } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { flick, project, settle } from "../feel";

const DISMISS_DISTANCE = 160;

// A bottom sheet that closes on Escape, the backdrop or a downward drag, and returns focus when it does.
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const controls = useDragControls();
  const doneButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    doneButton.current?.focus();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      returnTo?.focus();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-30 bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={settle}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="glass fixed inset-x-0 bottom-0 z-40 mx-auto flex max-h-[85dvh] max-w-md flex-col rounded-t-[1.75rem] bg-stage-deep/90"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={flick}
            drag="y"
            dragControls={controls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.06, bottom: 1 }}
            onDragEnd={(_, { offset, velocity }) => {
              if (offset.y + project(velocity.y) > DISMISS_DISTANCE) onClose();
            }}
          >
            <div
              className="shrink-0 cursor-grab touch-none px-5 pt-2.5 pb-2"
              onPointerDown={(event) => controls.start(event)}
            >
              <div className="mx-auto h-1 w-9 rounded-full bg-ivory/30" />
              <div className="mt-2 flex items-center justify-between">
                <h2 className="type-title">{title}</h2>
                <button ref={doneButton} type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
                  Done
                </button>
              </div>
            </div>
            <div className="overflow-y-auto overscroll-contain px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {children}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
