import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_KICKED,
  type ClassMember,
  type ClientMessage,
  type ErrorCode,
  type MemberInfo,
  type Phase,
  type Pnm,
  type PnmInput,
  type Progress,
  type QA,
  type ResultRow,
  type Results,
  type Revealed,
  type Role,
  type ServerMessage,
  type Snapshot,
  type Tally,
  type Tie,
  type VoteValue,
} from "../shared/protocol";
import { photoKey } from "./photos";
import { migrate } from "./schema";
import { parseClientMessage } from "./validate";

const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MEMBERS = 1_000;
// Joins and votes arrive in bursts, and each update reaches every socket, so they go out together.
const ROOM_UPDATE_MS = 200;
const SOCKET_WINDOW_MS = 10_000;
const SOCKET_WINDOW_MESSAGES = 60;

// Identity rides on the socket so it survives hibernation. Unjoined sockets have no attachment.
interface Attachment {
  role: Role;
  memberId: string | null;
}

type RoomRow = {
  code: string;
  host_key: string;
  projector_key: string;
  yes_budget: number;
  focus_pnm_id: string | null;
  revealed_pnm_id: string | null;
  revealed_yes: number | null;
  revealed_no: number | null;
  revote_spots: number | null;
  class_revealed: number;
  join_locked: number;
  phase: Phase;
};

type PnmRow = {
  id: string;
  ordinal: number;
  name: string;
  photo_url: string | null;
  in_revote: number;
  past_rounds: string;
  answers: string;
};

class Refusal extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function toPnm(row: PnmRow): Pnm {
  return {
    id: row.id,
    ordinal: row.ordinal,
    name: row.name,
    photoUrl: row.photo_url,
    answers: JSON.parse(row.answers) as QA[],
  };
}

// Compares Yes share of votes cast using whole numbers, so equal shares are exactly equal.
function compareShare(a: Tally, b: Tally): number {
  const castA = a.yes + a.no;
  const castB = b.yes + b.no;
  if (castA === 0 || castB === 0) return (castB === 0 ? 0 : b.yes / castB) - (castA === 0 ? 0 : a.yes / castA);
  return b.yes * castA - a.yes * castB;
}

// Later rounds only reorder PNMs that tied in every round before, so a revote can't drop a PNM below others.
function compareRounds(a: Tally[], b: Tally[]): number {
  for (let round = 0; round < Math.min(a.length, b.length); round++) {
    const order = compareShare(a[round]!, b[round]!);
    if (order !== 0) return order;
  }
  return 0;
}

