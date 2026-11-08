# Flick to vote and the pegboard reveal

## Why

The marbles are the part of the night people watch, but the room's two big moments are thin.
Casting a vote is a tap that feels like any other button, and the reveal sorts the pile in
about a second, so a close vote is over before anyone can react. This change makes casting a
vote a small physical act, and turns the reveal into something the room watches unfold, with
sound, so a close vote stays tense until the last marble lands.

A throwaway spike showed both ideas with sound, and the user liked it. It's saved next to this
document as `2026-11-08-flick-and-pegboard-spike.html` (open it in a browser and click "Start with
sound"). Treat its sounds, marble finishes, slow-finish timing and flick feel as the approved
starting point; its physics is not, for the reasons under Anti-goals. This document describes the
real version.

## Goals

- Casting a vote feels physical: you flick your marble off the phone and it lands on the projector.
- The reveal builds suspense: marbles drop one at a time through a pegboard into Yes and No bins,
  and the counts climb with them.
- The projector has sound for every marble moment.

## Non-goals

- No change to how votes are counted, stored or validated on the server, or to the protocol.
- No change to the lobby or the class finale, apart from optional sound on their existing marbles.
- No sound on phones.
- No pass line, turnout ring or other ideas from the brainstorm that weren't picked.

## Anti-goals (a failure even if it works)

- **Anything on screen or in sound before the reveal hints at how anyone voted.** Every marble
  is gold and makes the same sound until the host reveals. Arrival time already shows that someone
  voted, and that's fine; it must never show which way.
- **A marble lands in the wrong bin, or a bin's count disagrees with the tally.** The pile is the
  result. The spike's physics occasionally put marbles in the wrong bin or teleported them across;
  the real version must not.
- **The drop looks like luck decides the outcome.** The pegs add bounce, not chance. Nothing about
  the board should suggest a marble could have gone either way once it's colored.
- **Voting gets harder.** A flick that fails on a cheap phone, or a brother who can't drag, must
  still be able to vote.

## Phone: flick to vote

Today `VoteButtons` sends the vote on tap. The new flow on the ballot (`Brother.tsx` →
`VoteButtons.tsx`):

1. Tapping Yes or No **picks** a side. Nothing is sent yet. The picked marble moves to the center
   and grows; the other one fades out with a way to switch ("Pick No" / "Pick Yes"). A slot appears
   above it with a nudging "Flick it up to cast" hint.
2. Flicking the picked marble up **casts** the vote: it flies off the top with the existing haptic,
   and the `vote` message is sent. A **plain tap on the picked marble also casts** (the user agreed
   to this fallback).
3. After casting, the phone shows a small marble in the color of the vote cast, with "Your Yes is
   in" or "Your No is in", and "Change my vote". The phone keeps showing a brother his own vote,
   as it does today; the "All PNMs" list is unchanged. Only the projector hides it. (My call: the
   spike showed a gold marble, but hiding the choice on your own phone would leave brothers unsure
   what they cast.) Changing goes back to step 1 and the new pick is cast the same way. "Clear my vote"
   keeps working as today.
4. Phones make no sound.

This applies to every PNM a brother votes on, including ones they browse back to, and to revotes.
The existing rules still hold: Yes is disabled when the budget is spent, the controls are disabled
for `PNM_CHANGE_GUARD_MS` after the PNM changes, and the "Sending your vote" state still shows
while a vote is pending. A brother who already voted on this PNM sees the "Your marble is in"
state when the ballot opens.

The flick gesture is a vertical drag on the picked marble. The card above it already takes
horizontal drags to move between PNMs, so the two must not fight.

With reduced motion on, tapping Yes or No casts immediately, as today.

## Projector: votes coming in

Unchanged in look: the PNM spotlight with the gold pile growing at the bottom. Each new marble
lands with a glass clack whose pitch climbs as the pile fills toward the room's size. Every clack
is the same regardless of the vote.

## Projector: the pegboard reveal

Replaces today's reveal, where the pile turns white and black and rolls to either side.

1. **Host presses Reveal.** The spotlight slides off and the pegboard takes the whole screen. The
   gold pile already on screen rises into a hopper at the top, so the room sees the same ballots,
   not a new set.
2. **The drop.** Marbles leave the hopper one at a time through a spout. Each turns white (Yes) or
   black (No) as it leaves, then rattles down a triangle of pegs into a Yes bin (left) or No bin
   (right). Pegs glow briefly when hit. Large Yes and No counts beside the bins go up as each marble
   lands. The order of Yes and No marbles is shuffled.
3. **Slow finish.** The last five marbles fall with growing gaps between them, as in the spike.
4. **Result.** When the last marble settles, a bell chord plays and the percentage appears
   ("68% Yes"), using the same percent as the results screen: Yes as a share of votes cast.
   The bins use the tally frozen at the moment of the reveal (`revealed` in the snapshot), not the
   live count. If that differs from the gold pile on screen, the hopper quietly adds or drops
   marbles before the drop starts. Then
   the PNM's photo and name come back in next to it, so the room sees who the number belongs to.
   The bins stay full behind them. "N didn't vote" shows as it does today.
5. **Host presses Next.** If the drop is still running, it stops and everything drains at once;
   the host stays in control and the host screen already shows the counts. (My call.) The bins drain the way the pile drains today, and the next PNM comes up.
   Revotes reveal the same way.

The outcome is fixed before the first drop. Each marble's path through the pegs is planned from the
start so it ends in its own bin with no visible correction. Physics only decides how it bounces,
never where it ends up.

**Joining mid-reveal.** If the projector connects or reconnects while a PNM is already revealed,
it shows the finished state (full bins, percentage, photo and name) without replaying the drop.
Only a reveal that happens while the projector is watching plays the drop.

**No votes.** If nobody voted, skip the drop and show the result as today.

**Reduced motion.** Skip the drop and show the finished state, with the bell.

### Sounds (projector only)

Made with the Web Audio API, no audio files, as in the spike:

- **Clack:** a marble landing while votes come in, pitch rising with the pile.
- **Tock:** the hopper letting a marble go.
- **Tick:** a marble hitting a peg, louder for harder hits, rate-limited so many hits don't become noise.
- **Thud:** a marble landing in a bin. Yes and No differ slightly in pitch; this is fine because it
  only happens after the reveal.
- **Bell:** the result locking in.

Browsers block audio until someone clicks, so the projector shows a one-time "Turn on sound"
button. Once clicked, sound stays on for the rest of the session on that screen, with a small
mute toggle in a corner.

## What exists to build on

- `src/client/marblePile.ts`: the pile simulation, including `drain()` and `reveal()`. The
  pegboard replaces `reveal()`'s sort.
- `src/client/components/MarblePit.tsx`: canvas, marble sprites (gold, white and black finishes)
  and the sleep-when-settled loop, which keeps the projector laptop cool. Keep that behavior.
- `src/client/screens/Projector.tsx`: `Stage`, `Spotlight` and `Verdict`.
- `src/client/components/VoteButtons.tsx` and `src/client/feel.ts`: the ballot buttons, springs
  and haptics.
- The spike's sound recipes and finishes are a good starting point for tone and timing.

## Left to the builder

- Peg layout, marble size and timing, including scaling for big rooms so the drop stays roughly
  10–20 seconds no matter how many voted. (My call; the spike only tried 40–62 voters.)
- How paths are planned, and how the hopper and pile hand-off look.
- How the projector tells a live reveal from one it loaded already revealed.
- Exact flick thresholds, and how the picked state looks between picking and casting.
- Where the sound toggle sits and how it looks.
- Tests: the planned-path logic and the count/tally agreement should have unit tests.
