import type { ClientMessage, PnmInput, QA } from "../shared/protocol";

// Size limits for everything a client can send.
const MAX_NAME = 80;
const MAX_ID = 64;
const MAX_PNMS = 500;
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
    default:
      return null;
  }
}
