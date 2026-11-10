import type {
  Candidate,
  Position,
  PositionDetail,
  PositionProgress,
  PositionInput,
  PositionStatus,
  RoomMode,
  Role,
  RoundTally,
  SlateEntry,
} from "../shared/protocol";
import { countRound } from "../shared/election";
import { Refusal } from "./refusal";

const MAX_POSITIONS = 50;

type PositionRow = {
  id: string;
  ordinal: number;
  title: string;
  seats: number;
  seats_open: number;
  status: PositionStatus;
  round: number;
  revealed: number;
  past_rounds: string;
};

type CandidateRow = {
  id: string;
  position_id: string;
  name: string;
  on_ballot: number;
  elected: number;
};

// Candidates are only ever listed in the order the host typed them.
function toCandidate({ id, name }: CandidateRow): Candidate {
  return { id, name };
}

function positionRows(sql: SqlStorage): PositionRow[] {
  return sql.exec<PositionRow>("SELECT * FROM position ORDER BY ordinal").toArray();
}

function candidateRows(sql: SqlStorage): CandidateRow[] {
  return sql.exec<CandidateRow>("SELECT * FROM candidate ORDER BY position_id, ordinal").toArray();
}

// A pending position is the only kind the host can still change.
function pendingPosition(sql: SqlStorage, id: string): PositionRow {
  const row = sql.exec<PositionRow>("SELECT * FROM position WHERE id = ?", id).toArray()[0];
  if (!row) throw new Refusal("not_found", "No such position.");
  if (row.status !== "pending") throw new Refusal("wrong_phase", "That position has already been opened.");
  return row;
}

// Positions are built in an election room before it ends, and nowhere else.
function requireEditable(sql: SqlStorage) {
  const { mode, phase } = sql.exec<{ mode: RoomMode; phase: string }>("SELECT mode, phase FROM room").one();
  if (mode !== "election") throw new Refusal("wrong_mode", "This room is not in election mode.");
  if (phase === "ended") throw new Refusal("session_ended", "Voting has ended.");
}

function insertCandidates(sql: SqlStorage, positionId: string, names: string[]) {
  names.forEach((name, index) => {
    sql.exec(
      "INSERT INTO candidate (id, position_id, ordinal, name) VALUES (?, ?, ?, ?)",
      crypto.randomUUID(),
      positionId,
      index + 1,
      name,
    );
  });
}

// Switches what the room is for. Only possible while the room is still empty.
export function setMode(sql: SqlStorage, mode: RoomMode) {
  const { phase } = sql.exec<{ phase: string }>("SELECT phase FROM room").one();
  const pnms = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pnm").one().count;
  const positions = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM position").one().count;
  if (phase !== "setup" || pnms > 0 || positions > 0) {
    throw new Refusal("wrong_phase", "The mode can only change before anything is imported.");
  }

  sql.exec("UPDATE room SET mode = ?", mode);
}

export function addPosition(sql: SqlStorage, input: PositionInput) {
  requireEditable(sql);

  const { count } = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM position").one();
  if (count >= MAX_POSITIONS) throw new Refusal("bad_message", `A room holds at most ${MAX_POSITIONS} positions.`);

  const id = crypto.randomUUID();
  sql.exec(
    "INSERT INTO position (id, ordinal, title, seats, seats_open) VALUES (?, ?, ?, ?, ?)",
    id,
    count + 1,
    input.title,
    input.seats,
    input.seats,
  );
  insertCandidates(sql, id, input.candidates);
}

// Replaces the title, seats and candidates. Candidates get new ids, which is safe while nobody has voted.
export function updatePosition(sql: SqlStorage, id: string, input: PositionInput) {
  requireEditable(sql);
  pendingPosition(sql, id);

  sql.exec(
    "UPDATE position SET title = ?, seats = ?, seats_open = ? WHERE id = ?",
    input.title,
    input.seats,
    input.seats,
    id,
  );
  sql.exec("DELETE FROM candidate WHERE position_id = ?", id);
  insertCandidates(sql, id, input.candidates);
}

// Deletes the position and closes the gap in the running order.
export function removePosition(sql: SqlStorage, id: string) {
  requireEditable(sql);
  const { ordinal } = pendingPosition(sql, id);

  sql.exec("DELETE FROM candidate WHERE position_id = ?", id);
  sql.exec("DELETE FROM position WHERE id = ?", id);
  sql.exec("UPDATE position SET ordinal = ordinal - 1 WHERE ordinal > ?", ordinal);
}

