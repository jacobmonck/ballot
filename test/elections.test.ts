import { describe, expect, it } from "vitest";
import {
  connect,
  createRoom,
  electionRoom,
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
