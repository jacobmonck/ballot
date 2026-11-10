// Messages and types shared by the Worker and the client. Both sides of the socket import this file.

export type VoteValue = "yes" | "no";
export type Phase = "setup" | "live" | "ended";
export type Role = "brother" | "host" | "projector";
// What a room is for: voting PNMs in, or electing officers.
export type RoomMode = "recruitment" | "election";
export type PositionStatus = "pending" | "voting" | "runoff" | "decided";

// One form question and a PNM's answer to it.
export interface QA {
  q: string;
  a: string;
}

// A PNM as the host imports them.
export interface PnmInput {
  name: string;
  photoUrl: string | null;
  answers: QA[];
}

// A stored PNM. `ordinal` is their place in interview order, starting at 1.
export interface Pnm extends PnmInput {
  id: string;
  ordinal: number;
}

// `handle` is public. A member's `memberId` is their rejoin secret and is never sent to anyone else.
export interface MemberInfo {
  handle: string;
  name: string;
}

export interface Tally {
  yes: number;
  no: number;
}

// A PNM's tally as of the moment the host showed it to the room.
export interface Revealed extends Tally {
  pnmId: string;
}

// How many ballots are in for the PNM on screen, out of everyone whose ballot counts.
export interface Progress {
  pnmId: string;
  voted: number;
  total: number;
}

// One PNM's line in the results.
export interface ResultRow extends Tally {
  pnmId: string;
  name: string;
  photoUrl: string | null;
  noResponse: number;
  total: number;
  // Yes as a share of votes cast, 0 to 100. Brothers who didn't vote don't count against a PNM.
  percent: number;
  // Tallies from each revote, oldest first. `yes` and `no` above are the original vote.
  revotes: Tally[];
}

// PNMs that can't all fit in the spots left, so they must be voted on again.
export interface Tie {
  pnmIds: string[];
  spots: number;
}

// Every PNM ranked by percentage. The top `cutLine` make the class.
export interface Results {
  rows: ResultRow[];
  cutLine: number;
  tie: Tie | null;
}

// Who made the class, in interview order. No tallies or rank, because this goes up on the projector.
export interface ClassMember {
  pnmId: string;
  name: string;
  photoUrl: string | null;
}

// A position as the host sets it up.
export interface PositionInput {
  title: string;
  seats: number;
  candidates: string[];
}

export interface Candidate {
  id: string;
  name: string;
}

// How a position looks to the socket receiving it.
export interface Position {
  id: string;
  // Place in the running order, starting at 1.
  ordinal: number;
  title: string;
  seats: number;
  // Seats minus those already filled.
  seatsOpen: number;
  status: PositionStatus;
  // 0 until the position is first opened.
  round: number;
  // Brothers and projectors: empty unless the position is voting.
  ballot: Candidate[];
  // Brothers and projectors: null until revealed. Hosts: everyone elected so far.
  winners: Candidate[] | null;
  revealed: boolean;
}

// Ballots in one round and how many picks each candidate got.
export interface RoundTally {
  ballots: number;
  picks: Record<string, number>;
}

// Host only.
export interface PositionDetail {
  candidates: Candidate[];
  rounds: RoundTally[];
  live: RoundTally;
}

// How many ballots are in for the position being voted on, out of everyone whose ballot counts.
export interface PositionProgress {
  positionId: string;
  voted: number;
  total: number;
}

// One position's line in the slate shown at the end.
export interface SlateEntry {
  positionId: string;
  title: string;
  winners: string[];
}

// Everything a client may send. The Worker checks each one in validate.ts before use.
export type ClientMessage =
  | { type: "join"; as: "brother"; memberId: string; name: string }
  | { type: "join"; as: "host"; hostKey: string }
  | { type: "join"; as: "projector"; projectorKey: string }
  | { type: "vote"; pnmId: string; value: VoteValue | null }
  | { type: "importPnms"; pnms: PnmInput[] }
  | { type: "setBudget"; yesBudget: number | null }
  | { type: "setFocus"; pnmId: string }
  | { type: "reveal"; pnmId: string }
  | { type: "setJoinLocked"; locked: boolean }
  | { type: "kick"; handle: string }
  | { type: "endSession" }
  | { type: "startRevote" }
  | { type: "revealClass" }
  | { type: "setMode"; mode: RoomMode }
  | { type: "addPosition"; position: PositionInput }
  | { type: "updatePosition"; positionId: string; position: PositionInput }
  | { type: "removePosition"; positionId: string }
  | { type: "movePosition"; positionId: string; direction: -1 | 1 }
  | { type: "openRound"; positionId: string }
  | { type: "pick"; positionId: string; candidateIds: string[] }
  | { type: "closeRound"; positionId: string }
  | { type: "revealWinners"; positionId: string }
  | { type: "revealSlate" };

