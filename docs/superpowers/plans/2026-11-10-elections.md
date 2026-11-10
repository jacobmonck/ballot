# Elections Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Ballot room run an officer elections night: several positions, each with its own
seat count and candidates. Brothers pick up to N candidates, a winner needs 50% + 1, and
last-place runoffs repeat until every seat is filled.

**Architecture:** A room gets a `mode` column (`recruitment` | `election`). Election state lives
in three new SQLite tables (`position`, `candidate`, `pick`) added by migration 7. The counting
rule is a pure function in `src/worker/election.ts`. SQL reads and writes for positions live in
`src/worker/positions.ts`, and `room.ts` only routes messages and broadcasts. Apart from picks,
which send patches like votes do, every election change goes out through
`broadcastSnapshots()`, since these changes happen a handful of times a night. Clients branch
on `snapshot.mode`.

**Tech Stack:** TypeScript, Cloudflare Durable Objects (SQLite), React 19, Tailwind 4, Motion,
Vitest with `@cloudflare/vitest-plugin`, Bun.

**Spec:** `docs/superpowers/specs/2026-11-10-elections-design.md`

## Global Constraints

- Recruitment mode must behave exactly as today. Every existing test passes unchanged.
- Existing rooms keep working after the migration and read as `mode = 'recruitment'`.
- Migrations are forward-only: add step 7 to `src/worker/schema.ts`, never edit steps 1–6.
- Every new client message is parsed in `src/worker/validate.ts`. Anything malformed becomes
  `null`, which becomes a `bad_message` error.
- Live counts reach hosts only, through `sendToHosts`. Phones learn only their own picks. The
  projector learns only ballot progress until the host reveals winners.
- Winners stay hidden from phones and projector until the whole position is decided and the
  host reveals it.
- Limits: up to 50 positions, up to 50 candidates per position, titles and names 1–80
  characters after trimming. Seats are an integer from 1 to (candidates − 1).
