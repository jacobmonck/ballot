import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { MarblePile } from "../marblePile";

const MAX_MARBLES = 400;
const PILE_SHARE_OF_SCREEN = 0.1;
const MIN_RADIUS_OF_WIDTH = 0.006;
const MAX_RADIUS_OF_WIDTH = 0.015;
const MAX_DPR = 2;
const SPRITE_SIZE = 96;
const MAX_FRAME_S = 1 / 30;
const QUIET_FRAMES_BEFORE_SLEEP = 30;

function radiusFor(capacity: number) {
  const { innerWidth: width, innerHeight: height } = window;
  const fit = Math.sqrt((width * height * PILE_SHARE_OF_SCREEN) / (Math.min(capacity, MAX_MARBLES) * Math.PI));
  return Math.min(width * MAX_RADIUS_OF_WIDTH, Math.max(width * MIN_RADIUS_OF_WIDTH, fit));
}

const GOLD = ["#fff3cf", "#e3c16f", "#8f6f26"] as const;
const WHITE = ["#ffffff", "#f5f1e6", "#b9b2a0"] as const;
const BLACK = ["#6a6f66", "#23261f", "#060705"] as const;

function createSprite(colors: readonly [string, string, string], rim?: string) {
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = SPRITE_SIZE;
  const context = sprite.getContext("2d")!;
  const center = SPRITE_SIZE / 2;
  const gradient = context.createRadialGradient(center * 0.68, center * 0.56, 0, center, center, center);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(0.46, colors[1]);
  gradient.addColorStop(1, colors[2]);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(center, center, center - 2, 0, Math.PI * 2);
  context.fill();
  if (rim) {
    context.strokeStyle = rim;
    context.lineWidth = 2;
    context.stroke();
  }
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
    const sideSprite = { yes: createSprite(WHITE), no: createSprite(BLACK, "rgb(245 241 230 / 0.45)") };
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
