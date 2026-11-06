import { SELF, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VotingRoom } from "../src/worker/room";
import { CLOSE_KICKED } from "../src/shared/protocol";
import { connect, createRoom, fakePnms, focus, joinBrother, joinHost, membersUntil, projectorKey, seededRoom, settle } from "./helpers";

describe("rooms", () => {
  it("creates a room with a valid code and unique host key", async () => {
    const first = await createRoom();
    const second = await createRoom();
    expect(first.code).toMatch(/^[2-9A-HJKMNP-TV-Z]{6}$/);
    expect(first.code).not.toBe(second.code);
    expect(first.hostKey).not.toBe(second.hostKey);
  });

  it("returns 404 for a room that was never created", async () => {
    const response = await SELF.fetch("https://voting.test/api/rooms/ZZZZZZ/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(404);
  });

  it("reports whether a room exists so the join screen can say so", async () => {
    const { code } = await createRoom();
    expect((await SELF.fetch(`https://voting.test/api/rooms/${code.toLowerCase()}`)).status).toBe(200);
    expect((await SELF.fetch("https://voting.test/api/rooms/ZZZZZZ")).status).toBe(404);
  });

  it("returns 400 for a malformed code", async () => {
    const response = await SELF.fetch("https://voting.test/api/rooms/nope!/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for a code that is not valid URL encoding", async () => {
    const response = await SELF.fetch("https://voting.test/api/rooms/%E0%A4%A");
    expect(response.status).toBe(400);
  });

  it("refuses to claim the same code twice", async () => {
    const { code } = await createRoom();
    expect(await env.ROOM.getByName(code).claim(code, "other", "other")).toBe(false);
  });

  it("registers the ping/pong auto-response so heartbeats do not wake the object", async () => {
    const { code } = await createRoom();
    await runInDurableObject(env.ROOM.getByName(code), (_instance: VotingRoom, state) => {
      const pair = state.getWebSocketAutoResponse();
      expect(pair?.request).toBe("ping");
      expect(pair?.response).toBe("pong");
    });
  });
});

describe("lobby", () => {
  it("shows every name to everyone as they join", async () => {
    const { code, hostKey } = await createRoom();
    const { client: host } = await joinHost(code, hostKey);
    const { client: first } = await joinBrother(code, "Jacob");
    expect((await host.next("members")).members.map((m) => m.name)).toEqual(["Jacob"]);
    await joinBrother(code, "Mike");
    expect((await membersUntil(first, 2)).map((m) => m.name)).toEqual(["Jacob", "Mike"]);
    expect((await membersUntil(host, 2)).map((m) => m.name)).toEqual(["Jacob", "Mike"]);
  });

  it("never exposes one member's rejoin secret to another", async () => {
    const { code, hostKey } = await createRoom();
    const { client: host } = await joinHost(code, hostKey);
    const { memberId } = await joinBrother(code, "Jacob");
    const members = await host.next("members");
    expect(JSON.stringify(members)).not.toContain(memberId);
  });

  it("rejects a wrong host key", async () => {
    const { code } = await createRoom();
    const client = await connect(code);
    client.send({ type: "join", as: "host", hostKey: "wrong" });
    expect((await client.next("error")).code).toBe("bad_host_key");
  });

  it("gives the host key only to the host", async () => {
    const { code, hostKey } = await createRoom();
    const { snapshot: hostSnapshot } = await joinHost(code, hostKey);
    expect(hostSnapshot.hostOnly?.hostKey).toBe(hostKey);
    const { snapshot } = await joinBrother(code, "Jacob");
    expect(snapshot.hostOnly).toBeUndefined();
  });

  it("rejects actions before join", async () => {
    const { code } = await createRoom();
    const client = await connect(code);
    client.send({ type: "vote", pnmId: "x", value: "yes" });
    expect((await client.next("error")).code).toBe("not_joined");
  });

  it("survives malformed JSON", async () => {
    const { code } = await createRoom();
    const client = await connect(code);
    client.sendRaw("{not json");
    expect((await client.next("error")).code).toBe("bad_message");
  });
});

describe("host controls", () => {
  it("refuses host actions from brothers", async () => {
    const { code, ids } = await seededRoom(3);
    const { client: brother } = await joinBrother(code, "Jacob");
    for (const message of [
      { type: "setFocus", pnmId: ids[0]! },
      { type: "setBudget", yesBudget: 1 },
      { type: "endSession" },
      { type: "kick", handle: "x" },
      { type: "importPnms", pnms: fakePnms(1) },
    ] as const) {
      brother.send(message);
      expect((await brother.next("error")).code).toBe("forbidden");
    }
  });

  it("defaults the budget to the PNM count and tracks later imports", async () => {
    const { host } = await seededRoom(5);
    host.send({ type: "importPnms", pnms: fakePnms(8) });
    const snapshot = await host.next("snapshot");
    expect(snapshot.yesBudget).toBe(8);
    expect(snapshot.budgetIsDefault).toBe(true);
  });

  it("clamps the budget to [1, pnmCount] and restores the default on null", async () => {
    const { host } = await seededRoom(5);
    host.send({ type: "setBudget", yesBudget: 99 });
    expect((await host.next("budget")).yesBudget).toBe(5);
    host.send({ type: "setBudget", yesBudget: 0 });
    expect((await host.next("budget")).yesBudget).toBe(1);
    host.send({ type: "setBudget", yesBudget: null });
    expect(await host.next("budget")).toMatchObject({ yesBudget: 5, budgetIsDefault: true });
  });

  it("refuses re-import once voting has started", async () => {
    const { host, ids } = await seededRoom(3);
    await focus(host, [], ids[0]!);
    host.send({ type: "importPnms", pnms: fakePnms(2) });
    expect((await host.next("error")).code).toBe("wrong_phase");
  });

  it("imports a long form export in one message", async () => {
    const { code, hostKey } = await createRoom();
    const { client: host } = await joinHost(code, hostKey);
    const answers = Array.from({ length: 20 }, (_, index) => ({ q: `Question ${index}`, a: "x".repeat(1000) }));
    const pnms = Array.from({ length: 150 }, (_, index) => ({ name: `PNM ${index}`, photoUrl: null, answers }));
    host.send({ type: "importPnms", pnms });
    expect((await host.next("snapshot")).pnmCount).toBe(150);
  });

  it("rejects an import with a nameless PNM or a non-http photo", async () => {
    const { host } = await seededRoom(1);
    host.send({ type: "importPnms", pnms: [{ name: " ", photoUrl: null, answers: [] }] });
    expect((await host.next("error")).code).toBe("bad_message");
    host.send({ type: "importPnms", pnms: [{ name: "A", photoUrl: "javascript:alert(1)", answers: [] }] });
    expect((await host.next("error")).code).toBe("bad_message");
  });

  it("reveals a PNM to brothers only when focused", async () => {
    const { code, host, ids } = await seededRoom(3);
    const { client: brother, snapshot } = await joinBrother(code, "Jacob");
    expect(snapshot.pnms).toEqual([]);
    expect(snapshot.pnmCount).toBe(3);
    await focus(host, [], ids[1]!);
    expect((await brother.next("focus")).pnm.id).toBe(ids[1]);
    const late = await joinBrother(code, "Late");
    expect(late.snapshot.pnms.map((pnm) => pnm.id)).toEqual([ids[1]]);
    expect(late.snapshot.focusPnmId).toBe(ids[1]);
    expect(late.snapshot.phase).toBe("live");
  });

  it("closes a kicked member's socket and refuses rejoin", async () => {
    const { code, host } = await seededRoom(1);
    const { client: brother, memberId } = await joinBrother(code, "Jacob");
    const { members } = await host.next("members");
    host.send({ type: "kick", handle: members[0]!.handle });
    expect(await brother.closed()).toBe(CLOSE_KICKED);
    expect((await host.next("members")).members).toEqual([]);

    const again = await connect(code);
    again.send({ type: "join", as: "brother", memberId, name: "Jacob" });
    expect((await again.next("error")).code).toBe("kicked");
    expect(await again.closed()).toBe(CLOSE_KICKED);
  });

  it("never changes a tally on kick, which would reveal that member's ballot", async () => {
    const { code, hostKey, host, ids } = await seededRoom(2);
    const { client: kept } = await joinBrother(code, "Kept");
    const { client: target } = await joinBrother(code, "Target");
    const members = await membersUntil(host, 2);
    for (const id of ids) await focus(host, [kept, target], id);
    target.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    await target.next("myVote");
    target.send({ type: "vote", pnmId: ids[1]!, value: "no" });
    await target.next("myVote");

    host.send({ type: "kick", handle: members[1]!.handle });
    await target.closed();
    await host.next("members");

    const { snapshot } = await joinHost(code, hostKey);
    expect(snapshot.hostOnly?.tallies).toEqual({ [ids[0]!]: { yes: 1, no: 0 }, [ids[1]!]: { yes: 0, no: 1 } });
    expect(snapshot.members.map((m) => m.name)).toEqual(["Kept"]);
    expect(snapshot.progress).toMatchObject({ voted: 1, total: 2 });

    host.send({ type: "endSession" });
    const { results } = await host.next("ended");
    expect(results?.rows.map(({ yes, no, noResponse, total }) => [yes, no, noResponse, total])).toEqual([
      [1, 0, 1, 2],
      [0, 1, 1, 2],
    ]);
  });

  it("drops a kicked member with no votes from the total", async () => {
    const { code, host, ids } = await seededRoom(1);
    await joinBrother(code, "Kept");
    await host.next("members");
    const { client: target } = await joinBrother(code, "Target");
    const { members } = await host.next("members");
    await focus(host, [], ids[0]!);
    host.send({ type: "kick", handle: members[1]!.handle });
    await target.closed();
    expect((await host.next("progress")).total).toBe(1);
  });

  it("refuses a limit below what a brother has already spent", async () => {
    const { code, host, ids } = await seededRoom(3);
    const { client: brother } = await joinBrother(code, "Jacob");
    for (const id of ids.slice(0, 2)) await focus(host, [brother], id);
    for (const id of ids.slice(0, 2)) {
      brother.send({ type: "vote", pnmId: id, value: "yes" });
      await brother.next("myVote");
    }
    host.send({ type: "setBudget", yesBudget: 1 });
    expect((await host.next("error")).code).toBe("budget_too_low");
    host.send({ type: "setBudget", yesBudget: 2 });
    expect((await host.next("budget")).yesBudget).toBe(2);
  });
});

describe("hibernation", () => {
  it("keeps socket identity, votes, and host-only delivery across an eviction", async () => {
    const { code, host, ids } = await seededRoom(2);
    const { client: brother, memberId } = await joinBrother(code, "Jacob");
    const { client: watcher } = await joinBrother(code, "Watcher");
    await focus(host, [brother, watcher], ids[0]!);
    brother.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    await brother.next("myVote");

    await evictDurableObject(env.ROOM.getByName(code));

    await focus(host, [brother, watcher], ids[1]!);
    brother.send({ type: "vote", pnmId: ids[1]!, value: "no" });
    expect(await brother.next("myVote")).toMatchObject({ value: "no", yesUsed: 1 });
    expect(await host.next("tally")).toMatchObject({ pnmId: ids[1], no: 1 });
    await settle(watcher);
    expect(watcher.has("tally")).toBe(false);

    const { snapshot } = await joinBrother(code, "Jacob", memberId);
    expect(snapshot.myVotes).toEqual({ [ids[0]!]: "yes", [ids[1]!]: "no" });
  });
});

describe("voting", () => {
  it("cannot exceed the Yes budget", async () => {
    const { code, host, ids } = await seededRoom(3);
    host.send({ type: "setBudget", yesBudget: 2 });
    await host.next("budget");
    const { client: brother } = await joinBrother(code, "Jacob");
    for (const id of ids) await focus(host, [brother], id);

    brother.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    expect((await brother.next("myVote")).yesUsed).toBe(1);
    brother.send({ type: "vote", pnmId: ids[1]!, value: "yes" });
    expect((await brother.next("myVote")).yesUsed).toBe(2);
    brother.send({ type: "vote", pnmId: ids[2]!, value: "yes" });
    expect((await brother.next("error")).code).toBe("budget_exhausted");
  });

  it("cannot overspend with two sockets racing on one member", async () => {
    const { code, host, ids } = await seededRoom(4);
    host.send({ type: "setBudget", yesBudget: 2 });
    await host.next("budget");
    const memberId = crypto.randomUUID();
    const { client: phone } = await joinBrother(code, "Jacob", memberId);
    const { client: tablet } = await joinBrother(code, "Jacob", memberId);
    for (const id of ids) await focus(host, [phone, tablet], id);

    phone.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    tablet.send({ type: "vote", pnmId: ids[1]!, value: "yes" });
    phone.send({ type: "vote", pnmId: ids[2]!, value: "yes" });
    tablet.send({ type: "vote", pnmId: ids[3]!, value: "yes" });
    await settle(phone);
    await settle(tablet);

    const { snapshot } = await joinBrother(code, "Jacob", memberId);
    expect(snapshot.yesUsed).toBe(2);
    expect(Object.values(snapshot.myVotes)).toEqual(["yes", "yes"]);
  });

  it("re-voting Yes on the same PNM does not spend twice", async () => {
    const { code, host, ids } = await seededRoom(2);
    host.send({ type: "setBudget", yesBudget: 1 });
    await host.next("budget");
    const { client: brother } = await joinBrother(code, "Jacob");
    await focus(host, [brother], ids[0]!);
    brother.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    await brother.next("myVote");
    brother.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    expect((await brother.next("myVote")).yesUsed).toBe(1);
  });

  it("clearing a Yes frees budget for another PNM", async () => {
    const { code, host, ids } = await seededRoom(2);
    host.send({ type: "setBudget", yesBudget: 1 });
    await host.next("budget");
    const { client: brother } = await joinBrother(code, "Jacob");
    await focus(host, [brother], ids[0]!);
    await focus(host, [brother], ids[1]!);
    brother.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    await brother.next("myVote");
    brother.send({ type: "vote", pnmId: ids[0]!, value: null });
    expect((await brother.next("myVote")).yesUsed).toBe(0);
    brother.send({ type: "vote", pnmId: ids[1]!, value: "yes" });
    expect((await brother.next("myVote")).yesUsed).toBe(1);
  });

  it("a No never consumes budget, even at zero remaining", async () => {
    const { code, host, ids } = await seededRoom(3);
    host.send({ type: "setBudget", yesBudget: 1 });
    await host.next("budget");
    const { client: brother } = await joinBrother(code, "Jacob");
    for (const id of ids) await focus(host, [brother], id);
    brother.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    await brother.next("myVote");
    brother.send({ type: "vote", pnmId: ids[1]!, value: "no" });
    expect((await brother.next("myVote")).yesUsed).toBe(1);
    brother.send({ type: "vote", pnmId: ids[2]!, value: "no" });
    expect((await brother.next("myVote")).yesUsed).toBe(1);
  });

  it("refuses a vote on a PNM not yet focused", async () => {
    const { code, host, ids } = await seededRoom(3);
    const { client: brother } = await joinBrother(code, "Jacob");
    await focus(host, [brother], ids[0]!);
    brother.send({ type: "vote", pnmId: ids[1]!, value: "yes" });
    expect((await brother.next("error")).code).toBe("not_seen");
  });

  it("allows changing a vote on an earlier PNM after focus has moved on", async () => {
    const { code, host, ids } = await seededRoom(2);
    const { client: brother } = await joinBrother(code, "Jacob");
    await focus(host, [brother], ids[0]!);
    brother.send({ type: "vote", pnmId: ids[0]!, value: "no" });
    await brother.next("myVote");
    await focus(host, [brother], ids[1]!);
    brother.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    expect(await brother.next("myVote")).toMatchObject({ pnmId: ids[0], value: "yes" });
    expect(await host.next("tally")).toMatchObject({ pnmId: ids[0], yes: 1, no: 0 });
  });

  it("restores votes and budget when a member rejoins", async () => {
    const { code, host, ids } = await seededRoom(3);
    const { client: brother, memberId } = await joinBrother(code, "Jacob");
    await focus(host, [brother], ids[0]!);
    await focus(host, [brother], ids[1]!);
    brother.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    await brother.next("myVote");
    brother.send({ type: "vote", pnmId: ids[1]!, value: "no" });
    await brother.next("myVote");
    brother.close();

    const { snapshot } = await joinBrother(code, "Jacob", memberId);
    expect(snapshot.myVotes).toEqual({ [ids[0]!]: "yes", [ids[1]!]: "no" });
    expect(snapshot.yesUsed).toBe(1);
    expect(snapshot.members).toHaveLength(1);
  });

  it("freezes votes when the session ends", async () => {
    const { code, host, ids } = await seededRoom(2);
    const { client: brother, memberId } = await joinBrother(code, "Jacob");
    await focus(host, [brother], ids[0]!);
    host.send({ type: "endSession" });
    await brother.next("ended");
    brother.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    expect((await brother.next("error")).code).toBe("session_ended");

    const newcomer = await connect(code);
    newcomer.send({ type: "join", as: "brother", memberId: crypto.randomUUID(), name: "Late" });
    expect((await newcomer.next("error")).code).toBe("session_ended");

    const { snapshot } = await joinBrother(code, "Jacob", memberId);
    expect(snapshot.phase).toBe("ended");
  });
});

describe("privacy", () => {
  it("shows the host's revealed tally on the projector but never to brothers", async () => {
    const { code, hostKey, host, ids } = await seededRoom(2);
    const { client: voter, memberId } = await joinBrother(code, "Voter");
    const projector = await connect(code);
    projector.send({ type: "join", as: "projector", projectorKey: await projectorKey(code) });
    await projector.next("snapshot");

    await focus(host, [voter], ids[0]!);
    voter.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    await host.next("tally");

    host.send({ type: "reveal", pnmId: ids[0]! });
    expect(await projector.next("revealed")).toMatchObject({ pnmId: ids[0], yes: 1, no: 0 });
    expect(await host.next("revealed")).toMatchObject({ pnmId: ids[0], yes: 1, no: 0 });
    await settle(voter);
    expect(voter.has("revealed")).toBe(false);

    const { snapshot: brother } = await joinBrother(code, "Voter", memberId);
    expect(brother.revealed).toBeNull();
    const { snapshot: hostView } = await joinHost(code, hostKey);
    expect(hostView.revealed).toMatchObject({ pnmId: ids[0], yes: 1 });
    const returning = await connect(code);
    returning.send({ type: "join", as: "projector", projectorKey: await projectorKey(code) });
    expect((await returning.next("snapshot")).revealed).toMatchObject({ pnmId: ids[0], yes: 1 });
  });

  it("clears a reveal when the next PNM goes up", async () => {
    const { code, hostKey, host, ids } = await seededRoom(2);
    host.send({ type: "setFocus", pnmId: ids[0]! });
    await host.next("focus");
    host.send({ type: "reveal", pnmId: ids[0]! });
    await host.next("revealed");
    host.send({ type: "setFocus", pnmId: ids[1]! });
    await host.next("focus");
    expect((await joinHost(code, hostKey)).snapshot.revealed).toBeNull();
  });

  it("only lets the host reveal, and only the PNM on screen", async () => {
    const { code, host, ids } = await seededRoom(2);
    const { client: brother } = await joinBrother(code, "Sneaky");
    await focus(host, [brother], ids[0]!);

    brother.send({ type: "reveal", pnmId: ids[0]! });
    expect((await brother.next("error")).code).toBe("forbidden");
    host.send({ type: "reveal", pnmId: ids[1]! });
    expect((await host.next("error")).code).toBe("wrong_phase");
  });

  it("keeps a reconnecting projector on the tally from the reveal, even if votes change after it", async () => {
    const { code, host, ids } = await seededRoom(1);
    const { client: a } = await joinBrother(code, "A");
    await focus(host, [a], ids[0]!);
    a.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    await settle(a);
    host.send({ type: "reveal", pnmId: ids[0]! });
    await host.next("revealed");

    a.send({ type: "vote", pnmId: ids[0]!, value: "no" });
    await settle(a);

    const returning = await connect(code);
    returning.send({ type: "join", as: "projector", projectorKey: await projectorKey(code) });
    expect((await returning.next("snapshot")).revealed).toEqual({ pnmId: ids[0], yes: 1, no: 0 });
  });

  it("refuses a projector without the room's key", async () => {
    const { code } = await seededRoom(1);
    const wrong = await connect(code);
    wrong.send({ type: "join", as: "projector", projectorKey: "not-the-key" });
    expect((await wrong.next("error")).code).toBe("bad_projector_key");

    const missing = await connect(code);
    missing.send({ type: "join", as: "projector" } as never);
    expect((await missing.next("error")).code).toBe("bad_message");
  });

  it("only gives the projector key to the host", async () => {
    const { code, hostKey } = await seededRoom(1);
    const { snapshot: hostView } = await joinHost(code, hostKey);
    expect(hostView.hostOnly?.projectorKey).toBe(await projectorKey(code));
    const { snapshot: brotherView } = await joinBrother(code, "A");
    expect(JSON.stringify(brotherView)).not.toContain(await projectorKey(code));
  });

  it("never sends a tally or another member's vote value to a brother or projector", async () => {
    const { code, host, ids } = await seededRoom(2);
    const { client: voter } = await joinBrother(code, "Voter");
    const { client: watcher } = await joinBrother(code, "Watcher");
    const projector = await connect(code);
    projector.send({ type: "join", as: "projector", projectorKey: await projectorKey(code) });
    await projector.next("snapshot");

    await focus(host, [voter, watcher], ids[0]!);
    voter.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    await voter.next("myVote");
    expect(await host.next("tally")).toMatchObject({ pnmId: ids[0], yes: 1, no: 0 });
    expect(await watcher.next("progress")).toMatchObject({ pnmId: ids[0] });
    await settle(watcher);
    await settle(projector);

    for (const client of [voter, watcher, projector]) {
      expect(client.has("tally")).toBe(false);
      expect(client.has("myVote")).toBe(false);
    }
    const { snapshot } = await joinBrother(code, "Fresh");
    expect(snapshot.hostOnly).toBeUndefined();
    expect(snapshot.myVotes).toEqual({});
  });

  it("gives the host counts and never per-member votes, and brothers no results", async () => {
    const { code, host, ids } = await seededRoom(1);
    const { client: voter, memberId } = await joinBrother(code, "Voter");
    await focus(host, [voter], ids[0]!);
    voter.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    await voter.next("myVote");
    host.send({ type: "endSession" });
    const ended = await host.next("ended");
    expect(ended.results?.rows[0]).toMatchObject({ yes: 1, no: 0, noResponse: 0, total: 1 });
    expect(JSON.stringify(ended)).not.toContain(memberId);
    expect(JSON.stringify(ended)).not.toContain("Voter");
    expect((await voter.next("ended")).results).toBeUndefined();
  });

  it("reports progress as bare counts", async () => {
    const { code, host, ids } = await seededRoom(1);
    const { client: voter } = await joinBrother(code, "Voter");
    await joinBrother(code, "Other");
    await focus(host, [voter], ids[0]!);
    voter.send({ type: "vote", pnmId: ids[0]!, value: "no" });
    const progress = await host.next("progress");
    expect(Object.keys(progress).sort()).toEqual(["pnmId", "total", "type", "voted"]);
    expect(progress).toMatchObject({ voted: 1, total: 2 });
  });
});

describe("results", () => {
  it("ranks by percent of votes cast, with the cut line at the budget", async () => {
    const { code, host, ids } = await seededRoom(3);
    host.send({ type: "setBudget", yesBudget: 2 });
    await host.next("budget");
    const { client: a } = await joinBrother(code, "A");
    const { client: b } = await joinBrother(code, "B");
    for (const id of ids) await focus(host, [a, b], id);

    a.send({ type: "vote", pnmId: ids[2]!, value: "yes" });
    b.send({ type: "vote", pnmId: ids[2]!, value: "yes" });
    a.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    a.send({ type: "vote", pnmId: ids[1]!, value: "no" });
    b.send({ type: "vote", pnmId: ids[1]!, value: "yes" });
    await settle(a);
    await settle(b);

    host.send({ type: "endSession" });
    const { results } = await host.next("ended");
    expect(results?.cutLine).toBe(2);
    expect(results?.rows.map((row) => [row.name, row.yes, row.no, row.noResponse])).toEqual([
      ["PNM 1", 1, 0, 1],
      ["PNM 3", 2, 0, 0],
      ["PNM 2", 1, 1, 0],
    ]);
    expect(results?.rows.map((row) => row.percent)).toEqual([100, 100, 50]);
    // PNM 1 and PNM 3 tie, but both clear the cut line, so no revote is needed.
    expect(results?.tie).toBeNull();
  });

  it("does not count a skipped ballot against a PNM", async () => {
    const { code, host, ids } = await seededRoom(2);
    const { client: a } = await joinBrother(code, "A");
    const { client: b } = await joinBrother(code, "B");
    const { client: c } = await joinBrother(code, "C");
    await focus(host, [a, b, c], ids[0]!);
    await focus(host, [a, b, c], ids[1]!);

    a.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    a.send({ type: "vote", pnmId: ids[1]!, value: "yes" });
    b.send({ type: "vote", pnmId: ids[1]!, value: "yes" });
    c.send({ type: "vote", pnmId: ids[1]!, value: "no" });
    await settle(a);
    await settle(b);
    await settle(c);

    host.send({ type: "endSession" });
    const { results } = await host.next("ended");
    expect(results?.rows.map((row) => [row.name, Math.round(row.percent)])).toEqual([
      ["PNM 1", 100],
      ["PNM 2", 67],
    ]);
  });

  async function tiedRoom() {
    const { code, hostKey, host, ids } = await seededRoom(4);
    host.send({ type: "setBudget", yesBudget: 2 });
    await host.next("budget");
    const { client: a } = await joinBrother(code, "A");
    const { client: b } = await joinBrother(code, "B");
    for (const id of ids) await focus(host, [a, b], id);

    // PNM 1 is safely in at 100%. PNM 2 and 3 tie at 50% for the last spot. PNM 4 is out at 0%.
    a.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    b.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    a.send({ type: "vote", pnmId: ids[1]!, value: "yes" });
    b.send({ type: "vote", pnmId: ids[1]!, value: "no" });
    a.send({ type: "vote", pnmId: ids[2]!, value: "no" });
    b.send({ type: "vote", pnmId: ids[2]!, value: "yes" });
    a.send({ type: "vote", pnmId: ids[3]!, value: "no" });
    b.send({ type: "vote", pnmId: ids[3]!, value: "no" });
    await settle(a);
    await settle(b);
    return { code, hostKey, host, ids, a, b };
  }

  async function decidedRoom() {
    const { code, host, ids } = await seededRoom(3);
    host.send({ type: "setBudget", yesBudget: 2 });
    await host.next("budget");
    const { client: a, memberId } = await joinBrother(code, "A");
    for (const id of ids) await focus(host, [a], id);

    // PNM 3 outranks PNM 1, and PNM 2 misses the class.
    a.send({ type: "vote", pnmId: ids[2]!, value: "yes" });
    a.send({ type: "vote", pnmId: ids[0]!, value: "yes" });
    a.send({ type: "vote", pnmId: ids[1]!, value: "no" });
    await settle(a);
    return { code, host, ids, a, memberId };
  }

  it("shows the class to host and projector in interview order, without tallies or rank", async () => {
    const { code, host, ids, a, memberId } = await decidedRoom();
    const projector = await connect(code);
    projector.send({ type: "join", as: "projector", projectorKey: await projectorKey(code) });
    expect((await projector.next("snapshot")).classReveal).toBeNull();
    host.send({ type: "endSession" });
    await host.next("ended");
    await projector.next("ended");

    host.send({ type: "revealClass" });
    const { members } = await projector.next("classRevealed");
    expect(members.map(({ pnmId, name }) => [pnmId, name])).toEqual([
      [ids[0], "PNM 1"],
      [ids[2], "PNM 3"],
    ]);
    expect(Object.keys(members[0]!).sort()).toEqual(["name", "photoUrl", "pnmId"]);
    expect((await host.next("classRevealed")).members).toEqual(members);

    const late = await connect(code);
    late.send({ type: "join", as: "projector", projectorKey: await projectorKey(code) });
    expect((await late.next("snapshot")).classReveal).toEqual(members);

    expect(a.received.filter(({ type }) => type === "classRevealed")).toHaveLength(0);
    const { snapshot } = await joinBrother(code, "A", memberId);
    expect(snapshot.classReveal).toBeNull();
  });

  it("refuses to reveal the class before voting ends, during a tie, or for non-hosts", async () => {
    const { code, host } = await tiedRoom();
    host.send({ type: "revealClass" });
    expect((await host.next("error")).code).toBe("wrong_phase");
    host.send({ type: "endSession" });
    await host.next("ended");
    host.send({ type: "revealClass" });
    expect((await host.next("error")).code).toBe("tie_unresolved");

    const projector = await connect(code);
    projector.send({ type: "join", as: "projector", projectorKey: await projectorKey(code) });
    await projector.next("snapshot");
    projector.send({ type: "revealClass" });
    expect((await projector.next("error")).code).toBe("forbidden");
  });

  it("flags a tie across the cut line and names the spots left", async () => {
    const { host, ids } = await tiedRoom();
    host.send({ type: "endSession" });
    const { results } = await host.next("ended");
    expect(results?.tie).toEqual({ pnmIds: [ids[1], ids[2]], spots: 1 });
  });

  it("revotes only the tied PNMs and breaks the tie without moving anyone else", async () => {
    const { code, hostKey, host, ids, a, b } = await tiedRoom();
    host.send({ type: "endSession" });
    await host.next("ended");

    host.send({ type: "startRevote" });
    const snapshot = await a.next("snapshot");
    expect(snapshot.phase).toBe("live");
    expect(snapshot.focusPnmId).toBe(ids[1]);
    expect(snapshot.revote).toEqual({ pnmIds: [ids[1], ids[2]], spots: 1 });
    expect(Object.keys(snapshot.myVotes).sort()).toEqual([ids[0], ids[3]].sort());

    a.send({ type: "vote", pnmId: ids[0]!, value: "no" });
    expect((await a.next("error")).code).toBe("not_in_revote");
    host.send({ type: "setFocus", pnmId: ids[0]! });
    expect((await host.next("error")).code).toBe("not_in_revote");

    host.send({ type: "setFocus", pnmId: ids[2]! });
    await a.next("focus");
    await b.next("focus");
    // PNM 3 wins the revote at 50%. PNM 2 falls to 0%, which is still above PNM 4 because it tied first.
    a.send({ type: "vote", pnmId: ids[1]!, value: "no" });
    b.send({ type: "vote", pnmId: ids[1]!, value: "no" });
    a.send({ type: "vote", pnmId: ids[2]!, value: "yes" });
    b.send({ type: "vote", pnmId: ids[2]!, value: "no" });
    await settle(a);
    await settle(b);

    host.send({ type: "endSession" });
    const { results } = await host.next("ended");
    expect(results?.tie).toBeNull();
    expect(results?.rows.map((row) => row.name)).toEqual(["PNM 1", "PNM 3", "PNM 2", "PNM 4"]);
    expect(results?.rows[1]).toMatchObject({ yes: 1, no: 1, percent: 50, revotes: [{ yes: 1, no: 1 }] });
    expect((await joinHost(code, hostKey)).snapshot.revote).toBeNull();
  });

  it("lifts the Yes limit during a revote", async () => {
    const { host, ids, a } = await tiedRoom();
    host.send({ type: "endSession" });
    await host.next("ended");
    host.send({ type: "startRevote" });
    const snapshot = await a.next("snapshot");
    expect(snapshot.budgetIsDefault).toBe(true);

    a.send({ type: "vote", pnmId: ids[1]!, value: "yes" });
    expect((await a.next("myVote")).value).toBe("yes");
    a.send({ type: "vote", pnmId: ids[2]!, value: "yes" });
    expect((await a.next("myVote")).value).toBe("yes");
  });

  it("can revote again when the revote ties", async () => {
    const { host, ids, a } = await tiedRoom();
    host.send({ type: "endSession" });
    await host.next("ended");
    host.send({ type: "startRevote" });
    await a.next("snapshot");
    a.send({ type: "vote", pnmId: ids[1]!, value: "yes" });
    a.send({ type: "vote", pnmId: ids[2]!, value: "yes" });
    await settle(a);

    host.send({ type: "endSession" });
    const { results } = await host.next("ended");
    expect(results?.tie).toEqual({ pnmIds: [ids[1], ids[2]], spots: 1 });
    host.send({ type: "startRevote" });
    expect((await a.next("snapshot")).revote?.pnmIds).toEqual([ids[1], ids[2]]);
  });

  it("refuses a revote with no tie, or while voting is open", async () => {
    const { host, ids } = await seededRoom(2);
    host.send({ type: "setFocus", pnmId: ids[0]! });
    await host.next("focus");
    host.send({ type: "startRevote" });
    expect((await host.next("error")).code).toBe("wrong_phase");
    host.send({ type: "endSession" });
    await host.next("ended");
    host.send({ type: "startRevote" });
    expect((await host.next("error")).code).toBe("no_tie");
  });

  it("returns results in the host snapshot after a reload", async () => {
    const { code, hostKey, host } = await seededRoom(1);
    host.send({ type: "endSession" });
    await host.next("ended");
    const { snapshot } = await joinHost(code, hostKey);
    expect(snapshot.hostOnly?.results?.rows).toHaveLength(1);
  });
});

describe("abuse limits", () => {
  it("limits new rooms per client address, and marks API responses uncacheable", async () => {
    const create = () =>
      SELF.fetch("https://voting.test/api/rooms", { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.7" } });
    const first = await create();
    expect(first.status).toBe(201);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const statuses = [];
    for (let attempt = 0; attempt < 12; attempt++) statuses.push((await create()).status);
    expect(statuses).toContain(429);
  });

  it("closes a room to new names but lets existing brothers return", async () => {
    const { code, host } = await seededRoom(1);
    const { memberId } = await joinBrother(code, "Jacob");
    host.send({ type: "setJoinLocked", locked: true });
    expect((await host.next("joinLock")).locked).toBe(true);

    const stranger = await connect(code);
    stranger.send({ type: "join", as: "brother", memberId: crypto.randomUUID(), name: "Stranger" });
    expect((await stranger.next("error")).code).toBe("room_locked");

    const { snapshot } = await joinBrother(code, "Jacob", memberId);
    expect(snapshot.joinLocked).toBe(true);
    expect(snapshot.members.map(({ name }) => name)).toEqual(["Jacob"]);
  });

  it("only lets the host close a room to new names", async () => {
    const { code } = await seededRoom(1);
    const { client } = await joinBrother(code, "Jacob");
    client.send({ type: "setJoinLocked", locked: true });
    expect((await client.next("error")).code).toBe("forbidden");
  });

  it("refuses new names once a room is full", async () => {
    const { code } = await seededRoom(1);
    await runInDurableObject(env.ROOM.getByName(code), (_, state) => {
      for (let index = 0; index < 1_000; index++) {
        state.storage.sql.exec(
          "INSERT INTO member (id, handle, name, joined_at) VALUES (?, ?, ?, 0)",
          `member-${index}`,
          `handle-${index}`,
          `Member ${index}`,
        );
      }
    });
    const late = await connect(code);
    late.send({ type: "join", as: "brother", memberId: crypto.randomUUID(), name: "Late" });
    expect((await late.next("error")).code).toBe("room_full");
  });

  it("stops one socket from flooding the room", async () => {
    const { code } = await seededRoom(1);
    const { client } = await joinBrother(code, "Jacob");
    for (let index = 0; index < 70; index++) client.send({ type: "vote", pnmId: "__flood__", value: null });
    const codes = [];
    for (;;) {
      const { code: errorCode } = await client.next("error");
      codes.push(errorCode);
      if (errorCode === "rate_limited") break;
    }
    expect(codes).toHaveLength(60);
  });

  it("refuses a PNM whose answers are too large to store", async () => {
    const { code, hostKey } = await createRoom();
    const { client: host } = await joinHost(code, hostKey);
    const answers = Array.from({ length: 100 }, (_, index) => ({ q: `Question ${index}`, a: "x".repeat(10_000) }));
    host.send({ type: "importPnms", pnms: [{ name: "Too much", photoUrl: null, answers }] });
    expect((await host.next("error")).code).toBe("bad_message");
  });

  it("sends a burst of joins to everyone as a few updates", async () => {
    const { code, host } = await seededRoom(1);
    await Promise.all(Array.from({ length: 8 }, (_, index) => joinBrother(code, `Brother ${index}`)));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(host.received.filter(({ type }) => type === "members").length).toBeLessThanOrEqual(2);
  });
});

describe("retention", () => {
  it("sets a room to expire a month after its last use", async () => {
    const { code, host } = await seededRoom(1);
    const stub = env.ROOM.getByName(code);
    const expiry = () => runInDurableObject(stub, (_, state) => state.storage.getAlarm());
    const first = await expiry();
    expect(first).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);

    await new Promise((resolve) => setTimeout(resolve, 20));
    host.send({ type: "setBudget", yesBudget: 1 });
    await host.next("budget");
    expect(await expiry()).toBeGreaterThan(first!);
  });

  it("erases everything when a room expires, and can reuse the code", async () => {
    const { code, host } = await seededRoom(1);
    const stub = env.ROOM.getByName(code);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await host.closed();

    expect(await stub.exists()).toBe(false);
    const response = await SELF.fetch(`https://voting.test/api/rooms/${code}`);
    expect(response.status).toBe(404);
    const count = await runInDurableObject(stub, (_, state) => {
      return state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pnm").one().count;
    });
    expect(count).toBe(0);
    expect(await stub.claim(code, "new-host", "new-projector")).toBe(true);
  });
});

describe("photo import", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const drive = (id: string) => `https://drive.google.com/thumbnail?id=${id}&sz=w800`;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function answerFromDrive(response: () => Response) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
  }

  async function driveRoom(photoUrl = drive("abc")) {
    const { code, hostKey } = await createRoom();
    const { client: host } = await joinHost(code, hostKey);
    host.send({ type: "importPnms", pnms: [{ name: "Photo Person", photoUrl, answers: [] }] });
    const { pnms } = await host.next("snapshot");
    return { code, hostKey, host, pnmId: pnms[0]!.id };
  }

  const save = (code: string, pnmId: string, hostKey: string) =>
    SELF.fetch(`https://voting.test/api/rooms/${code}/photos/${pnmId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hostKey}` },
    });

  it("copies a Drive photo into storage and serves it with a long cache", async () => {
    const { code, hostKey, host, pnmId } = await driveRoom();
    answerFromDrive(() => new Response(JPEG, { headers: { "Content-Type": "image/jpeg" } }));

    const response = await save(code, pnmId, hostKey);
    expect(response.status).toBe(200);
    const { photoUrl } = (await response.json()) as { photoUrl: string };
    expect(photoUrl).toMatch(new RegExp(`^/photos/${code}/[0-9a-f-]{36}$`));
    expect((await host.next("pnmPhoto")).photoUrl).toBe(photoUrl);

    const photo = await SELF.fetch(`https://voting.test${photoUrl}`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get("Content-Type")).toBe("image/jpeg");
    expect(photo.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG);

    expect((await save(code, pnmId, hostKey)).status).toBe(404);
  });

  it("reports a private Drive file instead of storing its sign-in page", async () => {
    const { code, hostKey, pnmId } = await driveRoom();
    answerFromDrive(() => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }));
    const response = await save(code, pnmId, hostKey);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ status: "not_shared" });
  });

  it("marks a Drive slowdown as worth retrying", async () => {
    const { code, hostKey, pnmId } = await driveRoom();
    answerFromDrive(() => new Response("slow down", { status: 429 }));
    expect(await (await save(code, pnmId, hostKey)).json()).toEqual({ status: "unavailable" });
  });

  it("refuses the wrong host key without calling Drive", async () => {
    const { code, pnmId } = await driveRoom();
    const download = answerFromDrive(() => new Response(JPEG));
    expect((await save(code, pnmId, "wrong")).status).toBe(403);
    expect(download).not.toHaveBeenCalled();
  });

  it("never fetches an address that isn't a Drive thumbnail", async () => {
    const { code, hostKey, pnmId } = await driveRoom("https://internal.example/secret.jpg");
    const download = answerFromDrive(() => new Response(JPEG));
    expect((await save(code, pnmId, hostKey)).status).toBe(404);
    expect(download).not.toHaveBeenCalled();
  });

  it("keeps the saved photo of an unseen PNM off brothers' phones", async () => {
    const { code, hostKey, host, pnmId } = await driveRoom();
    const { client: brother } = await joinBrother(code, "Jacob");
    answerFromDrive(() => new Response(JPEG, { headers: { "Content-Type": "image/jpeg" } }));
    await save(code, pnmId, hostKey);
    await host.next("pnmPhoto");
    await settle(brother);
    expect(brother.has("pnmPhoto")).toBe(false);
  });

  it("erases saved photos when the room expires", async () => {
    const { code, hostKey, host, pnmId } = await driveRoom();
    answerFromDrive(() => new Response(JPEG, { headers: { "Content-Type": "image/jpeg" } }));
    const { photoUrl } = (await (await save(code, pnmId, hostKey)).json()) as { photoUrl: string };
    await runDurableObjectAlarm(env.ROOM.getByName(code));
    await host.closed();
    expect((await SELF.fetch(`https://voting.test${photoUrl}`)).status).toBe(404);
  });

  it("erases saved photos when the PNM list is replaced", async () => {
    const { code, hostKey, host, pnmId } = await driveRoom();
    answerFromDrive(() => new Response(JPEG, { headers: { "Content-Type": "image/jpeg" } }));
    const { photoUrl } = (await (await save(code, pnmId, hostKey)).json()) as { photoUrl: string };
    await host.next("pnmPhoto");
    host.send({ type: "importPnms", pnms: fakePnms(1) });
    await host.next("snapshot");
    await vi.waitFor(async () => {
      expect((await SELF.fetch(`https://voting.test${photoUrl}`)).status).toBe(404);
    });
  });
});
