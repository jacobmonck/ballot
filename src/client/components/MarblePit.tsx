import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import type { Tally } from "../../shared/protocol";
import { MarblePile } from "../marblePile";
import { BOARD_HEIGHT, BOARD_WIDTH, layoutBoard, MAX_MARBLES, type Rect, shuffleSides } from "../pegboard";
import { type DropMarble, marbleSides, PegboardRun, shownCount } from "../pegboardRun";
import { sound } from "../sound";

// The pile: how much of the screen a full pile covers, and how big a marble may get.
const PILE_SHARE_OF_SCREEN = 0.1;
const MIN_RADIUS_OF_WIDTH = 0.006;
const MAX_RADIUS_OF_WIDTH = 0.015;

// Drawing
const MAX_DPR = 2;
const SPRITE_SIZE = 128;
const SHADOW_SCALE = 1.3;
const SHADOW_DROP = 0.22;

// The frame loop
const MAX_FRAME_S = 1 / 30;
const QUIET_FRAMES_BEFORE_SLEEP = 30;

// The pegboard, in its own 1600 by 900 space.
const BOARD_DIM = 0.85;
const BOARD_DIM_S = 0.6;
const TRAY_PADDING = 6;
const SPOUT_HALF_WIDTH = 16;
const BIN_LIP = 30;
const COUNT_X = { yes: 290, no: 1310 };
const COUNT_LABEL_Y = 650;
const COUNT_Y = 750;

// The marble size that lets a full room's pile cover its share of the screen.
function radiusFor(capacity: number) {
  const { innerWidth: width, innerHeight: height } = window;
  const fit = Math.sqrt((width * height * PILE_SHARE_OF_SCREEN) / (Math.min(capacity, MAX_MARBLES) * Math.PI));
  return Math.min(width * MAX_RADIUS_OF_WIDTH, Math.max(width * MIN_RADIUS_OF_WIDTH, fit));
}

// How one kind of marble is painted.
interface Finish {
  body: readonly [light: string, mid: string, dark: string];
  // Darkens the edge so the disc reads as a sphere.
  edge: string;
  // Light thrown back up from the pile onto the lower right.
  bounce: string;
  gloss: string;
  outline?: string;
}

const GOLD: Finish = {
  body: ["#fff0bf", "#dcb456", "#7c5a18"],
  edge: "rgb(58 36 6 / 0.75)",
  bounce: "rgb(255 208 120 / 0.55)",
  gloss: "rgb(255 252 236 / 0.95)",
};

const WHITE: Finish = {
  body: ["#ffffff", "#efe9da", "#a9a18c"],
  edge: "rgb(84 74 52 / 0.55)",
  bounce: "rgb(255 246 222 / 0.7)",
  gloss: "rgb(255 255 255 / 1)",
};

const BLACK: Finish = {
  body: ["#4d5249", "#191c17", "#050604"],
  edge: "rgb(0 0 0 / 0.8)",
  bounce: "rgb(150 158 142 / 0.4)",
  gloss: "rgb(244 246 238 / 0.9)",
  outline: "rgb(245 241 230 / 0.32)",
};

// A radial gradient with its color stops already added.
function radial(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  from: number,
  to: number,
  stops: [number, string][],
) {
  const gradient = context.createRadialGradient(x, y, from, x, y, to);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  return gradient;
}

