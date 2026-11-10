import type {
  Candidate,
  Position,
  PositionDetail,
  PositionInput,
  PositionStatus,
  RoomMode,
  Role,
  RoundTally,
} from "../shared/protocol";
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
        ballot: row.status === "voting" ? mine.filter(({ on_ballot }) => on_ballot === 1).map(toCandidate) : [],
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
function liveTally(sql: SqlStorage, positionId: string): RoundTally {
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
