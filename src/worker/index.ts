import { ROOM_CODE_PATTERN } from "../shared/protocol";
import { generateKey, generateRoomCode } from "./code";

export { VotingRoom } from "./room";

const MAX_CODE_ATTEMPTS = 8;
const ROOM_ROUTE = /^\/api\/rooms\/([^/]+)(\/ws)?$/;
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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

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
