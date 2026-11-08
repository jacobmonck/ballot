# Flick to Vote and the Pegboard Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Casting a vote becomes a flick on the phone, and the projector reveal becomes a planned, sound-backed pegboard drop into Yes and No bins.

**Architecture:** The pegboard is not a physics simulation. A pure, DOM-free planner lays out a board in a fixed 1600×900 logical space and plans each marble's path as a chain of ballistic arcs between peg contacts, ending in a bin slot assigned before the first drop. A pure timeline class (`PegboardRun`) plays those paths back by `dt`, emitting sound events. `MarblePit` draws either the existing gold pile or the run, letterboxed to the window. Sound is a small Web Audio module ported from the spike.

**Tech Stack:** React 19, motion 14, Canvas 2D, Web Audio API, Vitest (Cloudflare workers pool, so tested modules must not touch the DOM at import time), Bun.

**Spec:** `docs/superpowers/specs/2026-11-08-flick-and-pegboard-design.md`. Reference spike for sound recipes, finishes, slow-finish timing and flick feel: `docs/superpowers/specs/2026-11-08-flick-and-pegboard-spike.html`.

## Global Constraints

- No server or protocol changes. Bins use the tally frozen at reveal: `room.revealed` (`Revealed`).
- Before reveal, every marble on the projector is gold and every landing sound is the same clack. Nothing differs by vote until `revealed` arrives.
- No sound on phones. All sound goes through `src/client/sound.ts`, imported only by projector code.
- The percentage is Yes as a share of votes cast, formatted like the results screen: `${Number(percent.toFixed(1))}%`.
- `MarblePit` keeps its sleep-when-settled loop: no animation frames once nothing moves.
- Reduced motion: no drop on the projector (finished state plus bell); tap Yes/No casts immediately on the phone.
- Modules under test (`pegboard.ts`, `pegboardRun.ts`, `percent.ts`, `revealWatch.ts`, `feel.ts`, `marblePile.ts`) must not touch `window`/`document` at import time; tests run under `tsconfig.worker.json` (no DOM lib), so they also must not import DOM types.
- Random sources are injected as `random: () => number = Math.random` so tests can seed them. Tests use a local mulberry32.
- Verify with `bun run test`, `bun run typecheck`, `bun run lint`, `bun run format:check` before any task is called done.
- Commits go to master, `feat:`/`fix:` style, no attribution lines.

## Review Focus

1. **Host presses Next mid-drop.** The drop stops, no further tock/tick/thud/bell plays, the board's marbles drain, and the next PNM's pile starts empty. Test in Task 2 (`cancel()` silences the run).
2. **A one-sided vote (12–0, or 400–0 in a big room).** Every marble fits in one bin without overlapping the bin walls or spilling above the bin top. Test in Task 1.
3. **More than 400 voters.** Marbles are capped at 400, but the bin counts climb to exactly the frozen tally. Test in Task 2 (`shownCount`).
4. **The pile on screen disagrees with the frozen tally** (a ballot still mid-spawn, a late vote change). The hopper ends with exactly `yes + no` marbles before the first release. Test in Task 2.
5. **Projector reconnects after the reveal it was watching.** It shows the finished board, never replays the drop. Test in Task 5 (`watchReveal`).

---

## File Structure

- Create `src/client/pegboard.ts`: board layout, side scaling, shuffling, path planning, release schedule. Pure.
- Create `src/client/pegboardRun.ts`: `PegboardRun` timeline (hopper hand-off, releases, path playback, counts, events). Pure.
- Create `src/client/sound.ts`: Web Audio recipes and the on/muted store with `useSound()`.
- Create `src/client/components/SoundToggle.tsx`: the projector's "Turn on sound" button and mute toggle.
- Create `src/client/percent.ts`: `yesPercent`, `formatPercent` (moved out of `Results.tsx`).
- Create `src/client/revealWatch.ts`: `watchReveal` reducer telling a live reveal from a loaded one.
- Modify `src/client/marblePile.ts`: remove `reveal()`/sides/flip/sorted logic; add landings and `absorb()`.
- Modify `src/client/components/MarblePit.tsx`: pegboard mode, board drawing, clack.
- Modify `src/client/screens/Projector.tsx`: reveal flow, result block, sound toggle.
- Modify `src/client/screens/Results.tsx`: import `formatPercent`.
- Modify `src/client/feel.ts`: `isFlick`.
- Modify `src/client/components/VoteButtons.tsx`, `src/client/screens/Brother.tsx`: pick, flick, cast.
- Tests: `test/pegboard.test.ts`, `test/pegboardRun.test.ts`, `test/marblePile.test.ts`, `test/projectorReveal.test.ts`, `test/feel.test.ts`, plus a shared `test/random.ts` (mulberry32).

