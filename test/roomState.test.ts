import { describe, expect, it } from "vitest";
import { initialState, reducer, type RoomState } from "../src/client/roomState";
import type { Pnm, ServerMessage, Snapshot } from "../src/shared/protocol";

const pnm = (id: string, ordinal: number): Pnm => ({
  id,
  ordinal,
  name: `PNM ${ordinal}`,
  photoUrl: null,
  answers: [],
});

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    type: "snapshot",
    role: "brother",
    code: "ABCDEF",
    phase: "live",
    mode: "recruitment",
    yesBudget: 2,
    budgetIsDefault: false,
    pnmCount: 3,
    joinLocked: false,
    focusPnmId: "a",
    pnms: [pnm("a", 1)],
    members: [],
    progress: { pnmId: "a", voted: 0, total: 4 },
    revealed: null,
    revote: null,
    classReveal: null,
    myVotes: {},
    yesUsed: 0,
    positions: [],
    focusPositionId: null,
    positionProgress: null,
    myPicks: {},
    slate: null,
    ...overrides,
  };
}

const server = (state: RoomState, message: ServerMessage) => reducer(state, { kind: "server", message });
const joined = (overrides?: Partial<Snapshot>) => server(initialState, snapshot(overrides));

describe("room state", () => {
  it("opens the connection and counts snapshots", () => {
    const state = joined();
    expect(state.connection).toBe("open");
    expect(state.snapshotCount).toBe(1);
    expect(server(state, snapshot()).snapshotCount).toBe(2);
  });

  it("stays refused once refused, whatever the socket does next", () => {
    const refused = reducer(joined(), { kind: "refused", message: "You were removed from this room." });
    const after = reducer(refused, { kind: "connection", connection: "reconnecting" });
    expect(after.connection).toBe("refused");
    expect(after.refusal).toBe("You were removed from this room.");
  });

  it("keeps a tapped vote pending until the server confirms that same value", () => {
    let state = reducer(joined(), { kind: "voteTapped", pnmId: "a", value: "yes" });
    expect(state.pendingVotes).toEqual({ a: "yes" });

    // A confirmation of an older tap must not clear the newer one.
    state = reducer(state, { kind: "voteTapped", pnmId: "a", value: "no" });
    state = server(state, { type: "myVote", pnmId: "a", value: "yes", yesUsed: 1 });
    expect(state.pendingVotes).toEqual({ a: "no" });

    state = server(state, { type: "myVote", pnmId: "a", value: "no", yesUsed: 0 });
    expect(state.pendingVotes).toEqual({});
    expect(state.room?.myVotes).toEqual({ a: "no" });
    expect(state.room?.yesUsed).toBe(0);
  });

  it("drops pending votes when the server rejects a vote, but not on other errors", () => {
    const pending = reducer(joined(), { kind: "voteTapped", pnmId: "a", value: "yes" });
    const limited = server(pending, { type: "error", code: "rate_limited", message: "Too many requests." });
    expect(limited.pendingVotes).toEqual({ a: "yes" });
    expect(limited.notice).toEqual({ id: 1, message: "Too many requests." });

    const rejected = server(limited, { type: "error", code: "budget_exhausted", message: "No Yes votes left." });
    expect(rejected.pendingVotes).toEqual({});
    expect(rejected.notice?.id).toBe(2);
  });

  it("removes a cleared vote", () => {
    const state = server(joined({ myVotes: { a: "yes" }, yesUsed: 1 }), {
      type: "myVote",
      pnmId: "a",
      value: null,
      yesUsed: 0,
    });
    expect(state.room?.myVotes).toEqual({});
  });

  it("adds a newly focused PNM in interview order and clears the last reveal", () => {
    const state = server(joined({ pnms: [pnm("a", 1), pnm("c", 3)], revealed: { pnmId: "a", yes: 1, no: 0 } }), {
      type: "focus",
      pnm: pnm("b", 2),
      progress: { pnmId: "b", voted: 0, total: 4 },
    });
    expect(state.room?.pnms.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(state.room?.focusPnmId).toBe("b");
    expect(state.room?.revealed).toBeNull();
  });

  it("ignores progress for a PNM that is no longer on screen", () => {
    const state = server(joined(), { type: "progress", pnmId: "old", voted: 3, total: 4 });
    expect(state.room?.progress).toEqual({ pnmId: "a", voted: 0, total: 4 });
  });

  it("applies live tallies only on a host screen", () => {
    const tally: ServerMessage = { type: "tally", pnmId: "a", yes: 2, no: 1 };
    expect(server(joined(), tally).room?.hostOnly).toBeUndefined();

    const hostOnly = { hostKey: "h", projectorKey: "p", tallies: {}, results: null, positionDetails: {} };
    const host = server(joined({ role: "host", hostOnly }), tally);
    expect(host.room?.hostOnly?.tallies).toEqual({ a: { yes: 2, no: 1 } });
  });

  it("ignores room updates that arrive before the first snapshot", () => {
    expect(server(initialState, { type: "joinLock", locked: true })).toBe(initialState);
  });
});
