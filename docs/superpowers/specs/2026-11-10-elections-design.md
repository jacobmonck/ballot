# Elections mode

## Intent

Ballot today runs a recruitment night: each PNM gets a secret Yes/No, and the top PNMs by
percentage make the class. The chapter also elects officers (president, VP, treasurer...) and
wants to run those nights on Ballot too.

An elections night has several positions. Each position has a known list of candidates and a
seat count (president takes 1, a committee might take 2). Positions run one after another in the
same room, so the host never has to start a new room per position.

There is no spreadsheet or form for elections. Candidates are just names, typed in by the host
before the night starts.

## Goals

- A room is either a **recruitment** room (today's behavior, unchanged) or an **elections** room.
  Never both.
- The host sets up every position up front: title, number of seats, candidate names.
- One room runs every position in sequence.
- Brothers pick one candidate for a 1-seat position, up to N candidates for an N-seat position.
- A winner needs 50% + 1 of ballots cast.
- When seats are left unfilled, the last-place candidate is dropped and the room revotes, until
  every seat is filled.
- The projector announces only the winner(s) of each position. Percentages stay with the host.

## Non-goals

- Mixing PNMs and positions in one room.
- Nominations from the floor or adding candidates mid-night.
- Candidate photos, bios, or form answers.
- Ranked-choice, approval, or any other voting system.
- Importing candidates from a CSV.

## Anti-goals (would make this a failure even if it works)

- Leaking live tallies or rankings to phones or the projector. The same secrecy rules as
  recruitment apply: phones learn only their own picks, the projector learns only that a ballot
  landed until the host reveals, and only the host sees counts.
- Changing how a recruitment night works or looks.
- Making the host create a room per position.

## Decided behavior

### Room mode

The host picks **Recruitment** or **Elections** on the setup screen, before anything is
imported or entered. The choice locks once voting starts. Recruitment keeps the existing CSV
import, class size, Yes budget, pegboard reveal and class reveal untouched.

### Setup (elections)

In place of the CSV import panel, the host sees a positions editor:

- Add a position: title, seats (1 or more), candidate names.
- Reorder positions. Order is the order they run.
- Edit or remove a position until it has been opened for voting.
- A position needs more candidates than seats. *(My call: a position with candidates equal to or
  fewer than its seats is rejected at setup, since nothing would be left to vote on.)*

This sits where the import panel sits now, so it is part of the same setup step, not a separate
flow.

### Voting on a position

1. Host opens a position. It goes on the projector and every phone.
2. Phones show the position title, the number of seats, and the candidate list. A brother selects
   up to `seatsOpen` candidates and casts. They can change or clear their ballot while voting is
   open, as with PNM votes today. Selecting fewer than `seatsOpen`, or none, is allowed.
3. The projector shows the position title and ballots landing (gold marbles, no hint of who).
4. The host sees live per-candidate counts and percentages, and how many brothers have voted.
5. Host closes the round. The server decides the outcome (below).

### Counting a round

- **Ballots cast** = brothers who picked at least one candidate this round. Brothers who picked
  nobody are not counted. Kicked members' ballots still count, matching recruitment.
- A candidate's **percent** = their picks / ballots cast.
- A candidate **clears majority** when picks >= floor(ballots cast / 2) + 1.
- Candidates who clear majority are elected, highest picks first, up to `seatsOpen`.
- If more candidates clear majority than seats are open and they tie at the last open seat,
  nobody in that tie is elected this round. Everyone above the tie is elected; only the tied
  candidates go on the revote ballot for the remaining seat(s), with nobody dropped. *(My call.)*
- If seats remain open after that, it's a **runoff**:
  - Anyone already elected stays elected and leaves the ballot.
  - The last-place candidate (fewest picks) is dropped. If several tie for last, all of them are
    dropped.
  - If the drop leaves as many candidates as open seats, or fewer, everyone left is elected
    and the position is decided. Example: 2 open seats, 3 candidates, the last-place one is
    dropped, and the other 2 win. Example: 1 open seat, two tied for last behind the leader. Both
    are dropped and the leader wins.
  - If everyone left is tied, so dropping all of last place would leave nobody, the round is
    revoted with nobody dropped. *(My call.)*
  - Votes for the position are cleared and a new round opens with the remaining candidates and
    `seatsOpen` reduced by the seats just filled.
- Each round's counts are kept so the host can see the history.

### Reveal

After a round that fills every seat, the host chooses **Reveal winner(s)**. The projector shows
the position title and the winner name(s) only. No percentages, no losing candidates' counts.

Winners stay hidden until the whole position is decided. On a multi-seat position, someone who
clears majority in an early round is not announced then. They're revealed together with the
other winners once every seat is filled.

After a runoff round, the projector shows only that no majority was reached and a revote is
coming. It does not name who was elected or dropped, and it shows no counts. *(My call.)*
The runoff ballot on phones has to leave out elected and dropped candidates, so a sharp-eyed
brother can work out that someone left the ballot. That can't be avoided. The projector should
not make it any more obvious, for example by listing the remaining candidates. *(My call.)*

### Moving on and ending

The host opens each round explicitly: closing a round never opens the next one on its own. *(My
call.)*

The host can open any position that hasn't run yet, in any order; the setup order is the default
"next". Positions can be added, edited or removed until they're opened. *(My call.)*

The host can end voting at any time. A position that never opened or is mid-runoff shows as
**Undecided** in the host results and CSV, and is left off the projector slate. *(My call.)*

The host opens the next position from the same room. When every position is done, the host ends
voting. The projector can then show the **full slate**: every position with its winner(s), in
position order, like the class reveal does now. The host's results screen lists every position,
each round's counts and percentages, and a CSV download.

## Constraints

- Lives inside the existing architecture: one Durable Object per room, SQLite storage with
  forward-only migrations in `src/worker/schema.ts` (never edit a released step), all client
  messages validated in `src/worker/validate.ts`, role-scoped broadcasts in `room.ts`
  (`sendToHosts` is the only path for live tallies).
- Protocol types stay in `src/shared/protocol.ts`, shared by both sides.
- Existing recruitment rooms, already stored in SQLite, keep working after the migration and
  default to recruitment mode.
- Existing tests keep passing. Before landing: `bun run test`, `typecheck`, `lint`,
  `format:check`.
- Room limits stay as documented (1,000 brothers). *(My call: up to 50 positions, up to 50
  candidates per position, candidate name and position title capped like PNM names at 80
  characters.)*
- README "Running a voting night" gets an elections section.

## Left to the builder

- Table design (e.g. `position`, `candidate`, `election_vote` tables vs reusing `pnm`), and how
  round history is stored.
- Exact message names and snapshot shape for elections, as long as secrecy rules hold.
- Phone ballot interaction: how picks are made and cast. Reusing the flick-to-cast gesture is
  welcome but not required; reduced motion must keep a simple one-tap path.
- Projector visuals for the winner announcement and slate. The pegboard drop is a Yes/No
  device and doesn't need to be forced onto elections.
- Host screen layout for the positions editor and live counts.
- Whether the mode is chosen at room creation or as the first step of setup, as long as it's
  chosen before anything is entered and locks once voting starts.
- Simulator (`scripts/simulate.mjs`) support for elections rooms.