- Majority: picks ≥ floor(ballots / 2) + 1, where ballots = members with at least one pick
  this round (kicked members' ballots still count).
- Before each commit: `bun run test`, `bun run typecheck`, `bun run lint`,
  `bun run format:check`.
- Commit messages use Angular style (`feat:`, `fix:`, `test:`, `docs:`), with no co-author or
  "generated with" lines. Commit straight to `master`.

## Review Focus

1. **A brother picks, then the host closes the round before the pick lands.** A pick sent
   after close must be refused with `not_voting`, and the phone must drop its pending pick
   rather than resend it forever. (Task 3 test, Task 5 test.)
2. **A brother reconnects mid-round.** The snapshot must restore their current-round picks in
   `myPicks`, and a pick pending from before the reconnect must be resent. (Task 3 test, Task 5
   test.)
3. **A runoff round after a partial win.** On a 2-seat position where one candidate cleared
   majority, phones and projector must not learn the winner's name before the reveal. Brothers
   see `seatsOpen: 1` and a ballot without them, and nothing else. (Task 3 privacy test.)
4. **A round closed with zero ballots.** Nobody clears majority, and everyone is tied for last
   at 0, so the round is revoted with nobody dropped. It must not crash or elect anyone. (Task 1
   test.)
5. **Mode crossing.** In an election room, PNM messages (`importPnms`, `vote`, `setBudget`,
   `setFocus`, `reveal`, `startRevote`, `revealClass`) are refused with `wrong_mode`, and
   election messages are refused in recruitment rooms in the same way. (Task 4 test.)

---

### Task 1: Round counting rule

**Files:**
- Create: `src/worker/election.ts`
- Test: `test/election.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RoundInput {
    seatsOpen: number;
    ballots: number;
    // Every candidate still on the ballot, in setup order.
    candidates: { id: string; picks: number }[];
  }
  export interface RoundOutcome {
    elected: string[];     // candidate ids elected this round, most picks first
    nextBallot: string[];  // empty when decided
    decided: boolean;
  }
  export function majority(ballots: number): number; // floor(ballots / 2) + 1
  export function countRound(input: RoundInput): RoundOutcome;
  ```

The algorithm, which the tests don't fully pin:

```
clearers = candidates with picks >= majority(ballots), sorted by picks desc (stable)
if clearers.length > seatsOpen and clearers[seatsOpen-1].picks == clearers[seatsOpen].picks:
    tieValue = clearers[seatsOpen-1].picks
    elected = clearers with picks > tieValue
    return { elected, nextBallot: clearers with picks == tieValue, decided: false }
elected = clearers.slice(0, seatsOpen)
remaining = seatsOpen - elected.length
if remaining == 0: decided
rest = candidates not elected
if every candidate in rest has the same picks: nextBallot = rest (nobody dropped)
survivors = rest minus everyone with the fewest picks
if survivors.length <= remaining: elected += survivors (by picks desc), decided
else nextBallot = survivors
```

- [ ] **Step 1: Write the failing tests** in `test/election.test.ts`, one `it` each:
  - `majority`: `majority(10) === 6`, `majority(9) === 5`, `majority(0) === 1`.
  - "elects a 1-seat majority winner": seats 1, ballots 10, picks A6 B3 C1 → `{ elected: ["A"], nextBallot: [], decided: true }`.
  - "exactly half is not a majority": seats 1, ballots 10, A5 B5 → not decided. All are tied, so `nextBallot: ["A","B"]` and `elected: []`.
  - "drops last place when nobody clears": seats 1, ballots 10, A4 B3 C2 D1 → `{ elected: [], nextBallot: ["A","B","C"], decided: false }`.
  - "drops everyone tied for last": seats 1, ballots 10, A4 B4 C1 D1 → `nextBallot: ["A","B"]`.
  - "leader wins when dropping the tied last leaves only them": seats 1, ballots 10, A4 B3 C3 → `{ elected: ["A"], decided: true }`.
  - "2-seat: both clear": seats 2, ballots 10, A7 B6 C3 → `elected: ["A","B"], decided: true`.
  - "2-seat: one clears, runoff for the other": seats 2, ballots 10, A8 B4 C3 D2 → `{ elected: ["A"], nextBallot: ["B","C"], decided: false }`.
  - "2-seat: drop leaves as many as seats, so they win": seats 2, ballots 10, A5 B4 C2 → `{ elected: ["A","B"], decided: true }`.
  - "tie at the last seat among clearers revotes only the tied": seats 2, ballots 10, A9 B7 C7 D1 → `{ elected: ["A"], nextBallot: ["B","C"], decided: false }`.
  - "zero ballots revotes everyone": seats 1, ballots 0, A0 B0 C0 → `{ elected: [], nextBallot: ["A","B","C"], decided: false }`.

- [ ] **Step 2: Run** `bun run test test/election.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `majority` and `countRound` in `src/worker/election.ts` per the algorithm above. Pure, with no imports.
- [ ] **Step 4: Run** `bun run test test/election.test.ts`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: add election round counting rule`

---

### Task 2: Protocol, schema, mode and position setup

**Files:**
- Modify: `src/shared/protocol.ts`, `src/worker/schema.ts`, `src/worker/validate.ts`, `src/worker/room.ts`
- Create: `src/worker/refusal.ts` (move the `Refusal` class out of `room.ts` unchanged, and export it), `src/worker/positions.ts`
- Modify: `test/helpers.ts`
- Test: `test/elections.test.ts`

**Interfaces:**
- Produces in `protocol.ts`:
  ```ts
  export type RoomMode = "recruitment" | "election";
  export type PositionStatus = "pending" | "voting" | "runoff" | "decided";
  export interface PositionInput { title: string; seats: number; candidates: string[] }
  export interface Candidate { id: string; name: string }
  // How a position looks to the socket receiving it.
  export interface Position {
    id: string; ordinal: number; title: string; seats: number;
    seatsOpen: number;          // seats minus those already filled
    status: PositionStatus;
    round: number;              // 0 until first opened
    ballot: Candidate[];        // brothers/projector: [] unless status is "voting"
    winners: Candidate[] | null; // non-host: null until revealed. Host: elected so far.
    revealed: boolean;
  }
  export interface RoundTally { ballots: number; picks: Record<string, number> }
  // Host only.
  export interface PositionDetail { candidates: Candidate[]; rounds: RoundTally[]; live: RoundTally }
  export interface PositionProgress { positionId: string; voted: number; total: number }
  export interface SlateEntry { positionId: string; title: string; winners: string[] }
  ```
  New `Snapshot` fields: `mode: RoomMode`, `positions: Position[]`, `focusPositionId: string | null`, `positionProgress: PositionProgress | null`, `myPicks: Record<string, string[]>`, `slate: SlateEntry[] | null`. Also `hostOnly.positionDetails: Record<string, PositionDetail>`.
  New `ClientMessage` variants:
  ```ts
  | { type: "setMode"; mode: RoomMode }
  | { type: "addPosition"; position: PositionInput }
  | { type: "updatePosition"; positionId: string; position: PositionInput }
  | { type: "removePosition"; positionId: string }
  | { type: "movePosition"; positionId: string; direction: -1 | 1 }
  | { type: "openRound"; positionId: string }
  | { type: "pick"; positionId: string; candidateIds: string[] }
  | { type: "closeRound"; positionId: string }
  | { type: "revealWinners"; positionId: string }
  | { type: "revealSlate" }
  ```
  New `ServerMessage` variants (used in Task 3):
  `{ type: "myPicks"; positionId: string; candidateIds: string[] }`, `({ type: "positionTally"; positionId: string } & RoundTally)`, `({ type: "positionProgress" } & PositionProgress)`.
  New `ErrorCode` values: `"wrong_mode"`, `"not_voting"`, `"bad_ballot"`.
- Produces in `positions.ts`: functions that take `sql: SqlStorage` and throw `Refusal`:
  `addPosition(sql, input)`, `updatePosition(sql, id, input)`, `removePosition(sql, id)`,
  `movePosition(sql, id, direction)`, `positionsFor(sql, role): Position[]`,
  `positionDetails(sql): Record<string, PositionDetail>`. Later tasks add more.
- Produces in `test/helpers.ts`: `fakePositions(): PositionInput[]` (President, 1 seat, 3 candidates; Social Chair, 2 seats, 4 candidates). Also `electionRoom()`, which creates a room, sends `setMode` election, adds `fakePositions()`, and returns `{ code, hostKey, host, positions: Position[] }` from the host's last snapshot.

Migration 7:
```sql
ALTER TABLE room ADD COLUMN mode TEXT NOT NULL DEFAULT 'recruitment';
ALTER TABLE room ADD COLUMN focus_position_id TEXT;
CREATE TABLE position (
  id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, title TEXT NOT NULL,
  seats INTEGER NOT NULL, seats_open INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', round INTEGER NOT NULL DEFAULT 0,
  revealed INTEGER NOT NULL DEFAULT 0, past_rounds TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE candidate (
  id TEXT PRIMARY KEY, position_id TEXT NOT NULL, ordinal INTEGER NOT NULL, name TEXT NOT NULL,
  on_ballot INTEGER NOT NULL DEFAULT 1, elected INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pick (
  member_id TEXT NOT NULL, position_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (member_id, candidate_id)
);
CREATE INDEX idx_pick_position ON pick(position_id);
```
The slate reuses the existing `room.class_revealed` column.

Rules:
- `setMode` works only in `setup` with zero PNMs and zero positions. Otherwise it's refused
  with `wrong_phase`.
- `addPosition`, `updatePosition`, `removePosition` and `movePosition` need election mode
  (otherwise `wrong_mode`) and a phase that isn't `ended`. Update, remove and move need the
  position to be `pending` (otherwise `wrong_phase`). Ordinals stay 1..n with no gaps.
- `validate.ts` checks the size limits: 50 positions, 50 candidates, 80-character names. It
  also checks seats are an integer in 1..candidates.length − 1, and that candidate names are
  unique within a position, ignoring case after trimming. `positions.ts` refuses a 51st
  position with `bad_message`.
- Brothers and projector get only positions whose status isn't `pending`, the same way
  unseen PNMs are hidden today.

- [ ] **Step 1: Write failing tests** in `test/elections.test.ts`, `describe("election setup")`:
  - "defaults existing and new rooms to recruitment": the new room's snapshot has `mode === "recruitment"` and `positions` equal to `[]`.
  - "switches to election mode only before anything is imported": `setMode` election → snapshot `mode === "election"`. In a `seededRoom(2)`, `setMode` → error `wrong_phase`.
  - "adds positions in order with candidate ids": `electionRoom()` → host `positions.map(p => p.title)` equals `["President","Social Chair"]`, the `seatsOpen` values equal `[1,2]`, and `hostOnly.positionDetails[id].candidates` has 3 entries for President.
  - "rejects a position with seats >= candidates, duplicate names, or over-long titles": each gets error `bad_message`.
  - "edits, reorders and removes pending positions": after `movePosition` (Social Chair, −1) the order is flipped, `updatePosition` changes the title, and `removePosition` leaves one position.
  - "hides pending positions from brothers and the projector": brother snapshot `positions` equals `[]`.
  - "refuses position messages from brothers": error `forbidden`.
- [ ] **Step 2: Run** `bun run test test/elections.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the protocol types, migration 7, validation, `refusal.ts`, the setup functions in `positions.ts`, and the `room.ts` dispatch cases. Add the new snapshot fields: recruitment rooms send `positions: []`, `focusPositionId: null`, `positionProgress: null`, `myPicks: {}`, `slate: null`, and `positionDetails: {}`. Update `snapshot()` in `test/roomState.test.ts` with the new default fields so it typechecks.
- [ ] **Step 4: Run** `bun run test` (whole suite). Expected: all pass, existing tests included.
- [ ] **Step 5: Commit** `feat: add election mode and position setup`

---

### Task 3: Rounds: open, pick, close

**Files:**
- Modify: `src/worker/positions.ts`, `src/worker/room.ts`
- Test: `test/elections.test.ts`

**Interfaces:**
- Consumes: `countRound`, `majority` (Task 1). Positions types and `electionRoom()` (Task 2).
- Produces in `positions.ts`: `openRound(sql, id)`, `pick(sql, memberId, positionId, candidateIds): string[]` (returns the stored picks), `closeRound(sql, id): void`, `positionProgress(sql, id, total): PositionProgress`, `liveTally(sql, id): RoundTally`, `myPicks(sql, memberId): Record<string, string[]>`.

Rules:
- `openRound`: the position is `pending` or `runoff`, and no other position is `voting`
  (otherwise `wrong_phase`). The room phase isn't `ended`. Sets status `voting`, `round += 1`,
  `room.focus_position_id`, and room phase `live`. Clears `focus_pnm_id`.
- `pick`: the room is in election mode, the phase isn't `ended` (otherwise `session_ended`),
  and the position is `voting` (otherwise `not_voting`). Ids must be distinct, all on the
  ballot, and at most `seats_open` of them (otherwise `bad_ballot`). An empty array clears. It
  replaces the member's picks for that position in one transaction. The member's sockets get
  `myPicks`. Hosts get `positionTally`. Progress is queued through the existing
  `queueRoomUpdate` path, extended to send `positionProgress` when `focus_position_id` is set.
- `closeRound`: the position is `voting` (otherwise `not_voting`). Builds a `RoundTally` from
  the picks, appends it to `past_rounds`, and runs `countRound`. Then it marks `elected`,
  sets `on_ballot = 0` for everyone not in `nextBallot` (or for everyone, once decided),
  reduces `seats_open`, and sets status `decided` or `runoff`. Finally it deletes the
  position's picks. Uses `transactionSync`, then `broadcastSnapshots()`.
- `winners` in a non-host `Position` stays `null` until `revealed`, even when a candidate
  already has `elected = 1`.

- [ ] **Step 1: Write failing tests**, `describe("election rounds")`:
  - "opens a position to brothers with its ballot": after `openRound(President)`, the brother snapshot position has status `voting`, `ballot.length === 3`, and `winners === null`.
  - "refuses opening a second position while one is voting": error `wrong_phase`.
  - "stores picks, echoes them to the voter and tallies only to the host": brother picks `[A]`, then gets `myPicks` with `[A]`. Host gets `positionTally` with `picks[A] === 1` and `ballots === 1`. The brother has no `positionTally` (check with `has`).
  - "refuses too many picks, duplicates, or off-ballot candidates": each → `bad_ballot`.
  - "refuses picks after the round closes": close, then pick → `not_voting`.
  - "restores picks on rejoin": the same `memberId` reconnects, and `snapshot.myPicks[positionId]` equals `[A]`.
  - "elects a majority winner but hides them until reveal": 3 brothers pick A, A, B. After close, the host position has status `decided` and winners `[A]`. The brother and projector positions have `winners === null`.
  - "runs a runoff that drops last place": 5 brothers on President pick A, A, B, B, C. Majority is 3 and nobody reaches it. C is dropped. The host position then has status `runoff`, the ballot is A and B, `round === 1`, and `positionDetails[id].rounds.length === 1`. Then `openRound` gives `round === 2`, and `live.ballots === 0`.
  - "leader wins when the tied last-place candidates drop": 4 brothers pick A, A, B, C. B and C drop, so A is elected and the status is `decided`.
  - "hides a partial winner in a 2-seat runoff": Social Chair with 6 brothers. Picks: [A,B], [A,C], [A,B], [A,D], [A,C], [A,D]. A=6, and B, C and D have 2 each, so all three tie for last. Dropping them all would leave nobody else, so A is elected and B, C, D are revoted. After close, the brother and projector snapshots show `seatsOpen === 1` and `winners === null`, and no snapshot or patch sent to a brother contains A's name. Test this by `JSON.stringify` over `brother.received`, looking for A's name once the round has closed.
  - "counts a kicked member's ballot": a brother picks, the host kicks them, and the host's live tally still has `ballots === 1`.
- [ ] **Step 2: Run** `bun run test test/elections.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the functions and dispatch. Picks go through the same `self.memberId === null → forbidden` check as votes.
- [ ] **Step 4: Run** `bun run test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: run election rounds with majority and runoffs`

---

### Task 4: Reveal, end, slate, mode guards

**Files:**
- Modify: `src/worker/positions.ts`, `src/worker/room.ts`
- Test: `test/elections.test.ts`

**Interfaces:**
- Produces: `revealWinners(sql, id)`, `slate(sql): SlateEntry[]` (decided positions only, in ordinal order, winner names in candidate ordinal order).

Rules:
- `revealWinners`: the position is `decided` (otherwise `wrong_phase`). Sets `revealed = 1`, then `broadcastSnapshots()`.
- `endSession` in election mode: phase becomes `ended`. Any `voting` position stays
  `voting`, and its picks are kept but frozen, since picks are refused once ended. Send
  `broadcastSnapshots()` instead of the recruitment `ended` message. The recruitment path is
  unchanged.
- `revealSlate`: needs election mode and phase `ended` (otherwise `wrong_phase`). Sets
  `class_revealed = 1`. `snapshot.slate` is `slate(sql)` for host and projector once
  `class_revealed` is set, and always `null` for brothers.
- Mode guards: in `dispatch`, PNM-only messages (`importPnms`, `vote`, `setBudget`, `setFocus`,
  `reveal`, `startRevote`, `revealClass`) need recruitment mode. Election-only messages
  (`addPosition` through `revealSlate`) need election mode. Otherwise the message is refused
  with `wrong_mode`. Shared messages: `setJoinLocked`, `kick`, `endSession`, `setMode`.

- [ ] **Step 1: Write failing tests**, `describe("election reveal and end")`:
  - "reveals winners to the projector and brothers only on request": after `revealWinners`, the projector position has `winners` with A's name and `revealed === true`.
  - "refuses revealing an undecided position": error `wrong_phase`.
  - "ends voting with an undecided position left as is": end mid-round, and the host snapshot position status is still `voting`. A brother pick then gets `session_ended`.
  - "shows the slate to host and projector only, decided positions only": the projector `slate` equals `[{ positionId, title: "President", winners: [A name] }]`, and the brother `slate === null`.
  - "refuses PNM messages in an election room and position messages in a recruitment room": `importPnms` in `electionRoom()` → `wrong_mode`. `addPosition` in `seededRoom(1)` → `wrong_mode`.
- [ ] **Step 2: Run** `bun run test test/elections.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: reveal election winners and the officer slate`

---

### Task 5: Client room state for picks

**Files:**
- Modify: `src/client/roomState.ts`, `src/client/useRoom.ts`
- Test: `test/roomState.test.ts`

**Interfaces:**
- Consumes: `myPicks`, `positionTally` and `positionProgress` messages (Task 2/3).
- Produces: `RoomState.pendingPicks: Record<string, string[]>`, the action `{ kind: "picksTapped"; positionId: string; candidateIds: string[] }`, and from `useRoom`: `pick(positionId: string, candidateIds: string[]): void`.

Rules, mirroring `pendingVotes`:
- `picksTapped` sets `pendingPicks[positionId]`.
- `myPicks` updates `room.myPicks`. When it matches the pending picks (same ids, any order),
  that pending entry is removed. An empty array removes the key from `room.myPicks`.
- `positionTally` updates `hostOnly.positionDetails[positionId].live`, but only when
  `hostOnly` is set.
- `positionProgress` updates `room.positionProgress`, but only when `positionId` equals
  `focusPositionId`.
- `not_voting` and `bad_ballot` errors clear `pendingPicks`, and so does `session_ended`
  (which already clears votes).
- `useRoom` resends every entry in `pendingPicks` after each snapshot, alongside the existing
  vote resend.

- [ ] **Step 1: Write failing tests** in `test/roomState.test.ts`:
  - "confirms pending picks when the server echoes them in any order".
  - "drops pending picks when the server says the round is closed": after an `error` with code `not_voting`, `pendingPicks` equals `{}`.
  - "ignores position progress for a position not on screen".
  - "applies position tallies only for hosts".
- [ ] **Step 2: Run** `bun run test test/roomState.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: track election picks in client room state`

---

### Task 6: Host screen for elections

**Files:**
- Create: `src/client/components/ModePicker.tsx`, `src/client/components/PositionsEditor.tsx`, `src/client/components/ElectionPanel.tsx`, `src/client/screens/ElectionResults.tsx`
- Modify: `src/client/screens/Host.tsx`

**Interfaces:**
- Consumes: the snapshot fields and client messages from Task 2–4, plus `toCsv` from `src/shared/csv.ts`.

Behavior:
- `Setup` in `Host.tsx` shows `ModePicker` (two segmented buttons, Recruitment and Elections)
  while `room.pnms.length === 0 && room.positions.length === 0`. In election mode it shows
  `PositionsEditor` in place of `ImportPanel`, and its summary panel reads "{n} positions
  ready" with a "Start voting on {first title}" button that sends `openRound`.
- `PositionsEditor`: a form with title, seats (number input, min 1) and candidates (a textarea
  with one name per line). It validates on the client with the same rules as `validate.ts` and
  shows errors inline. Below it, a list of positions with Edit, Remove, and up/down buttons for
  pending positions.
- `ElectionPanel` takes the place of `LiveList` when `mode === "election"`. It shows the
  focused position's title, round and seats open, the "Waiting on X of Y" progress, and each
  ballot candidate with live picks and percent of ballots. It also has buttons:
  - Close round, while voting.
  - Open runoff, when the status is `runoff`.
  - Reveal winners, when decided and not yet revealed.
  - Open {next pending position}.
  
  Under that is a list of every position with its status (Pending, Voting, Runoff, Decided,
  Revealed).
- `RoomHeader` status text in election mode: "Voting on {title}, round {n}" or "Setting up".
- In election mode, `Host` renders `ElectionResults` when the phase is `ended`. It lists every
  position with each round's picks and percent, and the winners, or "Undecided" for a position
  that isn't decided. It has a "Reveal slate on projector" button that sends `revealSlate` and
  is disabled once the slate is revealed, and a CSV download with the columns `Position`,
  `Round`, `Candidate`, `Picks`, `Ballots`, `Percent`, `Result`. `Result` is `Elected`,
  `Dropped`, `Runoff`, or `Undecided`.
- Copy: no "PNM" wording anywhere in election mode.

- [ ] **Step 1: Implement** the components and the `Host.tsx` branching.
- [ ] **Step 2: Run** `bun run typecheck && bun run lint && bun run format:check`. Expected: clean.
- [ ] **Step 3: Verify in the app.** Run `bun run preview`, open a room, choose Elections, add
  President (1 seat: A, B, C) and Social Chair (2 seats: D, E, F, G), reorder them, open
  President, and check that the live counts move when you vote from a second tab
  (`/r/{code}`).
- [ ] **Step 4: Commit** `feat: add host controls for elections`

---

### Task 7: Brother ballot for positions

**Files:**
- Create: `src/client/components/PositionBallot.tsx`
- Modify: `src/client/screens/Brother.tsx`

Behavior:
- In election mode, `Brother` renders `PositionBallot` for the focused position while its
  status is `voting`. Otherwise it shows `CenteredMessage` with "Waiting for the next vote".
- The lobby copy in election mode is "Voting starts when the host opens the first position."
- `PositionBallot` shows the title and "Pick 1" or "Pick up to {seatsOpen}", then the
  candidates as large toggle rows. Selecting a candidate past `seatsOpen` does nothing; a
  1-seat position swaps the selection instead. A Cast button calls `pick(positionId, ids)`, and
  a Clear link sends `[]`. Once the ballot is cast, it shows "Your ballot is in" with the
  chosen names. Editing reopens the selection. Pending picks show as cast, the same way
  pending votes do now.
- Reuse the 700 ms change guard (`PNM_CHANGE_GUARD_MS`) when the focused position or round
  changes. Reusing the flick-to-cast gesture from `VoteButtons` is optional. Reduced motion
  must leave a single tap on Cast.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `bun run typecheck && bun run lint && bun run format:check`. Expected: clean.
- [ ] **Step 3: Verify in the app** at phone width (390 px): cast, change, clear, and a refused
  pick after the host closes the round shows the notice.
- [ ] **Step 4: Commit** `feat: add position ballot for brothers`

---

### Task 8: Projector for elections

**Files:**
- Create: `src/client/screens/ProjectorElection.tsx`
- Modify: `src/client/screens/Projector.tsx` (export `Stage`, `Lobby`, and branch on `room.mode`)

Behavior:
- **Lobby:** the existing `Lobby`.
- **Voting:** position title, "Pick up to N", and gold marbles in `MarblePit` counting
  `positionProgress.voted` out of `total`. No candidate names.
- **Runoff, decided but not revealed, or between positions:** in runoff, "No majority. Revote
  coming." Otherwise "Voting closed". Nothing names the dropped or elected.
- **Revealed:** the title and the winner names, large, with `sound.bell()` once, and only when
  this screen saw the reveal happen. A reveal found on load shows without the bell, the same
  idea as `watchReveal`.
- **Slate:** once `room.slate` is set, every entry as title and winner names in a column or
  grid, entering one at a time. Names only, no photos.
- **Ended without slate:** "Voting is closed".

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `bun run typecheck && bun run lint && bun run format:check`. Expected: clean.
- [ ] **Step 3: Verify in the app**: run a full night of President plus a Social Chair runoff
  using `bun run preview` and the simulator (Task 9), with the projector open. Check that no
  name appears on the projector before Reveal winners.
- [ ] **Step 4: Commit** `feat: show elections on the projector`

---

### Task 9: Simulator and docs

**Files:**
- Modify: `scripts/simulate.mjs`, `README.md`

- [ ] **Step 1: Simulator.** When `snapshot.mode === "election"` and the focused position is
  `voting` (on a snapshot, or after any snapshot that changes the focus or round), each bot
  waits a random delay. It then sends `pick` with 1..`seatsOpen` random distinct ballot ids
  (no pick 10% of the time), and counts it in `stats.votes`. The recruitment behavior stays
  as it is.
- [ ] **Step 2: README.** In "Running a voting night", add an "Elections" subsection. It
  covers: choose Elections before adding anything; add each position with seats and
  candidates; open a position, close the round, open a runoff if needed, and reveal winners;
  end voting; reveal the slate. It also states the majority rule and runoff rule in one
  sentence each, and adds the 50-position and 50-candidate limits to "Limits and data".
  Update the intro line so Ballot reads as also running officer elections.
- [ ] **Step 3: Run** `bun run test && bun run typecheck && bun run lint && bun run format:check`. Expected: clean.
- [ ] **Step 4: Commit** `docs: document elections mode` (with the simulator change in the same commit, or a separate `chore: simulate election rooms`).
