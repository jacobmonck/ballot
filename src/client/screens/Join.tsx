import { motion } from "motion/react";
import { type FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ROOM_CODE_LENGTH } from "../../shared/protocol";
import { flick, settle } from "../feel";
import { saveHostKey, saveName } from "../storage";

export function Join() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState((params.get("code") ?? "").toUpperCase());
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codeFocused, setCodeFocused] = useState(false);

  const join = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
      if (!response.ok) {
        setError(`No room has the code ${code}. Check the code on the screen.`);
        return;
      }
      saveName(code, name.trim());
      navigate(`/r/${code}`);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const startRoom = async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      if (!response.ok) throw new Error(String(response.status));
      const room = (await response.json()) as { code: string; hostKey: string };
      saveHostKey(room.code, room.hostKey);
      navigate(`/host/${room.code}`);
    } catch {
      setError("Could not start a room. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-10">
      <div className="mb-6 flex gap-2.5" aria-hidden="true">
        {["ball-yes", "ball-no"].map((ball, index) => (
          <motion.span
            key={ball}
            className={`${ball} size-12 rounded-full`}
            initial={{ y: -56, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ ...flick, delay: index * 0.08 }}
          />
        ))}
      </div>
      <h1 className="font-display text-[3.75rem] leading-none font-bold tracking-[-0.03em]">Ballot</h1>
      <p className="mt-3 text-lg text-chalk">Enter the room code on the screen and your name.</p>

      <form className="mt-8 space-y-5" onSubmit={join}>
        <label className="type-headline block">
          Room code
          <div className="relative mt-2">
            <input
              className="absolute inset-0 size-full text-base uppercase caret-transparent opacity-0"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase().trim())}
              onFocus={() => setCodeFocused(true)}
              onBlur={() => setCodeFocused(false)}
              maxLength={ROOM_CODE_LENGTH}
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              required
            />
            <div className="pointer-events-none grid grid-cols-6 gap-1.5" aria-hidden="true">
              {Array.from({ length: ROOM_CODE_LENGTH }, (_, index) => (
                <span
                  key={index}
                  className="code-cell type-code"
                  data-active={codeFocused && index === Math.min(code.length, ROOM_CODE_LENGTH - 1)}
                >
                  {code[index]}
                </span>
              ))}
            </div>
          </div>
        </label>
        <label className="type-headline block">
          Your name
          <input
            className="field mt-2 font-normal"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoComplete="name"
            required
          />
        </label>
        {error && (
          <motion.p
            role="alert"
            className="text-alert"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={settle}
          >
            {error}
          </motion.p>
        )}
        <button
          type="submit"
          disabled={busy || code.length !== ROOM_CODE_LENGTH || !name.trim()}
          className="btn btn-lg btn-primary w-full"
        >
          Join room
        </button>
      </form>

      <div className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2">
        <button type="button" disabled={busy} className="link" onClick={startRoom}>
          Start a new room
        </button>
        {code.length === ROOM_CODE_LENGTH && (
          <button type="button" className="link" onClick={() => navigate(`/host/${code}`)}>
            Host this room
          </button>
        )}
      </div>
    </main>
  );
}
