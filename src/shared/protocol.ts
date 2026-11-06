export type VoteValue = "yes" | "no";
export type Phase = "setup" | "live" | "ended";
export type Role = "brother" | "host" | "projector";

export interface QA {
  q: string;
  a: string;
}

export interface PnmInput {
  name: string;
  photoUrl: string | null;
  answers: QA[];
}

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

export interface Progress {
  pnmId: string;
  voted: number;
  total: number;
}

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

export type ClientMessage =
  | { type: "join"; as: "brother"; memberId: string; name: string }
  | { type: "join"; as: "host"; hostKey: string }
  | { type: "join"; as: "projector"; projectorKey: string }
  | { type: "vote"; pnmId: string; value: VoteValue | null }
  | { type: "importPnms"; pnms: PnmInput[] }
  | { type: "setBudget"; yesBudget: number | null }
  | { type: "setFocus"; pnmId: string }
  | { type: "reveal"; pnmId: string }
  | { type: "kick"; handle: string }
  | { type: "endSession" }
  | { type: "startRevote" }
  | { type: "revealClass" };

export interface Snapshot {
  type: "snapshot";
  role: Role;
  code: string;
  phase: Phase;
  yesBudget: number;
  budgetIsDefault: boolean;
  pnmCount: number;
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
  hostOnly?: { hostKey: string; projectorKey: string; tallies: Record<string, Tally>; results: Results | null };
}

export type ServerMessage =
  | Snapshot
  | { type: "focus"; pnm: Pnm; progress: Progress }
  | { type: "members"; members: MemberInfo[] }
  | { type: "budget"; yesBudget: number; budgetIsDefault: boolean }
  | ({ type: "progress" } & Progress)
  | ({ type: "tally"; pnmId: string } & Tally)
  | ({ type: "revealed" } & Revealed)
  | { type: "classRevealed"; members: ClassMember[] }
  | { type: "myVote"; pnmId: string; value: VoteValue | null; yesUsed: number }
  | { type: "ended"; results?: Results }
  | { type: "error"; code: ErrorCode; message: string };

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
  | "budget_too_low";

// Close code for a removed member; clients must not auto-reconnect after it.
export const CLOSE_KICKED = 4001;

export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_PATTERN = /^[2-9A-HJKMNP-TV-Z]{6}$/;
