import { isDrivePhoto } from "../shared/csv";
import type { VotingRoom } from "./room";

// Larger than any Drive thumbnail, which the host asks for at 800 pixels wide.
const MAX_PHOTO_BYTES = 5_000_000;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
// PNM photos are personal data, so browsers keep them in memory for the open page and never on disk.
const STORED_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export const PHOTO_PATH_PREFIX = "/photos/";

export type PhotoImportResult =
  | { status: "saved"; photoUrl: string }
  // Drive answered with something other than a photo, which is its sign-in page for a private file.
  | { status: "not_shared" }
  // Worth trying again, such as Drive slowing down a burst of requests.
  | { status: "unavailable" }
  | { status: "too_large" };

// The R2 key behind a stored photo address, or null for any other address.
export function photoKey(photoUrl: string): string | null {
  return photoUrl.startsWith(PHOTO_PATH_PREFIX) ? photoUrl.slice(PHOTO_PATH_PREFIX.length) : null;
}

// Streams a stored photo straight from R2.
export async function servePhoto(env: Env, key: string): Promise<Response> {
  const photo = await env.PHOTOS.get(key);
  if (!photo) return new Response("Not found", { status: 404 });

  return new Response(photo.body, {
    headers: { ...STORED_HEADERS, "Content-Type": photo.httpMetadata?.contentType ?? "application/octet-stream" },
  });
}

// Fetches a Drive thumbnail, or says why it isn't usable.
async function download(source: string): Promise<{ bytes: ArrayBuffer; type: string } | PhotoImportResult> {
  const response = await fetch(source);
  if (response.status === 429 || response.status >= 500) return { status: "unavailable" };

  const type = response.headers.get("Content-Type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || !PHOTO_TYPES.has(type)) return { status: "not_shared" };

  const bytes = await response.arrayBuffer();
  return bytes.byteLength > MAX_PHOTO_BYTES ? { status: "too_large" } : { bytes, type };
}

// Copies one PNM's Drive photo into R2 and points the PNM at the copy.
// Only Drive thumbnails are fetched, so this can't be pointed at an arbitrary address.
export async function importPhoto(
  env: Env,
  room: DurableObjectStub<VotingRoom>,
  code: string,
  hostKey: string,
  pnmId: string,
): Promise<PhotoImportResult | "forbidden" | "missing"> {
  const source = await room.photoSource(hostKey, pnmId);
  if (source === "forbidden" || source === "missing") return source;
  if (!isDrivePhoto(source)) return "missing";

  const downloaded = await download(source);
  if ("status" in downloaded) return downloaded;

  const key = `${code}/${crypto.randomUUID()}`;
  await env.PHOTOS.put(key, downloaded.bytes, { httpMetadata: { contentType: downloaded.type } });

  const photoUrl = `${PHOTO_PATH_PREFIX}${key}`;
  if (await room.savePhoto(hostKey, pnmId, source, photoUrl)) return { status: "saved", photoUrl };

  // The PNMs were replaced while this photo was downloading.
  await env.PHOTOS.delete(key);
  return "missing";
}
