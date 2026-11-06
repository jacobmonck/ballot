// Storage can throw in private windows; the app then works until the tab reloads.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to fall back to.
  }
}

// A ballot belongs to a name on this phone, so a brother borrowing it gets their own
// ballot and the owner can return to theirs by typing their name again.
export function memberIdentity(code: string): { memberId: string; name: string } | null {
  const name = read(`voting:${code}:name`);
  if (!name) return null;
  const key = `voting:${code}:member:${name.toLowerCase()}`;
  let memberId = read(key);
  if (!memberId) {
    memberId = crypto.randomUUID();
    write(key, memberId);
  }
  return { memberId, name };
}

export function saveName(code: string, name: string) {
  write(`voting:${code}:name`, name);
}

export function loadHostKey(code: string): string | null {
  return read(`voting:${code}:host`);
}

export function saveHostKey(code: string, hostKey: string) {
  write(`voting:${code}:host`, hostKey);
}
