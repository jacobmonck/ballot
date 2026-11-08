import { useSyncExternalStore } from "react";
import type { Side } from "./pegboard";

// The projector's sounds, synthesized with Web Audio so there are no files to load. Phones never
// import this. Every call is silent until someone turns sound on, because browsers block audio
// until a click.

export type SoundStatus = "off" | "on" | "muted";

const MUTED_KEY = "ballot.soundMuted";
const TICK_GAP_S = 0.018;

let context: AudioContext | null = null;
let output: GainNode | null = null;
let noise: AudioBuffer | null = null;
let lastTick = 0;
let status: SoundStatus = "off";
const listeners = new Set<() => void>();

function setStatus(next: SoundStatus) {
  status = next;
  for (const listener of listeners) listener();
}

function rememberedMute() {
  try {
    return sessionStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberMute(muted: boolean) {
  try {
    sessionStorage.setItem(MUTED_KEY, muted ? "1" : "0");
  } catch {
    // Private windows can refuse storage. Sound still toggles for this page.
  }
}

// Must run inside a click, or the browser keeps the context suspended.
function enable() {
  if (!context) {
    context = new AudioContext();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.ratio.value = 4;
    output = context.createGain();
    output.gain.value = 0.9;
    output.connect(compressor).connect(context.destination);
    noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = noise.getChannelData(0);
    for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
  }
  void context.resume();
  setStatus(rememberedMute() ? "muted" : "on");
}

function toggleMute() {
  if (status === "off") return;
  const muted = status === "on";
  rememberMute(muted);
  setStatus(muted ? "muted" : "on");
}

function live() {
  return status === "on" && context ? context : null;
}

function ping(
  audio: AudioContext,
  frequency: number,
  volume: number,
  decay: number,
  at: number,
  type: OscillatorType = "sine",
) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  oscillator.connect(gain).connect(output!);
  oscillator.start(at);
  oscillator.stop(at + decay + 0.02);
}

function burst(
  audio: AudioContext,
  volume: number,
  decay: number,
  at: number,
  type: BiquadFilterType,
  frequency: number,
  q = 1,
) {
  const source = audio.createBufferSource();
  source.buffer = noise;
  const filter = audio.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(volume, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  source.connect(filter).connect(gain).connect(output!);
  source.start(at, Math.random() * 0.5);
  source.stop(at + decay + 0.02);
}

export const sound = {
  // A glass marble landing on the pile. `pitch` from 0 to 1 climbs as the pile fills. Every ballot
  // makes this same sound, whichever way it went.
  clack(pitch: number) {
    const audio = live();
    if (!audio) return;
    const at = audio.currentTime;
    const base = 1500 * 2 ** (Math.min(1, Math.max(0, pitch)) * 1.1) * (0.96 + Math.random() * 0.08);
    ping(audio, base, 0.27, 0.09, at);
    ping(audio, base * 2.76, 0.12, 0.05, at);
    ping(audio, base * 5.4, 0.05, 0.03, at);
    burst(audio, 0.21, 0.02, at, "highpass", 3000);
    // A second, softer tap as it settles.
    ping(audio, base * 1.06, 0.1, 0.05, at + 0.06 + Math.random() * 0.04);
  },
  // The hopper letting one go.
  tock() {
    const audio = live();
    if (!audio) return;
    const at = audio.currentTime;
    ping(audio, 420, 0.12, 0.08, at, "triangle");
    burst(audio, 0.06, 0.03, at, "bandpass", 1200, 2);
  },
  // A peg hit, rate-limited so a busy board doesn't turn to noise.
  tick(strength: number) {
    const audio = live();
    if (!audio) return;
    const at = audio.currentTime;
    if (at - lastTick < TICK_GAP_S) return;
    lastTick = at;
    ping(audio, 2600 + Math.random() * 1400, 0.16 * strength, 0.035, at, "triangle");
    burst(audio, 0.08 * strength, 0.012, at, "highpass", 5000);
  },
  // A marble dropping into a bin. Only ever heard after the reveal.
  thud(side: Side) {
    const audio = live();
    if (!audio) return;
    const at = audio.currentTime;
    const frequency = side === "yes" ? 880 : 620;
    ping(audio, frequency * (0.97 + Math.random() * 0.06), 0.25, 0.14, at);
    ping(audio, frequency * 2.4, 0.07, 0.06, at);
    burst(audio, 0.16, 0.05, at, "lowpass", 900);
  },
  // The result locking in: a soft bell chord.
  bell() {
    const audio = live();
    if (!audio) return;
    const at = audio.currentTime;
    const chord: [number, number][] = [
      [392, 0.2],
      [587.3, 0.14],
      [784, 0.1],
      [1174.7, 0.05],
    ];
    chord.forEach(([frequency, volume], index) =>
      ping(audio, frequency, volume, 2.8 - index * 0.4, at + index * 0.015),
    );
    ping(audio, 98, 0.25, 1.6, at);
  },
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSound() {
  return { status: useSyncExternalStore(subscribe, () => status), enable, toggleMute };
}
