import { ROOM_CODE_PATTERN } from "../shared/protocol";
import { generateHostKey, generateRoomCode } from "./code";

export { VotingRoom } from "./room";

const MAX_CODE_ATTEMPTS = 8;
const ROOM_ROUTE = /^\/api\/rooms\/([^/]+)(\/ws)?$/;

async function createRoom(env: Env): Promise<Response> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const hostKey = generateHostKey();
    if (await env.ROOM.getByName(code).claim(code, hostKey)) {
      return Response.json({ code, hostKey }, { status: 201 });
    }
  }
  return Response.json({ error: "Could not allocate a room code." }, { status: 503 });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/rooms" && request.method === "POST") return createRoom(env);

    const roomMatch = ROOM_ROUTE.exec(pathname);
    if (roomMatch && request.method === "GET") {
      const code = roomMatch[1]!.toUpperCase();
      if (!ROOM_CODE_PATTERN.test(code)) return Response.json({ error: "Invalid room code." }, { status: 400 });
      const room = env.ROOM.getByName(code);
      if (roomMatch[2]) return room.fetch(request);
      return (await room.exists())
        ? Response.json({ code })
        : Response.json({ error: "Room not found." }, { status: 404 });
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