---

### Task 1: Board layout and planned paths

**Files:**
- Create: `src/client/pegboard.ts`
- Create: `test/random.ts`
- Test: `test/pegboard.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Side = "yes" | "no";            // move here; marblePile.ts re-exports it
  export interface Point { x: number; y: number }
  export const BOARD_WIDTH = 1600, BOARD_HEIGHT = 900, MAX_MARBLES = 400;
  export interface Board {
    radius: number;                 // marble radius
    pegRadius: number;
    pegs: Point[];                  // row-major; row i holds i + 3 pegs
    rows: number;                   // PEG_ROWS = 9
    spout: Point;
    hopper: Point[];                // slot 0 is at the spout, then outward and upward
    bins: Record<Side, { left: number; right: number; top: number; bottom: number }>;
    slots: Record<Side, Point[]>;   // resting places, bottom row first
    gravity: number;                // logical px/s²
  }
  export function layoutBoard(sides: { yes: number; no: number }): Board;
  export function pegIndex(row: number, column: number): number;
  export function shuffleSides(sides: { yes: number; no: number }, random?: () => number): Side[];
  export interface Arc { start: number; duration: number; x: number; y: number; vx: number; vy: number; peg: number | null }
  export interface Path { arcs: Arc[]; duration: number }  // arc.peg: peg hit at the arc's START, null for the first arc
  export function planPath(board: Board, side: Side, slot: Point, random?: () => number): Path;
  export function pathPoint(path: Path, t: number, gravity: number): Point;
  ```

- [ ] **Step 1: Write `test/random.ts`**: `export function seeded(seed: number): () => number` (mulberry32).

- [ ] **Step 2: Write the failing tests** in `test/pegboard.test.ts`:

```ts
it("fits every marble of a one-sided vote inside its bin", () => {
  for (const sides of [{ yes: 12, no: 0 }, { yes: 0, no: 400 }, { yes: 200, no: 200 }, { yes: 1, no: 1 }]) {
    const board = layoutBoard(sides);
    for (const side of ["yes", "no"] as const) {
      const bin = board.bins[side];
      expect(board.slots[side]).toHaveLength(sides[side]);
      for (const { x, y } of board.slots[side]) {
        expect(x - board.radius).toBeGreaterThanOrEqual(bin.left);
        expect(x + board.radius).toBeLessThanOrEqual(bin.right);
        expect(y - board.radius).toBeGreaterThanOrEqual(bin.top);
        expect(y + board.radius).toBeLessThanOrEqual(bin.bottom);
      }
    }
    expect(board.hopper).toHaveLength(sides.yes + sides.no);
  }
});
it("puts the Yes bin left of center and the No bin right of it", ...);   // bins.yes.right <= 800 <= bins.no.left
it("leaves room for a marble to pass between neighboring pegs", ...);   // gap - 2*pegRadius > 2*radius * 1.2
it("shuffles exactly the tally", ...);   // counts of shuffleSides({yes: 27, no: 13}, seeded(1)) are 27 and 13
it("ends every planned path at its slot, on its own side", () => {
  const board = layoutBoard({ yes: 30, no: 30 });
  const random = seeded(7);
  for (const side of ["yes", "no"] as const)
    for (const slot of board.slots[side]) {
      const path = planPath(board, side, slot, random);
      const end = pathPoint(path, path.duration, board.gravity);
      expect(end.x).toBeCloseTo(slot.x, 6);
      expect(end.y).toBeCloseTo(slot.y, 6);
    }
});
it("never crosses the center line once below the last peg row", ...);
  // sample pathPoint every 1/240 s; for y > last peg row y: yes => x < 800, no => x > 800
it("hits one peg per row, each a neighbor of the last", ...);
  // arcs with peg !== null: rows 0..8 in order; row 0 hits the center peg; column(i+1) - column(i) is 0 or 1
it("is continuous between arcs", ...);
  // end of arc k (pathPoint at arc.start + arc.duration - 1e-9) equals start of arc k+1 to 1e-6
it("uses both sides of the board for each bin", ...);
  // over 200 yes paths, some row-4 hit is right of center and some left: pegs bounce, they don't decide
```