// Paints one marble onto a small canvas once, so each frame only has to copy it.
function createSprite({ body, edge, bounce, gloss, outline }: Finish) {
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = SPRITE_SIZE;
  const context = sprite.getContext("2d")!;
  const center = SPRITE_SIZE / 2;
  const radius = center - 1.5;
  const size = SPRITE_SIZE;

  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.save();
  context.clip();

  // Lit from the upper left, to match the highlight below.
  const lit = context.createRadialGradient(center * 0.7, center * 0.58, 0, center, center, radius * 1.08);
  lit.addColorStop(0, body[0]);
  lit.addColorStop(0.42, body[1]);
  lit.addColorStop(1, body[2]);
  context.fillStyle = lit;
  context.fillRect(0, 0, size, size);

  // The darker edge.
  context.fillStyle = radial(context, center, center, radius * 0.6, radius, [
    [0, "rgb(0 0 0 / 0)"],
    [1, edge],
  ]);
  context.fillRect(0, 0, size, size);

  // The bounce light on the lower right.
  context.fillStyle = radial(context, center * 1.34, center * 1.46, 0, radius * 0.62, [
    [0, bounce],
    [1, "rgb(0 0 0 / 0)"],
  ]);
  context.fillRect(0, 0, size, size);

  // A soft window of light with a tight hot spot inside it.
  context.translate(center * 0.68, center * 0.56);
  context.rotate(-Math.PI / 5);
  context.scale(1, 0.62);
  context.fillStyle = radial(context, 0, 0, 0, radius * 0.42, [
    [0, gloss],
    [0.35, gloss],
    [1, "rgb(255 255 255 / 0)"],
  ]);
  context.globalAlpha = 0.6;
  context.fillRect(-size, -size, size * 2, size * 2);

  context.globalAlpha = 1;
  context.fillStyle = radial(context, 0, 0, 0, radius * 0.16, [
    [0, gloss],
    [0.6, gloss],
    [1, "rgb(255 255 255 / 0)"],
  ]);
  context.fillRect(-size, -size, size * 2, size * 2);
  context.restore();

  if (outline) {
    context.beginPath();
    context.arc(center, center, radius - 0.5, 0, Math.PI * 2);
    context.strokeStyle = outline;
    context.lineWidth = 1.5;
    context.stroke();
  }

  return sprite;
}

// The soft shadow drawn under every marble.
function createShadow() {
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = SPRITE_SIZE;
  const context = sprite.getContext("2d")!;
  const center = SPRITE_SIZE / 2;

  context.fillStyle = radial(context, center, center, center * 0.45, center, [
    [0, "rgb(0 0 0 / 0.5)"],
    [1, "rgb(0 0 0 / 0)"],
  ]);
  context.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  return sprite;
}

// A pegboard drop in progress, or finished and on show.
interface Drop {
  run: PegboardRun;
  tally: Tally;
  planned: Tally;
  // 0 while the drop runs, rising to 1 as the pegs and hopper dim behind the result.
  fade: number;
}

// Where the 1600 by 900 board sits on screen: as large as fits, centered.
function boardFit() {
  const scale = Math.min(window.innerWidth / BOARD_WIDTH, window.innerHeight / BOARD_HEIGHT);

  return {
    scale,
    x: (window.innerWidth - BOARD_WIDTH * scale) / 2,
    y: (window.innerHeight - BOARD_HEIGHT * scale) / 2,
  };
}

// Starts a path around a rectangle with rounded corners.
function roundedRect(context: CanvasRenderingContext2D, { left, right, top, bottom }: Rect, radius: number) {
  context.beginPath();
  context.roundRect(left, top, right - left, bottom - top, radius);
}

// Draws the tray, pegs, bins and counts. The marbles go on top separately.
function drawBoard(context: CanvasRenderingContext2D, { run, tally, planned, fade }: Drop) {
  const { board } = run;
  const dim = 1 - BOARD_DIM * fade;

  // The hopper tray and its spout.
  context.globalAlpha = dim;
  roundedRect(context, { ...board.tray, top: board.tray.top - TRAY_PADDING, bottom: board.tray.bottom + 2 }, 18);
  context.fillStyle = "rgb(247 244 236 / 0.04)";
  context.fill();
  context.strokeStyle = "rgb(247 244 236 / 0.12)";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "rgb(247 244 236 / 0.12)";
  context.fillRect(board.spout.x - SPOUT_HALF_WIDTH, board.tray.bottom + 2, SPOUT_HALF_WIDTH * 2, 8);

  // Pegs light up for a moment when a marble hits them.
  board.pegs.forEach(({ x, y }, index) => {
    const glow = run.pegGlow[index]!;

    context.beginPath();
    context.arc(x, y, board.pegRadius, 0, Math.PI * 2);
    context.fillStyle = `rgb(${200 + 55 * glow} ${180 + 50 * glow} ${120 + 40 * glow})`;
    context.fill();

    if (glow > 0.05) {
      context.beginPath();
      context.arc(x, y, board.pegRadius + 8 * glow, 0, Math.PI * 2);
      context.fillStyle = `rgb(227 193 111 / ${0.25 * glow})`;
      context.fill();
    }
  });
  context.globalAlpha = 1;

  // The two bins, which share a middle wall. They stay bright while the rest dims.
  const { yes, no } = board.bins;
  context.strokeStyle = "rgb(247 244 236 / 0.14)";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(yes.left, yes.top - BIN_LIP);
  context.lineTo(yes.left, yes.bottom);
  context.lineTo(no.right, no.bottom);
  context.lineTo(no.right, no.top - BIN_LIP);
  context.moveTo((yes.right + no.left) / 2, yes.top + BIN_LIP / 3);
  context.lineTo((yes.right + no.left) / 2, yes.bottom);
  context.stroke();

  // Each bin's label and count, which climbs as marbles land.
  const display = getComputedStyle(document.documentElement).getPropertyValue("--font-display");
  const sans = getComputedStyle(document.documentElement).getPropertyValue("--font-sans");
  context.textAlign = "center";
  for (const [side, label, x] of [
    ["yes", "YES", COUNT_X.yes],
    ["no", "NO", COUNT_X.no],
  ] as const) {
    context.font = `600 24px ${sans}`;
    context.fillStyle = "rgb(174 172 167 / 0.9)";
    context.fillText(label, x, COUNT_LABEL_Y);

    context.font = `700 96px ${display}`;
    context.fillStyle = "#f7f4ec";
    context.fillText(String(shownCount(run.landed[side], planned[side], tally[side])), x, COUNT_Y);
  }
}

