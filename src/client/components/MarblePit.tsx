import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { MarblePile } from "../marblePile";

const MAX_MARBLES = 400;
const PILE_SHARE_OF_SCREEN = 0.1;
const MIN_RADIUS_OF_WIDTH = 0.006;
const MAX_RADIUS_OF_WIDTH = 0.015;
const MAX_DPR = 2;
const SPRITE_SIZE = 128;
const SHADOW_SCALE = 1.3;
const SHADOW_DROP = 0.22;
const MAX_FRAME_S = 1 / 30;
const QUIET_FRAMES_BEFORE_SLEEP = 30;

function radiusFor(capacity: number) {
  const { innerWidth: width, innerHeight: height } = window;
  const fit = Math.sqrt((width * height * PILE_SHARE_OF_SCREEN) / (Math.min(capacity, MAX_MARBLES) * Math.PI));
  return Math.min(width * MAX_RADIUS_OF_WIDTH, Math.max(width * MIN_RADIUS_OF_WIDTH, fit));
}

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

function radial(context: CanvasRenderingContext2D, x: number, y: number, from: number, to: number, stops: [number, string][]) {
  const gradient = context.createRadialGradient(x, y, from, x, y, to);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  return gradient;
}

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

  context.fillStyle = radial(context, center, center, radius * 0.6, radius, [
    [0, "rgb(0 0 0 / 0)"],
    [1, edge],
  ]);
  context.fillRect(0, 0, size, size);

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

export function MarblePit({
  scene,
  count,
  capacity,
  yesShown,
  celebrate,
}: {
  scene: string;
  count: number;
  capacity: number;
  // Null keeps every marble gold: until the host reveals, the screen only shows that a ballot landed.
  yesShown: number | null;
  celebrate: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const canvas = useRef<HTMLCanvasElement>(null);
  const pile = useRef<MarblePile | null>(null);
  const wake = useRef<() => void>(() => {});
  const shownScene = useRef(scene);
  const revealedScene = useRef<string | null>(null);

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

    const draw = () => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
      // Shadows go down first so they settle into the gaps of the pile, not over its marbles.
      for (const { x, y, radius, alpha } of simulation.marbles) {
        const reach = radius * SHADOW_SCALE;
        context.globalAlpha = Math.max(0, alpha);
        context.drawImage(shadow, x - reach, y - reach + radius * SHADOW_DROP, reach * 2, reach * 2);
      }
      for (const { x, y, radius, alpha, side, flip } of simulation.marbles) {
        const opacity = Math.max(0, alpha);
        context.globalAlpha = opacity;
        if (flip < 1) context.drawImage(gold, x - radius, y - radius, radius * 2, radius * 2);
        if (side && flip > 0) {
          context.globalAlpha = opacity * flip;
          context.drawImage(sideSprite[side], x - radius, y - radius, radius * 2, radius * 2);
        }
      }
    };

    const tick = (now: number) => {
      const moving = simulation.step(Math.min((now - last) / 1000, MAX_FRAME_S));
      last = now;
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
    };
  }, [reducedMotion]);

  useEffect(() => {
    const simulation = pile.current;
    if (!simulation) return;
    if (shownScene.current !== scene) {
      shownScene.current = scene;
      simulation.drain();
    }
    const scale = capacity > MAX_MARBLES ? MAX_MARBLES / capacity : 1;
    simulation.setTarget(Math.round(count * scale), radiusFor(capacity));
    if (yesShown !== null && revealedScene.current !== scene) {
      revealedScene.current = scene;
      simulation.reveal(Math.round(yesShown * scale));
    } else if (yesShown === null) {
      revealedScene.current = null;
    }
    wake.current();
  }, [scene, count, capacity, yesShown, reducedMotion]);

  useEffect(() => {
    if (!celebrate) return;
    pile.current?.hop();
    wake.current();
  }, [celebrate, scene]);

  if (reducedMotion) return null;
  return <canvas ref={canvas} className="absolute inset-0 size-full" />;
}
