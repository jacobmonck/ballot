import type { Tally } from "../shared/protocol";

// Yes as a share of votes cast, 0 to 100. Brothers who didn't vote don't count against a PNM.
export function yesPercent({ yes, no }: Tally) {
  return yes + no === 0 ? 0 : (yes / (yes + no)) * 100;
}

export function formatPercent(percent: number) {
  return `${Number(percent.toFixed(1))}%`;
}
