import { ROOM_CODE_PATTERN } from "../shared/protocol";
import { generateKey, generateRoomCode } from "./code";
import { importPhoto, PHOTO_PATH_PREFIX, servePhoto } from "./photos";

export { VotingRoom } from "./room";

// Routes:
//   POST /api/rooms                        create a room
//   GET  /api/rooms/:code                  check a room exists
//   GET  /api/rooms/:code/ws               open the room's WebSocket
//   POST /api/rooms/:code/photos/:pnmId    copy a PNM's Drive photo into R2 (host only)
//   GET  /photos/:code/:id                 serve a stored photo
// Everything else falls through to the static client.

const MAX_CODE_ATTEMPTS = 8;
const ROOM_ROUTE = /^\/api\/rooms\/([^/]+)(\/ws)?$/;
const PHOTO_IMPORT_ROUTE = /^\/api\/rooms\/([^/]+)\/photos\/([0-9a-f-]{36})$/;
const STORED_PHOTO_ROUTE = /^\/photos\/([2-9A-HJKMNP-TV-Z]{6}\/[0-9a-f-]{36})$/;
const API_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: API_HEADERS });
}

// Limits count per Cloudflare location. Local runs have no client IP, so they aren't limited.
async function overLimit(limiter: RateLimit, request: Request): Promise<boolean> {
  const key = request.headers.get("CF-Connecting-IP");
  if (!key) return false;
  return !(await limiter.limit({ key })).success;
}

// Codes are random, so a collision just means drawing again.
async function createRoom(env: Env): Promise<Response> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const hostKey = generateKey();
    if (await env.ROOM.getByName(code).claim(code, hostKey, generateKey())) {
      return json({ code, hostKey }, 201);
    }
  }
  return json({ error: "Could not allocate a room code." }, 503);
}

async function handlePhotoImport(request: Request, env: Env, rawCode: string, pnmId: string): Promise<Response> {
  const code = rawCode.toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) return json({ error: "Invalid room code." }, 400);
  if (await overLimit(env.ROOM_ACCESS_LIMIT, request)) return json({ error: "Too many requests." }, 429);

  const hostKey = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const result = await importPhoto(env, env.ROOM.getByName(code), code, hostKey, pnmId);
  if (result === "forbidden") return json({ error: "Host key required." }, 403);
  if (result === "missing") return json({ error: "No Drive photo to save." }, 404);
  return json(result, result.status === "saved" ? 200 : 422);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname.startsWith(PHOTO_PATH_PREFIX)) {
      const key = STORED_PHOTO_ROUTE.exec(pathname)?.[1];
      return key ? servePhoto(env, key) : new Response("Not found", { status: 404 });
    }

    const photoImport = PHOTO_IMPORT_ROUTE.exec(pathname);
    if (photoImport && request.method === "POST") {
      return handlePhotoImport(request, env, photoImport[1]!, photoImport[2]!);
    }

    if (pathname === "/api/rooms" && request.method === "POST") {
      if (await overLimit(env.ROOM_CREATION_LIMIT, request)) return json({ error: "Too many new rooms." }, 429);
      return createRoom(env);
    }

    const roomMatch = ROOM_ROUTE.exec(pathname);
    if (roomMatch && request.method === "GET") {
      const code = roomMatch[1]!.toUpperCase();
      if (!ROOM_CODE_PATTERN.test(code)) return json({ error: "Invalid room code." }, 400);
      // Sized for a whole chapter on one wifi network, not for guessing room codes.
      if (await overLimit(env.ROOM_ACCESS_LIMIT, request)) return json({ error: "Too many requests." }, 429);
      const room = env.ROOM.getByName(code);
      if (roomMatch[2]) return room.fetch(request);
      return (await room.exists()) ? json({ code }) : json({ error: "Room not found." }, 404);
    }

    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;
