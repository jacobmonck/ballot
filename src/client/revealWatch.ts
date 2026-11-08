import type { Connection } from "./roomState";

// Tells a reveal the projector watched happen, which plays the drop, from one it found already done
// on load or after a dropped connection, which shows the finished board. Returns the PNM this screen
// has seen unrevealed while connected, or null. A reveal is live when it's for that PNM.
export function watchReveal(
  watched: string | null,
  pnmId: string | null,
  revealed: boolean,
  connection: Connection,
): string | null {
  if (connection !== "open" || !pnmId) return null;
  if (!revealed) return pnmId;
  return watched === pnmId ? watched : null;
}