- [ ] **Step 3: Run** `bun run test test/pegboard.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/client/pegboard.ts`.**

Pinned values (logical 1600×900): hopper tray spans x 600–1000, bottom at y 150 above a spout at (800, 170); `PEG_ROWS = 9`, row `i` has `i + 3` pegs at `y = 220 + i * rowGap`, `rowGap = 34`, column gap `gap = 52`, peg `x = 800 + (column - (i + 2) / 2) * gap`, `pegRadius = 5`. Bins: tops at y 560, bottoms at 880, Yes from x 440 to 794, No from 806 to 1160 (6-px divider at 800). `gravity = 2600`.

Radius: largest `r ≤ 0.3 * (gap - 2 * pegRadius)` such that `max(yes, no)` hex-packed slots fit the bin and `yes + no` hex-packed slots fit the hopper tray. Slots are hex-packed (row pitch `r * 2.05 * 0.87`, every other row offset by half a pitch), bottom row first.

Path planning, the one algorithm the tests don't fix:
1. Draw 9 left/right decisions from `random`. The first 8 move between rows (left keeps the column, right adds 1); the 9th is the bounce off the last row into the bins. The horizontal offset from center after all 9 is `(rights - lefts) * gap / 2`, never zero because 9 is odd. If it lands on the wrong side, mirror every decision. Mirroring keeps the distribution identical for both sides, so no bin looks favored.
2. Contact point for a hit on peg `p` from the left/right: `(p.x ∓ (radius + pegRadius) * 0.45, p.y - (radius + pegRadius) * 0.9)`.
3. Each arc is a parabola under `gravity` from one point to the next with a chosen duration: `vx = dx / T`, `vy = (dy - gravity * T² / 2) / T`. Spout to row 0: `T = 0.16`. Peg to peg: `T = 0.11 * (0.85 + 0.3 * random())`. Last peg to slot: `T = sqrt(2 * (slot.y - start.y) / gravity) * 1.1`.
4. `pathPoint` finds the arc containing `t` (clamped to `[0, duration]`) and evaluates it.

`shuffleSides` is Fisher–Yates over `yes` "yes" and `no` "no" entries.

- [ ] **Step 5: Run** `bun run test test/pegboard.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit** `feat: plan pegboard paths that always land in their own bin`.

---

### Task 2: Drop timeline

**Files:**
- Create: `src/client/pegboardRun.ts`
- Test: `test/pegboardRun.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  ```ts
  export function marbleSides(tally: Tally, max?: number): { yes: number; no: number };  // default MAX_MARBLES
  export function shownCount(landed: number, planned: number, tally: number): number;
  export function releaseGaps(count: number): number[];   // seconds between releases, length count - 1
  export type DropEvent =
    | { type: "tock" } | { type: "tick"; peg: number; strength: number }
    | { type: "thud"; side: Side } | { type: "done" };
  export interface DropMarble { x: number; y: number; radius: number; side: Side | null; flip: number; alpha: number }
  export class PegboardRun {
    constructor(board: Board, sides: Side[], from: Point[], random?: () => number);
    static finished(board: Board, sides: Side[]): PegboardRun;   // every marble in its slot, done, no events
    readonly board: Board;
    marbles: DropMarble[];      // for drawing; hopper and released alike
    pegGlow: number[];          // 0..1 per peg, decays
    landed: { yes: number; no: number };
    done: boolean;
    step(dt: number): DropEvent[];   // returns [] after cancel() or once settled
    cancel(): void;
    get moving(): boolean;
  }
  ```

- [ ] **Step 1: Write the failing tests:**

