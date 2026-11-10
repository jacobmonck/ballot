import { describe, expect, it } from "vitest";
import type { Client } from "./helpers";
import {
  connect,
  createRoom,
  electionRoom,
  fakePnms,
  fakePositions,
  joinBrother,
  joinHost,
  projectorKey,
  seededRoom,
} from "./helpers";

describe("election setup", () => {
  it("defaults existing and new rooms to recruitment", async () => {
    const { code, hostKey } = await createRoom();
    const { snapshot } = await joinHost(code, hostKey);
    expect(snapshot.mode).toBe("recruitment");
    expect(snapshot.positions).toEqual([]);
  });

  it("switches to election mode only before anything is imported", async () => {
    const { code, hostKey } = await createRoom();
    const { client } = await joinHost(code, hostKey);
    client.send({ type: "setMode", mode: "election" });
    expect((await client.next("snapshot")).mode).toBe("election");

    const { host } = await seededRoom(2);
    host.send({ type: "setMode", mode: "election" });
    expect((await host.next("error")).code).toBe("wrong_phase");
  });

  it("adds positions in order with candidate ids", async () => {
    const { code, hostKey, positions } = await electionRoom();
    expect(positions.map((position) => position.title)).toEqual(["President", "Social Chair"]);
    expect(positions.map((position) => position.seatsOpen)).toEqual([1, 2]);

    const { snapshot: rejoined } = await joinHost(code, hostKey);
    const { hostOnly } = rejoined;
    expect(hostOnly?.positionDetails[positions[0]!.id]?.candidates).toHaveLength(3);
  });

  it("rejects a position with seats >= candidates, duplicate names, or over-long titles", async () => {
    const { host } = await electionRoom();
    const [base] = fakePositions();
    const bad = [
      { ...base!, seats: 3 },
      { ...base!, candidates: ["Alex", " alex ", "Casey"] },
      { ...base!, title: "x".repeat(81) },
    ];
    for (const position of bad) {
      host.send({ type: "addPosition", position });
      expect((await host.next("error")).code).toBe("bad_message");
    }
  });

  it("edits, reorders and removes pending positions", async () => {
    const { host, positions } = await electionRoom();
    host.send({ type: "movePosition", positionId: positions[1]!.id, direction: -1 });
    let snapshot = await host.next("snapshot");
    expect(snapshot.positions.map((position) => position.title)).toEqual(["Social Chair", "President"]);
    expect(snapshot.positions.map((position) => position.ordinal)).toEqual([1, 2]);

    host.send({
      type: "updatePosition",
      positionId: positions[0]!.id,
      position: { title: "Chapter President", seats: 1, candidates: ["Alex", "Blake"] },
    });
    snapshot = await host.next("snapshot");
    expect(snapshot.positions.map((position) => position.title)).toEqual(["Social Chair", "Chapter President"]);

    host.send({ type: "removePosition", positionId: positions[1]!.id });
    snapshot = await host.next("snapshot");
    expect(snapshot.positions.map((position) => position.title)).toEqual(["Chapter President"]);
    expect(snapshot.positions[0]!.ordinal).toBe(1);
  });

  it("refuses position changes in recruitment mode", async () => {
    const { code, hostKey } = await createRoom();
    const { client } = await joinHost(code, hostKey);
    client.send({ type: "addPosition", position: fakePositions()[0]! });
    expect((await client.next("error")).code).toBe("wrong_mode");
  });

  it("hides pending positions from brothers and the projector", async () => {
    const { code } = await electionRoom();
    const { snapshot } = await joinBrother(code, "Jacob");
    expect(snapshot.positions).toEqual([]);

    const projector = await connect(code);
    projector.send({ type: "join", as: "projector", projectorKey: await projectorKey(code) });
    expect((await projector.next("snapshot")).positions).toEqual([]);
  });

  it("refuses position messages from brothers", async () => {
    const { code } = await electionRoom();
    const { client } = await joinBrother(code, "Jacob");
    client.send({ type: "addPosition", position: fakePositions()[0]! });
    expect((await client.next("error")).code).toBe("forbidden");
  });
});