// The whole room as one socket may see it, sent on join and whenever the room changes too much to patch.
export interface Snapshot {
  type: "snapshot";
  role: Role;
  code: string;
  phase: Phase;
  mode: RoomMode;
  yesBudget: number;
  budgetIsDefault: boolean;
  pnmCount: number;
  // New names are refused while set. Brothers already in the room can still return.
  joinLocked: boolean;
  focusPnmId: string | null;
  // Brothers and projectors only receive PNMs the host has already focused.
  pnms: Pnm[];
  members: MemberInfo[];
  progress: Progress | null;
  // Always null for brothers.
  revealed: Revealed | null;
  // Set while brothers vote again on tied PNMs. Holds no tallies, so everyone may see it.
  revote: Tie | null;
  // Set once the host shows the class to the room. Always null for brothers.
  classReveal: ClassMember[] | null;
  myVotes: Record<string, VoteValue>;
  yesUsed: number;
  // Election mode. Brothers and projectors only receive positions the host has opened.
  positions: Position[];
  focusPositionId: string | null;
  positionProgress: PositionProgress | null;
  myPicks: Record<string, string[]>;
  // Set once the host shows the slate to the room. Always null for brothers.
  slate: SlateEntry[] | null;
  hostOnly?: {
    hostKey: string;
    projectorKey: string;
    tallies: Record<string, Tally>;
    results: Results | null;
    positionDetails: Record<string, PositionDetail>;
  };
}

// Everything the room sends. A snapshot replaces client state, and the rest patch it.
export type ServerMessage =
  | Snapshot
  | { type: "focus"; pnm: Pnm; progress: Progress }
  | { type: "members"; members: MemberInfo[] }
  | { type: "joinLock"; locked: boolean }
  | { type: "pnmPhoto"; pnmId: string; photoUrl: string }
  | { type: "budget"; yesBudget: number; budgetIsDefault: boolean }
  | ({ type: "progress" } & Progress)
  | ({ type: "tally"; pnmId: string } & Tally)
  | ({ type: "revealed" } & Revealed)
  | { type: "classRevealed"; members: ClassMember[] }
  | { type: "myVote"; pnmId: string; value: VoteValue | null; yesUsed: number }
  | { type: "myPicks"; positionId: string; candidateIds: string[] }
  | ({ type: "positionTally"; positionId: string } & RoundTally)
  | ({ type: "positionProgress" } & PositionProgress)
  | { type: "ended"; results?: Results }
  | { type: "error"; code: ErrorCode; message: string };

// Why the room refused a message. Clients branch on these, so the message text is free to change.
export type ErrorCode =
  | "bad_message"
  | "not_joined"
  | "already_joined"
  | "bad_host_key"
  | "bad_projector_key"
  | "forbidden"
  | "kicked"
  | "session_ended"
  | "budget_exhausted"
  | "not_seen"
  | "not_in_revote"
  | "no_tie"
  | "tie_unresolved"
  | "not_found"
  | "wrong_phase"
  | "wrong_mode"
  | "not_voting"
  | "bad_ballot"
  | "budget_too_low"
  | "room_full"
  | "room_locked"
  | "rate_limited"
  | "server_error";

// Close code for a removed member; clients must not auto-reconnect after it.
export const CLOSE_KICKED = 4001;

export const ROOM_CODE_LENGTH = 6;

// Crockford base32 minus 0/1 and U, so a code read off a projector cannot be mistyped.
export const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
// The alphabet holds no regex metacharacters, so it can sit in a character class as is.
export const ROOM_CODE_SOURCE = `[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}`;
export const ROOM_CODE_PATTERN = new RegExp(`^${ROOM_CODE_SOURCE}$`);