```ts
it("lands exactly the tally in each bin and says done once", () => {
  const board = layoutBoard({ yes: 27, no: 13 });
  const run = new PegboardRun(board, shuffleSides({ yes: 27, no: 13 }, seeded(2)), [], seeded(3));
  const events = drain(run);  // step(1/60) until !run.moving, at most 60 s
  expect(run.landed).toEqual({ yes: 27, no: 13 });
  expect(events.filter((e) => e.type === "thud")).toHaveLength(40);
  expect(events.filter((e) => e.type === "tock")).toHaveLength(40);
  expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  expect(events.at(-1)).toEqual({ type: "done" });
});
it("rests every marble in a slot of its own bin", ...);   // after drain: each marble.side's bin contains (x, y)
it("fills the hopper with exactly the tally whatever the pile held", () => {
  // from = 25 points and from = 60 points, sides = 40: after step(HOPPER_RISE_S),
  // marbles with alpha > 0.99 number 40 and none has a side yet
});
it("keeps marbles gold until they leave the hopper", ...);  // before the first tock every marble has side null
it("goes silent when cancelled", ...);  // step a while, cancel(), then 100 steps return []
it("finishes a drop in 10 to 20 seconds for 20 to 400 voters", () => {
  for (const count of [20, 40, 62, 150, 400]) {
    const total = releaseGaps(count).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(10 - 1.5);  // path flight (~1.5 s) is added on top
    expect(total).toBeLessThanOrEqual(20 - 1.5);
  }
});
it("slows down for the last five marbles", ...);  // last 5 gaps strictly increase and the first of them > the gap before
it("caps marbles and still counts to the exact tally", () => {
  expect(marbleSides({ yes: 600, no: 200 })).toEqual({ yes: 300, no: 100 });
  expect(marbleSides({ yes: 799, no: 1 }).no).toBe(1);   // a side with votes keeps at least one marble
  for (let landed = 0; landed <= 300; landed++) expect(shownCount(landed, 300, 600)).toBe(landed * 2);
  expect(shownCount(1, 1, 1)).toBe(1);
  expect(shownCount(0, 0, 0)).toBe(0);
});
```

- [ ] **Step 2: Run** `bun run test test/pegboardRun.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/client/pegboardRun.ts`.**