// An election room with `count` brothers and a projector joined. `index` picks President (0) or Social Chair (1).
async function roundRoom(count: number, index = 0) {
  const room = await electionRoom();
  const brothers: { client: Client; memberId: string }[] = [];
  for (let i = 0; i < count; i++) brothers.push(await joinBrother(room.code, `Brother ${i}`));
  const projector = await connect(room.code);
  projector.send({ type: "join", as: "projector", projectorKey: await projectorKey(room.code) });
  await projector.next("snapshot");
  // The host's position lists its ballot, which gives the candidate ids.
  const position = room.positions[index]!;
  return { ...room, position, candidates: position.ballot, brothers, projector };
}

type Room = Awaited<ReturnType<typeof roundRoom>>;

async function open(room: Room) {
  room.host.send({ type: "openRound", positionId: room.position.id });
  await room.host.next("snapshot");
  for (const { client } of room.brothers) await client.next("snapshot");
  await room.projector.next("snapshot");
}

// Each brother submits a ballot (candidate indexes into the host's ballot list) and gets its echo.
async function cast(room: Room, ballots: number[][]) {
  for (const [i, indexes] of ballots.entries()) {
    const { client } = room.brothers[i]!;
    client.send({
      type: "pick",
      positionId: room.position.id,
      round: 1,
      candidateIds: indexes.map((index) => room.candidates[index]!.id),
    });
    await client.next("myPicks");
  }
}

async function close(room: Room) {
  room.host.send({ type: "closeRound", positionId: room.position.id });
  const snapshots = {
    host: await room.host.next("snapshot"),
    brother: await room.brothers[0]!.client.next("snapshot"),
    projector: await room.projector.next("snapshot"),
  };
  const find = (snapshot: typeof snapshots.host) => snapshot.positions.find(({ id }) => id === room.position.id)!;
  // Everything a brother was sent from the close on, for checking nothing leaked.
  const toBrothers = JSON.stringify([snapshots.brother, ...room.brothers.flatMap(({ client }) => client.received)]);
  return {
    host: find(snapshots.host),
    brother: find(snapshots.brother),
    projector: find(snapshots.projector),
    snapshots,
    toBrothers,
  };
}