// Swaps a position with its neighbour. Moving past either end changes nothing.
export function movePosition(sql: SqlStorage, id: string, direction: -1 | 1) {
  requireEditable(sql);
  const { ordinal } = pendingPosition(sql, id);

  const other = sql.exec<{ id: string }>("SELECT id FROM position WHERE ordinal = ?", ordinal + direction).toArray()[0];
  if (!other) return;

  sql.exec("UPDATE position SET ordinal = ? WHERE id = ?", ordinal + direction, id);
  sql.exec("UPDATE position SET ordinal = ? WHERE id = ?", ordinal, other.id);
}

// Positions as one role may see them. Others only get positions the host has opened, and only their winners once revealed.
export function positionsFor(sql: SqlStorage, role: Role): Position[] {
  const isHost = role === "host";
  const candidates = candidateRows(sql);

  return positionRows(sql)
    .filter(({ status }) => isHost || status !== "pending")
    .map((row) => {
      const mine = candidates.filter(({ position_id }) => position_id === row.id);
      const elected = mine.filter((candidate) => candidate.elected === 1).map(toCandidate);

      return {
        id: row.id,
        ordinal: row.ordinal,
        title: row.title,
        seats: row.seats,
        seatsOpen: row.seats_open,
        status: row.status,
        round: row.round,
        // The host always sees who is on the ballot, including a runoff not yet opened. Everyone else only while voting.
        ballot:
          isHost || row.status === "voting" ? mine.filter(({ on_ballot }) => on_ballot === 1).map(toCandidate) : [],
        winners: isHost || row.revealed ? elected : null,
        revealed: row.revealed === 1,
      };
    });
}

// Everything only the host sees: every candidate, each closed round's counts, and the round in progress.
export function positionDetails(sql: SqlStorage): Record<string, PositionDetail> {
  const candidates = candidateRows(sql);
  const details: Record<string, PositionDetail> = {};

  for (const row of positionRows(sql)) {
    details[row.id] = {
      candidates: candidates.filter(({ position_id }) => position_id === row.id).map(toCandidate),
      rounds: JSON.parse(row.past_rounds) as RoundTally[],
      live: liveTally(sql, row.id),
    };
  }
  return details;
}

// Picks so far in the round being voted on, counted per candidate. A ballot is one member with any pick.
export function liveTally(sql: SqlStorage, positionId: string): RoundTally {
  const picks: Record<string, number> = {};
  const rows = sql.exec<{ candidate_id: string; count: number }>(
    "SELECT candidate_id, COUNT(*) AS count FROM pick WHERE position_id = ? GROUP BY candidate_id",
    positionId,
  );
  for (const { candidate_id, count } of rows) picks[candidate_id] = count;

  const { ballots } = sql
    .exec<{ ballots: number }>(
      "SELECT COUNT(DISTINCT member_id) AS ballots FROM pick WHERE position_id = ?",
      positionId,
    )
    .one();
  return { ballots, picks };
}

// Opens a pending or runoff position for voting, and makes it the focus of the room.
export function openRound(sql: SqlStorage, id: string) {
  const { mode, phase } = sql.exec<{ mode: RoomMode; phase: string }>("SELECT mode, phase FROM room").one();
  if (mode !== "election") throw new Refusal("wrong_mode", "This room is not in election mode.");
  if (phase === "ended") throw new Refusal("session_ended", "Voting has ended.");

  const row = sql.exec<PositionRow>("SELECT * FROM position WHERE id = ?", id).toArray()[0];
  if (!row) throw new Refusal("not_found", "No such position.");
  if (row.status !== "pending" && row.status !== "runoff") {
    throw new Refusal("wrong_phase", "That position is not waiting for a round.");
  }
  const open = sql
    .exec<{ count: number }>("SELECT COUNT(*) AS count FROM position WHERE status = 'voting'")
    .one().count;
  if (open > 0) throw new Refusal("wrong_phase", "Close the open round first.");

  sql.exec("UPDATE position SET status = 'voting', round = round + 1 WHERE id = ?", id);
  sql.exec("UPDATE room SET focus_position_id = ?, focus_pnm_id = NULL, phase = 'live'", id);
}

