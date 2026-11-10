import type { ClientMessage, PnmInput, PositionInput, QA } from "../shared/protocol";

// Size limits for everything a client can send.
const MAX_NAME = 80;
const MAX_ID = 64;
const MAX_PNMS = 500;
const MAX_CANDIDATES = 50;
const MAX_ANSWERS = 100;
const MAX_QUESTION = 2_000;
const MAX_ANSWER = 20_000;
const MAX_URL = 2_048;
const MAX_MESSAGE_CHARS = 16_000_000;
// Stays well under the 2 MB limit on one Durable Object SQLite row.
const MAX_ANSWERS_CHARS = 500_000;

// Trimmed text between 1 and `max` characters, or null.
function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();

  return text.length > 0 && text.length <= max ? text : null;
}

// A question must have text. An answer may be empty, since forms allow skipping.
function parseQA(value: unknown): QA | null {
  if (typeof value !== "object" || value === null) return null;

  const { q, a } = value as Record<string, unknown>;
  const question = shortText(q, MAX_QUESTION);
  if (question === null || typeof a !== "string" || a.length > MAX_ANSWER) return null;
  return { q: question, a };
}

// Null means no photo, and undefined means the photo is invalid, which rejects the whole PNM.
function parsePhotoUrl(value: unknown): string | null | undefined {
  if (value === null) return null;

  const text = shortText(value, MAX_URL);
  if (text === null || !URL.canParse(text)) return undefined;

  const { protocol } = new URL(text);
  // The page's CSP only loads https images.
  return protocol === "https:" ? text : undefined;
}

function parsePnm(value: unknown): PnmInput | null {
  if (typeof value !== "object" || value === null) return null;

  const { name, photoUrl, answers } = value as Record<string, unknown>;
  const cleanName = shortText(name, MAX_NAME);
  const cleanPhoto = parsePhotoUrl(photoUrl);
  if (cleanName === null || cleanPhoto === undefined) return null;
  if (!Array.isArray(answers) || answers.length > MAX_ANSWERS) return null;

  const cleanAnswers: QA[] = [];
  for (const answer of answers) {
    const qa = parseQA(answer);
    if (qa === null) return null;
    cleanAnswers.push(qa);
  }

  if (JSON.stringify(cleanAnswers).length > MAX_ANSWERS_CHARS) return null;
  return { name: cleanName, photoUrl: cleanPhoto, answers: cleanAnswers };
}

// Seats must leave at least one candidate out, and a name can't appear twice, so a ballot is never a formality.
function parsePosition(value: unknown): PositionInput | null {
  if (typeof value !== "object" || value === null) return null;

  const { title, seats, candidates } = value as Record<string, unknown>;
  const cleanTitle = shortText(title, MAX_NAME);
  if (cleanTitle === null || !Array.isArray(candidates) || candidates.length > MAX_CANDIDATES) return null;

  const names: string[] = [];
  for (const candidate of candidates) {
    const name = shortText(candidate, MAX_NAME);
    if (name === null) return null;
    names.push(name);
  }

  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) return null;
  if (!Number.isInteger(seats) || (seats as number) < 1 || (seats as number) > names.length - 1) return null;
  return { title: cleanTitle, seats: seats as number, candidates: names };
}

// Each role joins with its own credential: a key for the host and projector, an id and name for a brother.
function parseJoin(fields: Record<string, unknown>): ClientMessage | null {
  if (fields.as === "projector") {
    const projectorKey = shortText(fields.projectorKey, MAX_ID * 2);
    return projectorKey === null ? null : { type: "join", as: "projector", projectorKey };
  }
  if (fields.as === "host") {
    const hostKey = shortText(fields.hostKey, MAX_ID * 2);
    return hostKey === null ? null : { type: "join", as: "host", hostKey };
  }
  if (fields.as === "brother") {
    const memberId = shortText(fields.memberId, MAX_ID);
    const name = shortText(fields.name, MAX_NAME);
    return memberId === null || name === null ? null : { type: "join", as: "brother", memberId, name };
  }
  return null;
}