// A canvas of marbles driven by MarblePile, or by a pegboard drop once the host reveals. The loop
// sleeps once nothing moves.
export function MarblePit({
  scene,
  count,
  capacity,
  reveal,
  celebrate,
  clacks,
  onDropDone,
}: {
  scene: string;
  count: number;
  capacity: number;
  // Null keeps every marble gold: until the host reveals, the screen only shows that a ballot landed.
  // `live` plays the drop; otherwise the board appears already finished.
  reveal: { tally: Tally; live: boolean } | null;
  celebrate: boolean;
  // Clack as each ballot lands. Every landing sounds the same, so this can't hint at a vote.
  clacks: boolean;
  // Called once a live drop has finished and its bell has rung.
  onDropDone?: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const canvas = useRef<HTMLCanvasElement>(null);
  const pile = useRef<MarblePile | null>(null);
  const drop = useRef<Drop | null>(null);
  // Restarts the frame loop after it went to sleep. Replaced once the canvas is ready.
  const wake = useRef<() => void>(() => {});
  const shownScene = useRef(scene);
  const revealedScene = useRef<string | null>(null);

  // Read inside the frame loop, so they're kept in refs rather than restarting it.
  const clackPitch = useRef<((live: number) => number) | null>(null);
  clackPitch.current = clacks ? (live) => live / Math.min(capacity, MAX_MARBLES) : null;
  const dropDone = useRef(onDropDone);
  dropDone.current = onDropDone;

  // Sets up the canvas, the sprites and the frame loop.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;

    const context = element.getContext("2d")!;
    const gold = createSprite(GOLD);
    const sideSprite = { yes: createSprite(WHITE), no: createSprite(BLACK) };
    const shadow = createShadow();
    const simulation = new MarblePile();
    pile.current = simulation;

    let dpr = 1;
    let frame: number | null = null;
    let last = 0;
    let quietFrames = 0;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio, MAX_DPR);
      element.width = window.innerWidth * dpr;
      element.height = window.innerHeight * dpr;
      simulation.resize(window.innerWidth, window.innerHeight);
      wake.current();
    };

    const drawMarbles = (marbles: readonly DropMarble[]) => {
      // Shadows go down first so they settle into the gaps of the pile, not over its marbles.
      for (const { x, y, radius, alpha } of marbles) {
        const reach = radius * SHADOW_SCALE;
        context.globalAlpha = Math.max(0, alpha);
        context.drawImage(shadow, x - reach, y - reach + radius * SHADOW_DROP, reach * 2, reach * 2);
      }
      for (const { x, y, radius, alpha, side, flip } of marbles) {
        const opacity = Math.max(0, alpha);
        context.globalAlpha = opacity;
        if (flip < 1) context.drawImage(gold, x - radius, y - radius, radius * 2, radius * 2);
        if (side && flip > 0) {
          context.globalAlpha = opacity * flip;
          context.drawImage(sideSprite[side], x - radius, y - radius, radius * 2, radius * 2);
        }
      }
      context.globalAlpha = 1;
    };

    // The board and its marbles are drawn in board space, then the pile on top in screen space.
    const draw = () => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);

      const current = drop.current;
      if (current) {
        const fit = boardFit();
        context.setTransform(dpr * fit.scale, 0, 0, dpr * fit.scale, dpr * fit.x, dpr * fit.y);
        drawBoard(context, current);
        drawMarbles(current.run.marbles);
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      drawMarbles(simulation.marbles);
    };

    // Advances the drop and plays its sounds. Returns whether anything is still moving.
    const playDrop = (current: Drop, dt: number) => {
      for (const event of current.run.step(dt)) {
        if (event.type === "tock") sound.tock();
        else if (event.type === "tick") sound.tick(event.strength);
        else if (event.type === "thud") sound.thud(event.side);
        else {
          sound.bell();
          dropDone.current?.();
        }
      }

      if (current.run.done && current.fade < 1) current.fade = Math.min(1, current.fade + dt / BOARD_DIM_S);
      return current.run.moving || (current.run.done && current.fade < 1);
    };

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, MAX_FRAME_S);
      last = now;

      let moving = simulation.step(dt);
      const landings = simulation.takeLandings();
      if (landings && clackPitch.current) {
        const pitch = clackPitch.current(simulation.marbles.filter(({ draining }) => !draining).length);
        for (let landing = 0; landing < landings; landing++) sound.clack(pitch);
      }
      if (drop.current && playDrop(drop.current, dt)) moving = true;

      draw();

      quietFrames = moving ? 0 : quietFrames + 1;
      // A settled pile needs no frames, which keeps a laptop on the projector cool all night.
      frame = quietFrames < QUIET_FRAMES_BEFORE_SLEEP ? requestAnimationFrame(tick) : null;
    };

    wake.current = () => {
      quietFrames = 0;
      if (frame !== null) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };

    resize();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      if (frame !== null) cancelAnimationFrame(frame);
      wake.current = () => {};
      pile.current = null;
      drop.current?.run.cancel();
      drop.current = null;
      revealedScene.current = null;
    };
  }, [reducedMotion]);

  // Keeps the pile in step with the props: a new scene drains it, a reveal starts a drop, and
  // otherwise it fills to `count`.
  useEffect(() => {
    const simulation = pile.current;
    if (!simulation) return;

    if (shownScene.current !== scene) {
      shownScene.current = scene;
      // Next mid-drop stops it where it is and lets the board's marbles fall away with the pile.
      const current = drop.current;
      if (current) {
        current.run.cancel();
        const fit = boardFit();
        simulation.absorb(
          current.run.marbles.map(({ x, y, radius, side }) => ({
            x: fit.x + x * fit.scale,
            y: fit.y + y * fit.scale,
            radius: radius * fit.scale,
            side,
          })),
        );
        drop.current = null;
      }
      simulation.drain();
    }

    if (reveal && revealedScene.current !== scene) {
      revealedScene.current = scene;
      const { tally, live } = reveal;

      if (tally.yes + tally.no > 0) {
        // The marbles already on the pile are the ones that drop, starting from where they sit.
        const planned = marbleSides(tally);
        const board = layoutBoard(planned);
        const sides = shuffleSides(planned);
        const fit = boardFit();
        const from = simulation
          .takeAll()
          .map(({ x, y }) => ({ x: (x - fit.x) / fit.scale, y: (y - fit.y) / fit.scale }));
        const run = live ? new PegboardRun(board, sides, from) : PegboardRun.finished(board, sides);
        drop.current = { run, tally, planned, fade: live ? 0 : 1 };
      }
    } else if (!reveal) {
      revealedScene.current = null;
    }

    if (!drop.current) {
      const scale = capacity > MAX_MARBLES ? MAX_MARBLES / capacity : 1;
      simulation.setTarget(Math.round(count * scale), radiusFor(capacity));
    }

    wake.current();
  }, [scene, count, capacity, reveal, reducedMotion]);

  // The pile hops once when every vote is in.
  useEffect(() => {
    if (!celebrate) return;
    pile.current?.hop();
    wake.current();
  }, [celebrate, scene]);

  if (reducedMotion) return null;

  return <canvas ref={canvas} className="absolute inset-0 size-full" />;
}