// Replaces a member's picks for the position being voted on, and returns what was stored.
export function pick(
  sql: SqlStorage,
  memberId: string,
  positionId: string,
  round: number,
  candidateIds: string[],
): string[] {
  const { mode, phase } = sql.exec<{ mode: RoomMode; phase: string }>("SELECT mode, phase FROM room").one();
  if (mode !== "election") throw new Refusal("wrong_mode", "This room is not in election mode.");
  if (phase === "ended") throw new Refusal("session_ended", "Voting has ended.");

  const row = sql.exec<PositionRow>("SELECT * FROM position WHERE id = ?", positionId).toArray()[0];
  if (row?.status !== "voting") throw new Refusal("not_voting", "That position is not open for voting.");
  // A pick tapped in an earlier round must not land in this one, e.g. when replayed after a reconnect.
  if (round !== row.round) throw new Refusal("not_voting", "That round has closed.");

  const onBallot = new Set(
    sql
      .exec<{ id: string }>("SELECT id FROM candidate WHERE position_id = ? AND on_ballot = 1", positionId)
      .toArray()
      .map(({ id }) => id),
  );
  if (new Set(candidateIds).size !== candidateIds.length) throw new Refusal("bad_ballot", "Pick each candidate once.");
  if (candidateIds.some((id) => !onBallot.has(id)))
    throw new Refusal("bad_ballot", "That candidate is not on the ballot.");
  if (candidateIds.length > row.seats_open) {
    throw new Refusal("bad_ballot", `Pick at most ${row.seats_open}.`);
  }

  sql.exec("DELETE FROM pick WHERE member_id = ? AND position_id = ?", memberId, positionId);
  for (const candidateId of candidateIds) {
    sql.exec(
      "INSERT INTO pick (member_id, position_id, candidate_id, updated_at) VALUES (?, ?, ?, ?)",
      memberId,
      positionId,
      candidateId,
      Date.now(),
    );
  }
  return candidateIds;
}

// Counts the round, records it, elects or drops candidates, and clears the picks.
export function closeRound(sql: SqlStorage, id: string) {
  // Picks are frozen once the session ends, so an open round stays open.
  const { phase } = sql.exec<{ phase: string }>("SELECT phase FROM room").one();
  if (phase === "ended") throw new Refusal("session_ended", "Voting has ended.");

  const row = sql.exec<PositionRow>("SELECT * FROM position WHERE id = ?", id).toArray()[0];
  if (row?.status !== "voting") throw new Refusal("not_voting", "That position is not open for voting.");

  const tally = liveTally(sql, id);
  const onBallot = sql
    .exec<{ id: string }>("SELECT id FROM candidate WHERE position_id = ? AND on_ballot = 1 ORDER BY ordinal", id)
    .toArray();
  const outcome = countRound({
    seatsOpen: row.seats_open,
    ballots: tally.ballots,
    candidates: onBallot.map((candidate) => ({ id: candidate.id, picks: tally.picks[candidate.id] ?? 0 })),
  });

  const rounds = [...(JSON.parse(row.past_rounds) as RoundTally[]), tally];
  const next = new Set(outcome.nextBallot);
  for (const candidateId of outcome.elected) sql.exec("UPDATE candidate SET elected = 1 WHERE id = ?", candidateId);
  for (const { id: candidateId } of onBallot) {
    if (!next.has(candidateId)) sql.exec("UPDATE candidate SET on_ballot = 0 WHERE id = ?", candidateId);
  }
  sql.exec(
    "UPDATE position SET status = ?, seats_open = ?, past_rounds = ? WHERE id = ?",
    outcome.decided ? "decided" : "runoff",
    row.seats_open - outcome.elected.length,
    JSON.stringify(rounds),
    id,
  );
  sql.exec("DELETE FROM pick WHERE position_id = ?", id);
}

// Shows a decided position's winners to brothers and the projector. Still allowed after the session ends.
export function revealWinners(sql: SqlStorage, id: string) {
  const row = sql.exec<PositionRow>("SELECT * FROM position WHERE id = ?", id).toArray()[0];
  if (!row) throw new Refusal("not_found", "No such position.");
  if (row.status !== "decided") throw new Refusal("wrong_phase", "That position has not been decided.");

  sql.exec("UPDATE position SET revealed = 1 WHERE id = ?", id);
}

// The officer slate: every decided position in running order, with its winners in candidate order.
export function slate(sql: SqlStorage): SlateEntry[] {
  const candidates = candidateRows(sql);
  return positionRows(sql)
    .filter(({ status }) => status === "decided")
    .map((row) => ({
      positionId: row.id,
      title: row.title,
      winners: candidates
        .filter(({ position_id, elected }) => position_id === row.id && elected === 1)
        .map(({ name }) => name),
    }));
}

// How many ballots are in for a position, out of everyone whose ballot counts.
export function positionProgress(sql: SqlStorage, id: string, total: number): PositionProgress {
  return { positionId: id, voted: liveTally(sql, id).ballots, total };
}

// Each member's picks, by position, for restoring their ballot after a reconnect.
export function myPicks(sql: SqlStorage, memberId: string): Record<string, string[]> {
  const picks: Record<string, string[]> = {};
  const rows = sql.exec<{ position_id: string; candidate_id: string }>(
    "SELECT position_id, candidate_id FROM pick WHERE member_id = ? ORDER BY updated_at, rowid",
    memberId,
  );
  for (const { position_id, candidate_id } of rows) (picks[position_id] ??= []).push(candidate_id);
  return picks;
}
