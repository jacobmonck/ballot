import { ROOM_CODE_LENGTH } from "../shared/protocol";

// Crockford base32 minus 0/1 and U, so a code read off a projector cannot be mistyped.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

export function generateRoomCode(): string {
  let code = "";
  while (code.length < ROOM_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH * 2))) {
      if (byte < UNBIASED_LIMIT && code.length < ROOM_CODE_LENGTH) {
        code += ALPHABET[byte % ALPHABET.length];
      }
    }
  }
  return code;
}

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