Pinned values:
- `HOPPER_RISE_S = 0.9`: hopper marbles ease from `from[i]` to hopper slots. If `from` is shorter than `sides`, the extra marbles start at their slot with alpha 0 and fade in over the rise. If longer, the surplus (highest index first) keeps its position and fades out over the rise. `from` positions arrive already in board coordinates.
- First release at `HOPPER_RISE_S + 0.3`. The released marble is the one in hopper slot 0; it emits `tock`. Every other hopper marble then re-targets the slot one index lower and eases there at rate 12/s.
- `releaseGaps(count)`: base gap `min(0.45, 13 / count)`; the gaps before the last five marbles are `[0.42, 0.58, 0.74, 0.9, 1.06]` (the spike's slow finish), never shorter than the base gap. Fewer than six marbles get the slow tail only.
- The marble's side is assigned on release (not before), and `flip` goes 0 to 1 over 0.25 s after release.
- Slot assignment: marbles land in release order (paths take nearly equal time), so the k-th marble of a side gets `board.slots[side][k]`. Plan each path at release with `planPath`.
- `tick` when playback crosses an arc start with `peg !== null`: `strength = clamp(|vy at contact| / 900, 0.3, 1)`; sets `pegGlow[peg] = 1`. Glow decays by `exp(-dt * 8)`.
- `thud` when a marble's path completes; increments `landed[side]`.
- `done` 0.5 s after the last thud.
- `moving` is false once done and every glow is below 0.01, or after `cancel()`.

- [ ] **Step 4: Run** `bun run test test/pegboardRun.test.ts test/pegboard.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: time the pegboard drop with a slow finish`.

---

### Task 3: Sound and the clack

**Files:**
- Create: `src/client/sound.ts`
- Create: `src/client/components/SoundToggle.tsx`
- Modify: `src/client/marblePile.ts`
- Modify: `src/client/components/MarblePit.tsx`
- Modify: `src/client/screens/Projector.tsx` (mount `SoundToggle` only)
- Test: `test/marblePile.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // sound.ts
  export const sound: { clack(pitch: number): void; tock(): void; tick(strength: number): void; thud(side: Side): void; bell(): void };
  export type SoundStatus = "off" | "on" | "muted";   // "off" until someone clicks
  export function useSound(): { status: SoundStatus; enable(): void; toggleMute(): void };
  // marblePile.ts
  MarblePile.takeLandings(): number;   // marbles that first came to rest since the last call
  // MarblePit.tsx new prop
  clacks: boolean;
  ```

- [ ] **Step 1: Write the failing test** in `test/marblePile.test.ts`:

```ts
it("reports each marble's landing once", () => {
  const pile = new MarblePile();
  pile.resize(800, 600);
  pile.setTarget(5, 10);
  let landings = 0;
  for (let frame = 0; frame < 600; frame++) { pile.step(1 / 60); landings += pile.takeLandings(); }
  expect(landings).toBe(5);
});
it("doesn't report draining marbles as landings", ...);  // after drain() and more steps, takeLandings() stays 0
```

- [ ] **Step 2: Run** `bun run test test/marblePile.test.ts`. Expected: FAIL (`takeLandings` missing).

- [ ] **Step 3: Implement.**
- `Marble` gains `landed: boolean`. A non-draining marble lands the first time `contain()` stops it on the floor, or `collide()` resolves it against a landed marble with approach speed above 120 px/s.
- `sound.ts`: port the spike's `init`, `ping`, `burst`, `clack`, `tick` (18 ms rate limit), `thud`, `tock`, `bell` as written there; drop `whoosh` because phones are silent. Each call is a no-op unless status is `"on"`. The store lives at module scope with a listener set; `useSound` reads it with `useSyncExternalStore`. `enable()` creates and resumes the `AudioContext` inside the click. Mute is kept in `sessionStorage` key `ballot.soundMuted` (wrapped in try/catch).
- `SoundToggle`: fixed bottom-right (`fixed right-[1.5vw] bottom-[1.5vw] z-20`). When `"off"` it shows `btn btn-secondary` "Turn on sound". Otherwise a small round icon button with `aria-pressed` and `aria-label` "Sound on"/"Sound off".
- `MarblePit`: when `clacks` is true, each frame calls `sound.clack(live / capacity)` once per landing, where `live` is the count of non-draining marbles. Every clack goes through the same call, so it can't vary by vote.
- `Projector` mounts `<SoundToggle />` once, outside the per-phase branches. `Stage` passes `clacks` as true only for a PNM scene with `revealed === null`.

- [ ] **Step 4: Run** `bun run test`. Expected: PASS.

- [ ] **Step 5: Manual check.** Run `bun run dev:worker` and `bun run dev`, open a projector, click "Turn on sound", vote from two phone tabs, and confirm identical clacks rising in pitch and that mute silences them.

- [ ] **Step 6: Commit** `feat: clack each ballot as it lands on the projector`.

---

### Task 4: Pegboard mode in MarblePit

**Files:**
- Modify: `src/client/marblePile.ts`
- Modify: `src/client/components/MarblePit.tsx`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (MarblePit props, replacing `yesShown`):
  ```ts
  reveal: { tally: Tally; live: boolean } | null;
  onDropDone?: () => void;   // fires once per live drop, after its bell
  ```
  `MarblePile.reveal`, `sides`, `sorted`, `flip`, `isOnOwnHalf`, `holdSide`, `sideForNewMarble` and the sort constants are removed. `Marble.side`/`flip` are kept only so drained board marbles keep their color. New `MarblePile.absorb(marbles: { x: number; y: number; radius: number; side: Side | null }[])` adds them as draining marbles with `flip: 1`.
  `MarblePile.takeAll(): Point[]` returns the positions of live (non-draining, non-leaving) marbles and removes them.

- [ ] **Step 1: Add the test** to `test/marblePile.test.ts`: `absorb` marbles fall off the bottom, and after enough steps `pile.marbles` is empty. `takeAll` returns the live marbles and leaves draining ones.

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.**
- Board transform: `scale = min(innerWidth / BOARD_WIDTH, innerHeight / BOARD_HEIGHT)`, centered. It's recomputed on resize, so going full screen mid-drop just rescales.
- When `reveal` turns non-null for the current scene:
  - **Live, with marbles to drop:** `sides = shuffleSides(marbleSides(tally))`; `from = pile.takeAll()` mapped into board coordinates; start `new PegboardRun(layoutBoard(marbleSides(tally)), sides, from)`.
  - **Not live:** start `PegboardRun.finished(...)`.
  - **No votes** (`yes + no === 0`): no run.
- Each frame with a run: `events = run.step(dt)`. Play `tock`/`tick`/`thud` through `sound`. On `done`, play `sound.bell()` and call `onDropDone`. Keep the loop awake while `run.moving`.
- On scene change with a run: `cancel()`, then `pile.absorb(run.marbles mapped to window coordinates)`, then drop the run and call `drain()` as today.
- Drawing the board (logical coordinates under the board transform):
  - hopper tray and spout as in the spike;
  - pegs filled `rgb(200 180 120)`, lerping to `rgb(255 230 160)` with glow plus the glow halo;
  - bin outlines and the divider at `rgb(247 244 236 / 0.14)`;
  - "YES"/"NO" labels and the big counts beside the bins (x 300 and 1300, counts at y 700 in `700 72px` using `getComputedStyle(document.documentElement).getPropertyValue("--font-display")`);
  - counts come from `shownCount(run.landed[side], plannedSide, tally[side])`;
  - marbles use the existing sprites, shadow and gold-to-side crossfade by `flip`.
  - Once `run.done`, pegs and hopper fade to alpha 0.15 over 0.6 s so the result block can sit over them.
- Remove the old `reveal()` call path.

- [ ] **Step 4: Run** `bun run test && bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: drop revealed ballots through the pegboard`.

---

### Task 5: Projector reveal flow

**Files:**
- Create: `src/client/percent.ts`, `src/client/revealWatch.ts`
- Modify: `src/client/screens/Projector.tsx`, `src/client/screens/Results.tsx`
- Test: `test/projectorReveal.test.ts`

**Interfaces:**
- Consumes: `MarblePit` props from Task 4, `sound` from Task 3.
- Produces:
  ```ts
  export function yesPercent(tally: Tally): number;          // 0 when no votes; same formula as room.ts:685
  export function formatPercent(percent: number): string;    // moved verbatim from Results.tsx
  // revealWatch.ts: the PNM id this screen saw unrevealed while connected, or null
  export function watchReveal(watched: string | null, pnmId: string | null, revealed: boolean, connection: Connection): string | null;
  ```
  A reveal is live iff `revealed && watched === pnmId`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("formats the percent like the results screen", () => {
  expect(formatPercent(yesPercent({ yes: 27, no: 13 }))).toBe("67.5%");
  expect(formatPercent(yesPercent({ yes: 2, no: 1 }))).toBe("66.7%");
  expect(yesPercent({ yes: 0, no: 0 })).toBe(0);
});
it("plays a reveal it watched happen", () => {
  let w = watchReveal(null, "a", false, "open");
  w = watchReveal(w, "a", true, "open");
  expect(w).toBe("a");
});
it("doesn't replay a reveal that was already there on load", ...);   // watchReveal(null, "a", true, "open") === null
it("doesn't replay a reveal that happened while disconnected", ...);
  // watched "a", then (a, false, "reconnecting") → null, then (a, true, "open") → null
it("forgets the last PNM when the next comes up", ...);   // watched "a", then ("b", false, "open") → "b"
```

- [ ] **Step 2: Run** `bun run test test/projectorReveal.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
- `Projector` keeps `watched` in a ref updated with `watchReveal` on each render, and passes `reveal = revealed && { tally: revealed, live }` to `Stage`/`MarblePit`. It holds `dropDone` state, reset when the PNM changes. It's true immediately when the reveal isn't live, has no votes, or reduced motion is on.
- While revealed, the `Spotlight` exits (`AnimatePresence`, same slide) and a new `RevealResult` takes its place. The result block shows nothing until `dropDone`. It then shows, centered in the top 55% of the screen: the photo (`PnmPhoto`, `h-[28vh]`), the name, `{formatPercent(yesPercent(tally))} Yes` in `font-display text-[6vw]`, and "N didn't vote" as today. It enters with `materialize` and is `aria-live="polite"`. The `place` line stays top-left.
- No votes, or reduced motion: render today's `Verdict` inside `RevealResult` in place of the percent line, since there are no bins to count beside.
- Live reveal with reduced motion: play `sound.bell()` once, from an effect keyed on the PNM id.
- `Results.tsx` imports `formatPercent` from `../percent`.

- [ ] **Step 4: Run** `bun run test && bun run typecheck && bun run lint`. Expected: PASS.

- [ ] **Step 5: Manual check (two terminals as above).** Check each of these:
  - A reveal at 3–2 plays the drop, then bell, percent, photo and name.
  - Reloading the projector shows the finished board with no drop.
  - Pressing Next mid-drop stops the sound, drains the bins and brings up the next PNM.
  - A PNM with zero votes shows the old verdict.
  - With reduced motion emulated in devtools, there's no drop but the bell plays.

- [ ] **Step 6: Commit** `feat: reveal votes through the pegboard on the projector`.

---

### Task 6: Flick to vote

**Files:**
- Modify: `src/client/feel.ts`, `src/client/components/VoteButtons.tsx`, `src/client/screens/Brother.tsx`
- Test: `test/feel.test.ts`

**Interfaces:**
- Produces: `export function isFlick(offsetY: number, velocityY: number): boolean` in `feel.ts`, true when `offsetY + project(velocityY) < -FLICK_DISTANCE` (`FLICK_DISTANCE = 120`) and `offsetY < -12`.
- `VoteButtons` props are unchanged. `Brother` renders it with `key={pnm.id}` so pick state resets per PNM.

- [ ] **Step 1: Write the failing test:**

```ts
it("counts a fast short flick and a slow long drag, not a twitch or a pull down", () => {
  expect(isFlick(-40, -900)).toBe(true);
  expect(isFlick(-130, 0)).toBe(true);
  expect(isFlick(-8, -2000)).toBe(false);
  expect(isFlick(60, -300)).toBe(false);
});
```

- [ ] **Step 2: Run** `bun run test test/feel.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `VoteButtons` has local state `picked: VoteValue | null` and `changing: boolean`. Modes:
  - **cast** (`value && !changing && !picked`):
    - a `size-7` marble in `ball-yes`/`ball-no`;
    - "Your Yes is in" / "Your No is in";
    - links "Change my vote" (sets `changing`) and "Clear my vote" (as today);
    - while `sending`, "Sending your vote" replaces the links.
  - **choose** (no `picked`): today's two marbles, but tapping one picks it and fires `haptic()`. When `reducedMotion` is set, a tap casts immediately as today.
  - **picked:**
    - The picked marble moves to center with a `flick` spring and grows to `scale 1.12`; the other fades out.
    - A slot (`h-3 w-28 rounded-full bg-black shadow-inner`) appears above the picked marble, with the brass caption "Flick it up to cast" and a nudging ↑ (CSS keyframe; none under reduced motion).
    - The picked marble is `drag="y"`, `dragConstraints={{ top: 0, bottom: 0 }}`, `dragElastic={{ top: 0.9, bottom: 0.1 }}`. `onDragEnd` casts when `isFlick(offset.y, velocity.y)`, and `onTap` casts too.
    - Casting fires `haptic()`, animates the marble to `y: "-70vh", scale: 0.5, opacity: 0` over 0.36 s ease-in, then calls `onVote(picked)` and clears `picked` and `changing`.
    - Below the marble sits the link "Pick No" / "Pick Yes".
  - `disabled` blocks picking and casting.
  - If `yesDisabled` becomes true while Yes is picked, clear the pick.
  - The picked marble sets `touch-action: none` so vertical drags don't scroll the page.
  - The footer sits outside the card's `drag="x"` element, so the two gestures never share a target.

- [ ] **Step 4: Run** `bun run test && bun run typecheck && bun run lint`. Expected: PASS.

- [ ] **Step 5: Manual check** in a phone-sized devtools window with touch emulation:
  - pick, then flick, and the vote appears in "All PNMs";
  - tapping the picked marble casts;
  - Change my vote goes back to picking;
  - when Yes is out of budget, Yes stays disabled;
  - swiping the card still changes PNM;
  - with reduced motion, a tap casts immediately;
  - after casting, the projector clacks the same for Yes and No.

- [ ] **Step 6: Commit** `feat: flick your marble up to cast a vote`.

---

### Task 7: Final verification

- [ ] **Step 1:** Run `bun run test && bun run typecheck && bun run lint && bun run format:check`. All four must pass; run `bun run format` if only formatting fails, then recheck.
- [ ] **Step 2:** Run one full pass with `bun run dev:worker` and `bun run dev`: lobby, vote with three phones, reveal, Next mid-drop, a revote reveal, end session. Confirm nothing on the projector differs by vote before the reveal.
- [ ] **Step 3:** Commit any fixes as `fix:` commits. Don't push unless asked.