describe("election rounds", () => {
  it("opens a position to brothers with its ballot", async () => {
    const room = await roundRoom(1);
    room.host.send({ type: "openRound", positionId: room.position.id });
    const { positions } = await room.brothers[0]!.client.next("snapshot");
    expect(positions).toHaveLength(1);
    expect(positions[0]!.status).toBe("voting");
    expect(positions[0]!.ballot).toHaveLength(3);
    expect(positions[0]!.winners).toBeNull();
  });

  it("refuses opening a second position while one is voting", async () => {
    const room = await roundRoom(1);
    await open(room);
    room.host.send({ type: "openRound", positionId: room.positions[1]!.id });
    expect((await room.host.next("error")).code).toBe("wrong_phase");
  });

  it("refuses opening a round once the session has ended", async () => {
    const room = await roundRoom(1);
    room.host.send({ type: "endSession" });
    await room.host.next("snapshot");
    room.host.send({ type: "openRound", positionId: room.position.id });
    expect((await room.host.next("error")).code).toBe("session_ended");
  });

  it("stores picks, echoes them to the voter and tallies only to the host", async () => {
    const room = await roundRoom(1);
    await open(room);
    const brother = room.brothers[0]!.client;
    const [alex] = room.candidates;
    brother.send({ type: "pick", positionId: room.position.id, round: 1, candidateIds: [alex!.id] });
    expect((await brother.next("myPicks")).candidateIds).toEqual([alex!.id]);

    const tally = await room.host.next("positionTally");
    expect(tally.picks[alex!.id]).toBe(1);
    expect(tally.ballots).toBe(1);
    expect(brother.has("positionTally")).toBe(false);
  });

  it("refuses too many picks, duplicates, or off-ballot candidates", async () => {
    const room = await roundRoom(1);
    await open(room);
    const brother = room.brothers[0]!.client;
    const [alex, blake] = room.candidates;
    const bad = [[alex!.id, blake!.id], [alex!.id, alex!.id], ["not-a-candidate"]];
    for (const candidateIds of bad) {
      brother.send({ type: "pick", positionId: room.position.id, round: 1, candidateIds });
      expect((await brother.next("error")).code).toBe("bad_ballot");
    }
  });

  it("refuses picks after the round closes", async () => {
    const room = await roundRoom(1);
    await open(room);
    await close(room);
    const brother = room.brothers[0]!.client;
    brother.send({ type: "pick", positionId: room.position.id, round: 1, candidateIds: [room.candidates[0]!.id] });
    expect((await brother.next("error")).code).toBe("not_voting");
  });

  it("restores picks on rejoin", async () => {
    const room = await roundRoom(1);
    await open(room);
    await cast(room, [[0]]);
    const { snapshot } = await joinBrother(room.code, "Brother 0", room.brothers[0]!.memberId);
    expect(snapshot.myPicks[room.position.id]).toEqual([room.candidates[0]!.id]);
  });

  it("elects a majority winner but hides them until reveal", async () => {
    const room = await roundRoom(3);
    await open(room);
    await cast(room, [[0], [0], [1]]);
    const result = await close(room);
    expect(result.host.status).toBe("decided");
    expect(result.host.winners).toEqual([room.candidates[0]]);
    expect(result.brother.winners).toBeNull();
    expect(result.projector.winners).toBeNull();
  });

  it("runs a runoff that drops last place", async () => {
    const room = await roundRoom(5);
    await open(room);
    await cast(room, [[0], [0], [1], [1], [2]]);
    const { host, snapshots } = await close(room);
    expect(host.status).toBe("runoff");
    expect(host.ballot.map(({ name }) => name)).toEqual(["Alex", "Blake"]);
    expect(host.round).toBe(1);
    expect(snapshots.host.hostOnly!.positionDetails[room.position.id]!.rounds).toHaveLength(1);

    room.host.send({ type: "openRound", positionId: room.position.id });
    const reopened = await room.host.next("snapshot");
    const reopenedPosition = reopened.positions.find(({ id }) => id === room.position.id)!;
    expect(reopenedPosition.round).toBe(2);
    expect(reopened.hostOnly!.positionDetails[room.position.id]!.live.ballots).toBe(0);
  });

  it("refuses a pick for an earlier round", async () => {
    const room = await roundRoom(5);
    await open(room);
    await cast(room, [[0], [0], [1], [1], [2]]);
    await close(room);
    room.host.send({ type: "openRound", positionId: room.position.id });
    await room.host.next("snapshot");
    for (const { client } of room.brothers) await client.next("snapshot");

    const brother = room.brothers[0]!.client;
    brother.send({ type: "pick", positionId: room.position.id, round: 1, candidateIds: [room.candidates[0]!.id] });
    expect((await brother.next("error")).code).toBe("not_voting");
  });

  it("leader wins when the tied last-place candidates drop", async () => {
    const room = await roundRoom(4);
    await open(room);
    await cast(room, [[0], [0], [1], [2]]);
    const { host } = await close(room);
    expect(host.status).toBe("decided");
    expect(host.winners?.map(({ name }) => name)).toEqual(["Alex"]);
  });

  it("hides a partial winner in a 2-seat runoff", async () => {
    const room = await roundRoom(6, 1);
    await open(room);
    await cast(room, [
      [0, 1],
      [0, 2],
      [0, 1],
      [0, 3],
      [0, 2],
      [0, 3],
    ]);
    const { host, brother: seen, projector, toBrothers } = await close(room);
    expect(host.status).toBe("runoff");
    expect(host.winners?.map(({ name }) => name)).toEqual(["Drew"]);
    expect(seen.seatsOpen).toBe(1);
    for (const position of [seen, projector]) expect(position.winners).toBeNull();
    expect(toBrothers).not.toContain("Drew");
  });

  it("keeps candidates and runoff seats off the projector", async () => {
    const room = await roundRoom(6, 1);
    const names = room.candidates.map(({ name }) => name);
    const sent = () => JSON.stringify(room.projector.received);
    const plain = (position: { ballot: unknown[]; seatsOpen: number; seats: number }) => {
      expect(position.ballot).toEqual([]);
      expect(position.seatsOpen).toBe(position.seats);
    };

    await open(room);
    await cast(room, [
      [0, 1],
      [0, 2],
      [0, 1],
      [0, 3],
      [0, 2],
      [0, 3],
    ]);
    const { projector } = await close(room);
    plain(projector);
    for (const name of names) expect(sent()).not.toContain(name);

    room.host.send({ type: "openRound", positionId: room.position.id });
    const runoff = (await room.projector.next("snapshot")).positions.find(({ id }) => id === room.position.id)!;
    expect(runoff.status).toBe("voting");
    plain(runoff);
    for (const name of names) expect(sent()).not.toContain(name);
  });

  it("counts a kicked member's ballot", async () => {
    const room = await roundRoom(1);
    await open(room);
    await cast(room, [[0]]);
    const { client: host, snapshot: before } = await joinHost(room.code, room.hostKey);
    const handle = before.members.find(({ name }) => name === "Brother 0")!.handle;
    host.send({ type: "kick", handle });
    await room.brothers[0]!.client.closed();

    const { snapshot } = await joinHost(room.code, room.hostKey);
    expect(snapshot.hostOnly!.positionDetails[room.position.id]!.live.ballots).toBe(1);
  });
});