// A tie only matters when it straddles the cut line, because then not everyone in it can get in.
function findTie(ranked: { row: ResultRow; rounds: Tally[] }[], cutLine: number): Tie | null {
  const lastIn = ranked[cutLine - 1];
  const firstOut = ranked[cutLine];
  if (!lastIn || !firstOut || compareRounds(lastIn.rounds, firstOut.rounds) !== 0) return null;
  const tied = ranked.filter(({ rounds }) => compareRounds(rounds, lastIn.rounds) === 0);
  const before = ranked.findIndex(({ rounds }) => compareRounds(rounds, lastIn.rounds) === 0);
  return { pnmIds: tied.map(({ row }) => row.pnmId), spots: cutLine - before };
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

export class VotingRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly socketUse = new WeakMap<WebSocket, { windowStart: number; messages: number }>();
  private roomUpdate: ReturnType<typeof setTimeout> | null = null;
  private membersChanged = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.sql);
      // Rooms from before retention existed have no expiry yet.
      if (this.roomOrNull() && (await ctx.storage.getAlarm()) === null) this.keepAlive();
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async claim(code: string, hostKey: string, projectorKey: string): Promise<boolean> {
    if (this.roomOrNull()) return false;
    this.sql.exec(
      "INSERT INTO room (id, code, host_key, projector_key, phase, created_at) VALUES (1, ?, ?, ?, 'setup', ?)",
      code,
      hostKey,
      projectorKey,
      Date.now(),
    );
    this.keepAlive();
    return true;
  }

  // PNM answers and photos are personal data, so a room is erased after a month without use.
  async alarm(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, "room expired");
    await this.deletePhotos();
    await this.ctx.storage.deleteAll();
    migrate(this.sql);
  }

  async exists(): Promise<boolean> {
    return this.roomOrNull() !== undefined;
  }

  // The Drive address a host may copy into storage, or why they can't.
  async photoSource(hostKey: string, pnmId: string): Promise<string> {
    if (!timingSafeEqual(hostKey, this.room().host_key)) return "forbidden";
    return (
      this.sql.exec<{ photo_url: string | null }>("SELECT photo_url FROM pnm WHERE id = ?", pnmId).toArray()[0]?.photo_url ??
      "missing"
    );
  }

  async savePhoto(hostKey: string, pnmId: string, source: string, photoUrl: string): Promise<boolean> {
    if (!timingSafeEqual(hostKey, this.room().host_key)) return false;
    const { rowsWritten } = this.sql.exec(
      "UPDATE pnm SET photo_url = ? WHERE id = ? AND photo_url = ?",
      photoUrl,
      pnmId,
      source,
    );
    if (rowsWritten === 0) return false;
    const { seen } = this.sql.exec<{ seen: number }>("SELECT seen FROM pnm WHERE id = ?", pnmId).one();
    const message: ServerMessage = { type: "pnmPhoto", pnmId, photoUrl };
    // A PNM brothers haven't reached yet stays off their phones, photo included.
    if (seen) this.broadcast(message);
    else this.sendToHosts(message);
    this.keepAlive();
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (!this.roomOrNull()) return new Response("Room not found", { status: 404 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (this.overSocketLimit(ws)) return;
    const message = parseClientMessage(raw);
    if (message === null) {
      this.send(ws, { type: "error", code: "bad_message", message: "Message not understood." });
      return;
    }
    try {
      this.dispatch(ws, message);
    } catch (error) {
      if (!(error instanceof Refusal)) {
        console.error("Room message failed", message.type, error);
        this.send(ws, { type: "error", code: "server_error", message: "Something went wrong. Try that again." });
        return;
      }
      this.send(ws, { type: "error", code: error.code, message: error.message });
      if (error.code === "kicked") ws.close(CLOSE_KICKED, "removed");
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // Nothing to clean up: presence is not tracked and votes outlive sockets.
    try {
      ws.close();
    } catch {
      // Already closed by the auto-reply.
    }
  }

  // Only counts in memory, so a window restarts if the room hibernates. Bursts that long never hibernate.
  private overSocketLimit(ws: WebSocket): boolean {
    const now = Date.now();
    const use = this.socketUse.get(ws);
    if (!use || now - use.windowStart >= SOCKET_WINDOW_MS) {
      this.socketUse.set(ws, { windowStart: now, messages: 1 });
      return false;
    }
    use.messages++;
    if (use.messages <= SOCKET_WINDOW_MESSAGES) return false;
    if (use.messages === SOCKET_WINDOW_MESSAGES + 1) {
      this.send(ws, { type: "error", code: "rate_limited", message: "Too many requests. Wait a few seconds." });
    }
    return true;
  }

  private keepAlive() {
    void this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  private dispatch(ws: WebSocket, message: ClientMessage) {
    if (message.type === "join") {
      if (this.attachment(ws)) throw new Refusal("already_joined", "Already joined.");
      this.keepAlive();
      if (message.as === "brother") this.joinBrother(ws, message.memberId, message.name);
      else if (message.as === "host") this.joinHost(ws, message.hostKey);
      else this.joinProjector(ws, message.projectorKey);
      return;
    }

    const self = this.attachment(ws);
    if (!self) throw new Refusal("not_joined", "Join the room first.");

    if (message.type === "vote") {
      if (self.memberId === null) throw new Refusal("forbidden", "Only brothers vote.");
      this.vote(self.memberId, message.pnmId, message.value);
      return;
    }

    if (self.role !== "host") throw new Refusal("forbidden", "Only the host can do that.");
    this.keepAlive();
    switch (message.type) {
      case "importPnms":
        return this.importPnms(message.pnms);
      case "setBudget":
        return this.setBudget(message.yesBudget);
      case "setFocus":
        return this.setFocus(message.pnmId);
      case "reveal":
        return this.reveal(message.pnmId);
      case "setJoinLocked":
        return this.setJoinLocked(message.locked);
      case "kick":
        return this.kick(message.handle);
      case "endSession":
        return this.endSession();
      case "startRevote":
        return this.startRevote();
      case "revealClass":
        return this.revealClass();
    }
  }

  private attach(ws: WebSocket, attachment: Attachment) {
    ws.serializeAttachment(attachment);
    this.send(ws, this.snapshot(attachment));
  }

  private joinHost(ws: WebSocket, hostKey: string) {
    if (!timingSafeEqual(hostKey, this.room().host_key)) {
      throw new Refusal("bad_host_key", "That host key is not valid for this room.");
    }
    this.attach(ws, { role: "host", memberId: null });
  }

  private joinProjector(ws: WebSocket, projectorKey: string) {
    if (!timingSafeEqual(projectorKey, this.room().projector_key)) {
      throw new Refusal("bad_projector_key", "That projector link is not valid for this room.");
    }
    this.attach(ws, { role: "projector", memberId: null });
  }

  private joinBrother(ws: WebSocket, memberId: string, name: string) {
    const existing = this.sql
      .exec<{ name: string; kicked: number }>("SELECT name, kicked FROM member WHERE id = ?", memberId)
      .toArray()[0];

    if (existing?.kicked) throw new Refusal("kicked", "You were removed from this room.");
    if (!existing && this.room().phase === "ended") {
      throw new Refusal("session_ended", "Voting has ended for this room.");
    }
    if (!existing && this.room().join_locked) {
      throw new Refusal("room_locked", "The host has closed this room to new names.");
    }
    if (!existing && this.members().length >= MAX_MEMBERS) {
      throw new Refusal("room_full", "This room is full.");
    }

    if (!existing) {
      this.sql.exec(
        "INSERT INTO member (id, handle, name, joined_at) VALUES (?, ?, ?, ?)",
        memberId,
        crypto.randomUUID(),
        name,
        Date.now(),
      );
    } else if (existing.name !== name) {
      this.sql.exec("UPDATE member SET name = ? WHERE id = ?", name, memberId);
    }

    this.attach(ws, { role: "brother", memberId });

    if (existing?.name !== name) this.queueRoomUpdate(true);
  }

  private vote(memberId: string, pnmId: string, value: VoteValue | null) {
    if (this.room().phase === "ended") throw new Refusal("session_ended", "Voting has ended.");

    const seen = this.sql
      .exec<{ in_revote: number }>("SELECT in_revote FROM pnm WHERE id = ? AND seen = 1", pnmId)
      .toArray()[0];
    if (!seen) throw new Refusal("not_seen", "This PNM has not come up yet.");
    if (this.room().revote_spots !== null && !seen.in_revote) {
      throw new Refusal("not_in_revote", "Only the tied PNMs are open for voting.");
    }

    if (value === "yes") {
      const { spent } = this.sql
        .exec<{ spent: number }>(
          "SELECT COUNT(*) AS spent FROM vote WHERE member_id = ? AND value = 'yes' AND pnm_id != ?",
          memberId,
          pnmId,
        )
        .one();
      if (spent >= this.voteBudget()) {
        throw new Refusal("budget_exhausted", "No Yes votes left. Clear an earlier Yes to free one.");
      }
    }

    if (value === null) {
      this.sql.exec("DELETE FROM vote WHERE member_id = ? AND pnm_id = ?", memberId, pnmId);
    } else {
      this.sql.exec(
        `INSERT INTO vote (member_id, pnm_id, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (member_id, pnm_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        memberId,
        pnmId,
        value,
        Date.now(),
      );
    }

    const myVote: ServerMessage = { type: "myVote", pnmId, value, yesUsed: this.yesUsed(memberId) };
    for (const socket of this.ctx.getWebSockets()) {
      if (this.attachment(socket)?.memberId === memberId) this.send(socket, myVote);
    }
    this.queueRoomUpdate(false);
    const tally = this.tallies()[pnmId] ?? { yes: 0, no: 0 };
    this.sendToHosts({ type: "tally", pnmId, ...tally });
  }

  private importPnms(pnms: PnmInput[]) {
    if (this.room().phase !== "setup") {
      throw new Refusal("wrong_phase", "PNMs cannot be replaced after voting has started.");
    }
    const replacedPhotos = this.photoKeys();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM pnm");
      pnms.forEach((pnm, index) => {
        this.sql.exec(
          "INSERT INTO pnm (id, ordinal, name, photo_url, answers) VALUES (?, ?, ?, ?, ?)",
          crypto.randomUUID(),
          index + 1,
          pnm.name,
          pnm.photoUrl,
          JSON.stringify(pnm.answers),
        );
      });
    });
    this.broadcastSnapshots();
    if (replacedPhotos.length > 0) this.ctx.waitUntil(this.env.PHOTOS.delete(replacedPhotos));
  }

  private photoKeys(): string[] {
    return this.sql
      .exec<{ photo_url: string | null }>("SELECT photo_url FROM pnm")
      .toArray()
      .flatMap(({ photo_url }) => photoKey(photo_url ?? "") ?? []);
  }

  private async deletePhotos() {
    const keys = this.photoKeys();
    if (keys.length > 0) await this.env.PHOTOS.delete(keys);
  }

  private setBudget(yesBudget: number | null) {
    if (this.room().phase === "ended") throw new Refusal("session_ended", "Voting has ended.");
    const count = this.pnmCount();
    if (count === 0) throw new Refusal("wrong_phase", "Import PNMs before setting the budget.");
    const stored = yesBudget === null ? 0 : Math.max(1, Math.min(yesBudget, count));
    const { spent } = this.sql
      .exec<{ spent: number }>(`
        SELECT COALESCE(MAX(yeses), 0) AS spent
        FROM (SELECT COUNT(*) AS yeses FROM vote WHERE value = 'yes' GROUP BY member_id)
      `)
      .one();
    if (stored !== 0 && stored < spent) {
      throw new Refusal("budget_too_low", `A brother has already used ${spent} Yes votes. Set the limit to ${spent} or higher.`);
    }
    this.sql.exec("UPDATE room SET yes_budget = ?", stored);
    this.broadcast({ type: "budget", yesBudget: this.effectiveBudget(), budgetIsDefault: stored === 0 });
  }

  private setFocus(pnmId: string) {
    if (this.room().phase === "ended") throw new Refusal("session_ended", "Voting has ended.");
    const row = this.sql.exec<PnmRow>("SELECT * FROM pnm WHERE id = ?", pnmId).toArray()[0];
    if (!row) throw new Refusal("not_found", "No such PNM.");
    if (this.room().revote_spots !== null && !row.in_revote) {
      throw new Refusal("not_in_revote", "Only the tied PNMs are open for voting.");
    }
    this.sql.exec("UPDATE pnm SET seen = 1 WHERE id = ?", pnmId);
    this.sql.exec(
      "UPDATE room SET focus_pnm_id = ?, revealed_pnm_id = NULL, revealed_yes = NULL, revealed_no = NULL, phase = 'live'",
      pnmId,
    );
    this.broadcast({ type: "focus", pnm: toPnm(row), progress: this.progress(pnmId) });
  }

  private reveal(pnmId: string) {
    const room = this.room();
    if (room.phase !== "live" || room.focus_pnm_id !== pnmId) {
      throw new Refusal("wrong_phase", "Only the PNM on screen can be revealed.");
    }
    // Votes stay open after a reveal, so the tally is frozen here. A reconnect must not show later changes.
    const { yes, no } = this.tallies()[pnmId] ?? { yes: 0, no: 0 };
    this.sql.exec("UPDATE room SET revealed_pnm_id = ?, revealed_yes = ?, revealed_no = ?", pnmId, yes, no);
    this.sendToScreens({ type: "revealed", pnmId, yes, no });
  }

  private kick(handle: string) {
    if (this.room().phase === "ended") throw new Refusal("session_ended", "Voting has ended.");
    const target = this.sql
      .exec<{ id: string }>("SELECT id FROM member WHERE handle = ? AND kicked = 0", handle)
      .toArray()[0];
    if (!target) throw new Refusal("not_found", "No such member.");

    // Their votes stay counted. Deleting them would move the tallies and show the host how they voted.
    this.sql.exec("UPDATE member SET kicked = 1 WHERE id = ?", target.id);

    for (const socket of this.ctx.getWebSockets()) {
      if (this.attachment(socket)?.memberId === target.id) {
        socket.serializeAttachment(null);
        socket.close(CLOSE_KICKED, "removed");
      }
    }
    this.queueRoomUpdate(true);
  }

  private setJoinLocked(locked: boolean) {
    this.sql.exec("UPDATE room SET join_locked = ?", locked ? 1 : 0);
    this.broadcast({ type: "joinLock", locked });
  }

  private queueRoomUpdate(membersChanged: boolean) {
    this.membersChanged ||= membersChanged;
    this.roomUpdate ??= setTimeout(() => this.flushRoomUpdate(), ROOM_UPDATE_MS);
  }

  private flushRoomUpdate() {
    this.roomUpdate = null;
    const room = this.roomOrNull();
    if (!room) return;
    if (this.membersChanged) this.broadcast({ type: "members", members: this.members() });
    this.membersChanged = false;
    if (room.focus_pnm_id) this.broadcast({ type: "progress", ...this.progress(room.focus_pnm_id) });
  }

  private endSession() {
    if (this.room().phase === "ended") throw new Refusal("session_ended", "Voting has already ended.");
    this.sql.exec("UPDATE room SET phase = 'ended', revote_spots = NULL");
    this.sql.exec("UPDATE pnm SET in_revote = 0");
    const results = this.results();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(socket);
      if (!attachment) continue;
      this.send(socket, attachment.role === "host" ? { type: "ended", results } : { type: "ended" });
    }
  }

  private startRevote() {
    if (this.room().phase !== "ended") throw new Refusal("wrong_phase", "End voting before starting a revote.");
    const { tie } = this.results();
    if (!tie) throw new Refusal("no_tie", "No tie to break.");

    const tallies = this.tallies();
    this.ctx.storage.transactionSync(() => {
      for (const pnmId of tie.pnmIds) {
        const { past_rounds } = this.sql.exec<{ past_rounds: string }>("SELECT past_rounds FROM pnm WHERE id = ?", pnmId).one();
        const rounds = [...(JSON.parse(past_rounds) as Tally[]), tallies[pnmId] ?? { yes: 0, no: 0 }];
        this.sql.exec("UPDATE pnm SET in_revote = 1, past_rounds = ? WHERE id = ?", JSON.stringify(rounds), pnmId);
        this.sql.exec("DELETE FROM vote WHERE pnm_id = ?", pnmId);
      }
      this.sql.exec(
        "UPDATE room SET phase = 'live', focus_pnm_id = ?, revealed_pnm_id = NULL, revealed_yes = NULL, revealed_no = NULL, revote_spots = ?",
        tie.pnmIds[0]!,
        tie.spots,
      );
    });
    this.broadcastSnapshots();
  }

  private revealClass() {
    if (this.room().phase !== "ended") throw new Refusal("wrong_phase", "End voting before revealing the class.");
    if (this.results().tie) throw new Refusal("tie_unresolved", "Break the tie before revealing the class.");
    this.sql.exec("UPDATE room SET class_revealed = 1");
    this.sendToScreens({ type: "classRevealed", members: this.classMembers() });
  }

  private classMembers(): ClassMember[] {
    const { rows, cutLine } = this.results();
    const made = new Set(rows.slice(0, cutLine).map(({ pnmId }) => pnmId));
    return this.sql
      .exec<PnmRow>("SELECT * FROM pnm ORDER BY ordinal")
      .toArray()
      .filter(({ id }) => made.has(id))
      .map(({ id, name, photo_url }) => ({ pnmId: id, name, photoUrl: photo_url }));
  }

  private roomOrNull(): RoomRow | undefined {
    return this.sql.exec<RoomRow>("SELECT * FROM room").toArray()[0];
  }

  private room(): RoomRow {
    const room = this.roomOrNull();
    if (!room) throw new Error("Room was never claimed");
    return room;
  }

  private pnmCount(): number {
    return this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pnm").one().count;
  }

  // Everyone whose ballot counts, which includes kicked members who voted before removal.
  private ballotCount(): number {
    return this.sql
      .exec<{ count: number }>(`
        SELECT COUNT(*) AS count FROM member
        WHERE kicked = 0 OR EXISTS (SELECT 1 FROM vote WHERE vote.member_id = member.id)
      `)
      .one().count;
  }

  private effectiveBudget(): number {
    const count = this.pnmCount();
    const { yes_budget } = this.room();
    return yes_budget === 0 ? count : Math.min(yes_budget, count);
  }

  // A revote lifts the Yes limit: Yeses spent on other PNMs can't be cleared, and nobody should be locked out.
  private voteBudget(): number {
    return this.room().revote_spots === null ? this.effectiveBudget() : this.pnmCount();
  }

  private yesUsed(memberId: string): number {
    return this.sql
      .exec<{ used: number }>("SELECT COUNT(*) AS used FROM vote WHERE member_id = ? AND value = 'yes'", memberId)
      .one().used;
  }

  private members(): MemberInfo[] {
    return this.sql
      .exec<{ handle: string; name: string }>("SELECT handle, name FROM member WHERE kicked = 0 ORDER BY joined_at, rowid")
      .toArray();
  }

  private progress(pnmId: string): Progress {
    const { voted } = this.sql
      .exec<{ voted: number }>("SELECT COUNT(*) AS voted FROM vote WHERE pnm_id = ?", pnmId)
      .one();
    return { pnmId, voted, total: this.ballotCount() };
  }

  private tallies(): Record<string, Tally> {
    const tallies: Record<string, Tally> = {};
    const rows = this.sql.exec<{ id: string; yes: number; no: number }>(`
      SELECT pnm.id AS id,
             COUNT(CASE WHEN vote.value = 'yes' THEN 1 END) AS yes,
             COUNT(CASE WHEN vote.value = 'no' THEN 1 END) AS no
      FROM pnm LEFT JOIN vote ON vote.pnm_id = pnm.id
      GROUP BY pnm.id
    `);
    for (const { id, yes, no } of rows) tallies[id] = { yes, no };
    return tallies;
  }

  private revote(): Tie | null {
    const spots = this.room().revote_spots;
    if (spots === null) return null;
    const rows = this.sql.exec<{ id: string }>("SELECT id FROM pnm WHERE in_revote = 1 ORDER BY ordinal").toArray();
    return { pnmIds: rows.map(({ id }) => id), spots };
  }

  private revealed({ revealed_pnm_id, revealed_yes, revealed_no }: RoomRow): Revealed | null {
    if (revealed_pnm_id === null) return null;
    return { pnmId: revealed_pnm_id, yes: revealed_yes ?? 0, no: revealed_no ?? 0 };
  }

  private results(): Results {
    const tallies = this.tallies();
    const total = this.ballotCount();
    const pnms = this.sql.exec<PnmRow>("SELECT * FROM pnm ORDER BY ordinal").toArray();
    const ranked = pnms.map((pnm) => {
      const rounds = [...(JSON.parse(pnm.past_rounds) as Tally[]), tallies[pnm.id] ?? { yes: 0, no: 0 }];
      const { yes, no } = rounds[0]!;
      const row: ResultRow = {
        pnmId: pnm.id,
        name: pnm.name,
        photoUrl: pnm.photo_url,
        yes,
        no,
        noResponse: total - yes - no,
        total,
        percent: yes + no === 0 ? 0 : (yes / (yes + no)) * 100,
        revotes: rounds.slice(1),
      };
      return { row, rounds };
    });
    // Array.prototype.sort is stable, so remaining ties keep interview order.
    ranked.sort((a, b) => compareRounds(a.rounds, b.rounds));

    const cutLine = this.effectiveBudget();
    return { rows: ranked.map(({ row }) => row), cutLine, tie: findTie(ranked, cutLine) };
  }

  private snapshot({ role, memberId }: Attachment): Snapshot {
    const room = this.room();
    const isHost = role === "host";
    const where = isHost ? "" : "WHERE seen = 1";
    const pnms = this.sql.exec<PnmRow>(`SELECT * FROM pnm ${where} ORDER BY ordinal`).toArray().map(toPnm);

    const myVotes: Record<string, VoteValue> = {};
    if (memberId !== null) {
      const rows = this.sql.exec<{ pnm_id: string; value: VoteValue }>(
        "SELECT pnm_id, value FROM vote WHERE member_id = ?",
        memberId,
      );
      for (const { pnm_id, value } of rows) myVotes[pnm_id] = value;
    }

    return {
      type: "snapshot",
      role,
      code: room.code,
      phase: room.phase,
      yesBudget: this.voteBudget(),
      budgetIsDefault: room.yes_budget === 0 || room.revote_spots !== null,
      pnmCount: this.pnmCount(),
      joinLocked: room.join_locked === 1,
      focusPnmId: room.focus_pnm_id,
      pnms,
      members: this.members(),
      progress: room.focus_pnm_id ? this.progress(room.focus_pnm_id) : null,
      revealed: role !== "brother" ? this.revealed(room) : null,
      revote: this.revote(),
      classReveal: role !== "brother" && room.class_revealed ? this.classMembers() : null,
      myVotes,
      yesUsed: memberId === null ? 0 : this.yesUsed(memberId),
      ...(isHost && {
        hostOnly: {
          hostKey: room.host_key,
          projectorKey: room.projector_key,
          tallies: this.tallies(),
          results: room.phase === "ended" ? this.results() : null,
        },
      }),
    };
  }

  private attachment(ws: WebSocket): Attachment | null {
    return ws.deserializeAttachment() as Attachment | null;
  }

  private send(ws: WebSocket, message: ServerMessage) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // getWebSockets() can return a socket that is mid-close; it resyncs on rejoin.
    }
  }

  private broadcast(message: ServerMessage, except?: WebSocket) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except && this.attachment(socket)) this.send(socket, message);
    }
  }

  // Live tallies only ever take this path. Never widen it to other roles.
  private sendToHosts(message: ServerMessage) {
    for (const socket of this.ctx.getWebSockets()) {
      if (this.attachment(socket)?.role === "host") this.send(socket, message);
    }
  }

  // A tally the host chose to show the room: one point-in-time result, never a running count.
  private sendToScreens(message: ServerMessage) {
    for (const socket of this.ctx.getWebSockets()) {
      const role = this.attachment(socket)?.role;
      if (role === "host" || role === "projector") this.send(socket, message);
    }
  }

  private broadcastSnapshots() {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(socket);
      if (attachment) this.send(socket, this.snapshot(attachment));
    }
  }
}
