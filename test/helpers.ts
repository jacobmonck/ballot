import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { ClientMessage, PnmInput, PositionInput, ServerMessage } from "../src/shared/protocol";

type Of<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export class Client {
  received: ServerMessage[] = [];
  closeCode: number | null = null;
  private waiters: (() => void)[] = [];

  constructor(private ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      this.received.push(JSON.parse(event.data as string) as ServerMessage);
      this.wake();
    });
    ws.addEventListener("close", (event) => {
      this.closeCode = event.code;
      this.wake();
    });
  }

  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  send(message: ClientMessage) {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(text: string) {
    this.ws.send(text);
  }

  close() {
    this.ws.close(1000);
  }

  // Resolves with the next unconsumed message of `type`, removing it and everything before it.
  async next<T extends ServerMessage["type"]>(type: T): Promise<Of<T>> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const index = this.received.findIndex((message) => message.type === type);
      if (index >= 0) {
        const message = this.received[index] as Of<T>;
        this.received.splice(0, index + 1);
        return message;
      }
      if (this.closeCode !== null) throw new Error(`closed ${this.closeCode} waiting for ${type}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);
    }
  }

  async closed(): Promise<number> {
    const deadline = Date.now() + 3000;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error("timed out waiting for close");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.closeCode;
  }

  // Only sees messages not yet consumed by `next`.
  has(type: ServerMessage["type"]) {
    return this.received.some((message) => message.type === type);
  }
}

export async function createRoom() {
  const response = await SELF.fetch("https://voting.test/api/rooms", { method: "POST" });
  if (response.status !== 201) throw new Error(`create failed: ${response.status}`);
  return (await response.json()) as { code: string; hostKey: string };
}

export async function connect(code: string): Promise<Client> {
  const response = await SELF.fetch(`https://voting.test/api/rooms/${code}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  if (!response.webSocket) throw new Error(`no socket: ${response.status}`);
  return new Client(response.webSocket);
}

export async function joinBrother(code: string, name: string, memberId: string = crypto.randomUUID()) {
  const client = await connect(code);
  client.send({ type: "join", as: "brother", memberId, name });
  const snapshot = await client.next("snapshot");
  return { client, snapshot, memberId };
}

export async function projectorKey(code: string) {
  return runInDurableObject(env.ROOM.getByName(code), (_, state) => {
    return state.storage.sql.exec<{ projector_key: string }>("SELECT projector_key FROM room").one().projector_key;
  });
}

export async function joinHost(code: string, hostKey: string) {
  const client = await connect(code);
  client.send({ type: "join", as: "host", hostKey });
  const snapshot = await client.next("snapshot");
  return { client, snapshot };
}

export function fakePnms(count: number): PnmInput[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `PNM ${index + 1}`,
    photoUrl: `https://photos.test/${index + 1}.jpg`,
    answers: [{ q: "Why us?", a: `Answer ${index + 1}` }],
  }));
}

// A room with `count` PNMs imported; returns host-side PNM ids in order.
export async function seededRoom(count: number) {
  const { code, hostKey } = await createRoom();
  const { client: host } = await joinHost(code, hostKey);
  host.send({ type: "importPnms", pnms: fakePnms(count) });
  const snapshot = await host.next("snapshot");
  return { code, hostKey, host, ids: snapshot.pnms.map((pnm) => pnm.id) };
}

export async function focus(host: Client, brothers: Client[], pnmId: string) {
  host.send({ type: "setFocus", pnmId });
  await host.next("focus");
  for (const brother of brothers) await brother.next("focus");
}

// Round-trips through the room so anything sent before this call has been delivered.
// Joins go out in batches, so wait for the update that has everyone.
export async function membersUntil(client: Client, count: number) {
  for (;;) {
    const { members } = await client.next("members");
    if (members.length >= count) return members;
  }
}

export async function settle(client: Client) {
  client.send({ type: "vote", pnmId: "__settle__", value: null });
  for (;;) {
    const { code } = await client.next("error");
    if (code === "not_seen" || code === "forbidden") return;
  }
}

export function fakePositions(): PositionInput[] {
  return [
    { title: "President", seats: 1, candidates: ["Alex", "Blake", "Casey"] },
    { title: "Social Chair", seats: 2, candidates: ["Drew", "Emery", "Finley", "Gray"] },
  ];
}

// A room in election mode with `fakePositions()` added; returns the positions as the host sees them.
export async function electionRoom() {
  const { code, hostKey } = await createRoom();
  const { client: host } = await joinHost(code, hostKey);
  host.send({ type: "setMode", mode: "election" });
  let snapshot = await host.next("snapshot");
  for (const position of fakePositions()) {
    host.send({ type: "addPosition", position });
    snapshot = await host.next("snapshot");
  }
  return { code, hostKey, host, positions: snapshot.positions };
}