describe("election reveal and end", () => {
  async function decided() {
    const room = await roundRoom(3);
    await open(room);
    await cast(room, [[0], [0], [1]]);
    await close(room);
    return room;
  }

  it("reveals winners to the projector and brothers only on request", async () => {
    const room = await decided();
    room.host.send({ type: "revealWinners", positionId: room.position.id });
    const snapshot = await room.projector.next("snapshot");
    const position = snapshot.positions.find(({ id }) => id === room.position.id)!;
    expect(position.winners?.map(({ name }) => name)).toEqual([room.candidates[0]!.name]);
    expect(position.revealed).toBe(true);
  });

  it("refuses revealing an undecided position", async () => {
    const room = await roundRoom(1);
    await open(room);
    room.host.send({ type: "revealWinners", positionId: room.position.id });
    expect((await room.host.next("error")).code).toBe("wrong_phase");
  });

  it("ends voting with an undecided position left as is", async () => {
    const room = await roundRoom(1);
    await open(room);
    room.host.send({ type: "endSession" });
    const snapshot = await room.host.next("snapshot");
    expect(snapshot.phase).toBe("ended");
    expect(snapshot.positions.find(({ id }) => id === room.position.id)!.status).toBe("voting");

    const brother = room.brothers[0]!.client;
    brother.send({ type: "pick", positionId: room.position.id, round: 1, candidateIds: [room.candidates[0]!.id] });
    expect((await brother.next("error")).code).toBe("session_ended");
  });

  it("refuses closing a round once the session has ended", async () => {
    const room = await roundRoom(1);
    await open(room);
    room.host.send({ type: "endSession" });
    await room.host.next("snapshot");
    room.host.send({ type: "closeRound", positionId: room.position.id });
    expect((await room.host.next("error")).code).toBe("session_ended");
  });

  it("shows the slate to host and projector only, decided positions only", async () => {
    const room = await decided();
    room.host.send({ type: "revealSlate" });
    expect((await room.host.next("error")).code).toBe("wrong_phase");

    room.host.send({ type: "endSession" });
    await room.host.next("snapshot");
    await room.projector.next("snapshot");
    await room.brothers[0]!.client.next("snapshot");
    room.host.send({ type: "revealSlate" });
    const host = await room.host.next("snapshot");
    const projector = await room.projector.next("snapshot");
    const brother = await room.brothers[0]!.client.next("snapshot");
    const slate = [{ positionId: room.position.id, title: "President", winners: [room.candidates[0]!.name] }];
    expect(projector.slate).toEqual(slate);
    expect(host.slate).toEqual(slate);
    expect(brother.slate).toBeNull();
  });

  it("refuses PNM messages in an election room and position messages in a recruitment room", async () => {
    const { host } = await electionRoom();
    host.send({ type: "importPnms", pnms: fakePnms(1) });
    expect((await host.next("error")).code).toBe("wrong_mode");

    const recruitment = await seededRoom(1);
    recruitment.host.send({ type: "addPosition", position: fakePositions()[0]! });
    expect((await recruitment.host.next("error")).code).toBe("wrong_mode");
  });
});