// Checks an untrusted socket message field by field. Anything malformed or oversized becomes null.
export function parseClientMessage(raw: string | ArrayBuffer): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_CHARS) return null;

  let fields: unknown;
  try {
    fields = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof fields !== "object" || fields === null) return null;

  const message = fields as Record<string, unknown>;

  switch (message.type) {
    case "join":
      return parseJoin(message);
    case "vote": {
      const pnmId = shortText(message.pnmId, MAX_ID);
      const { value } = message;
      if (pnmId === null || (value !== "yes" && value !== "no" && value !== null)) return null;
      return { type: "vote", pnmId, value };
    }
    case "importPnms": {
      const { pnms } = message;
      if (!Array.isArray(pnms) || pnms.length === 0 || pnms.length > MAX_PNMS) return null;
      const clean = pnms.map(parsePnm);
      return clean.every((pnm) => pnm !== null) ? { type: "importPnms", pnms: clean as PnmInput[] } : null;
    }
    case "setBudget": {
      const { yesBudget } = message;
      if (yesBudget !== null && !Number.isInteger(yesBudget)) return null;
      return { type: "setBudget", yesBudget: yesBudget as number | null };
    }
    case "setFocus": {
      const pnmId = shortText(message.pnmId, MAX_ID);
      return pnmId === null ? null : { type: "setFocus", pnmId };
    }
    case "reveal": {
      const pnmId = shortText(message.pnmId, MAX_ID);
      return pnmId === null ? null : { type: "reveal", pnmId };
    }
    case "setJoinLocked":
      return typeof message.locked === "boolean" ? { type: "setJoinLocked", locked: message.locked } : null;
    case "kick": {
      const handle = shortText(message.handle, MAX_ID);
      return handle === null ? null : { type: "kick", handle };
    }
    case "endSession":
      return { type: "endSession" };
    case "startRevote":
      return { type: "startRevote" };
    case "revealClass":
      return { type: "revealClass" };
    case "setMode":
      return message.mode === "recruitment" || message.mode === "election"
        ? { type: "setMode", mode: message.mode }
        : null;
    case "addPosition": {
      const position = parsePosition(message.position);
      return position === null ? null : { type: "addPosition", position };
    }
    case "updatePosition": {
      const positionId = shortText(message.positionId, MAX_ID);
      const position = parsePosition(message.position);
      return positionId === null || position === null ? null : { type: "updatePosition", positionId, position };
    }
    case "removePosition": {
      const positionId = shortText(message.positionId, MAX_ID);
      return positionId === null ? null : { type: "removePosition", positionId };
    }
    case "movePosition": {
      const positionId = shortText(message.positionId, MAX_ID);
      const { direction } = message;
      if (positionId === null || (direction !== -1 && direction !== 1)) return null;
      return { type: "movePosition", positionId, direction };
    }
    case "openRound": {
      const positionId = shortText(message.positionId, MAX_ID);
      return positionId === null ? null : { type: "openRound", positionId };
    }
    case "pick": {
      const positionId = shortText(message.positionId, MAX_ID);
      const { candidateIds, round } = message;
      if (!Number.isInteger(round) || (round as number) < 1) return null;
      if (positionId === null || !Array.isArray(candidateIds) || candidateIds.length > MAX_CANDIDATES) return null;
      const ids = candidateIds.map((id) => shortText(id, MAX_ID));
      return ids.every((id) => id !== null)
        ? { type: "pick", positionId, round: round as number, candidateIds: ids as string[] }
        : null;
    }
    case "closeRound": {
      const positionId = shortText(message.positionId, MAX_ID);
      return positionId === null ? null : { type: "closeRound", positionId };
    }
    case "revealWinners": {
      const positionId = shortText(message.positionId, MAX_ID);
      return positionId === null ? null : { type: "revealWinners", positionId };
    }
    case "revealSlate":
      return { type: "revealSlate" };
    default:
      return null;
  }
}
