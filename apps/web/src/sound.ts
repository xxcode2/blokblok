// Tiny WebAudio synth — no audio assets, $0. All sounds are short oscillator
// blips so there is no asset pipeline. Mute persists in localStorage.

let ctx: AudioContext | null = null;
let muted = typeof localStorage !== "undefined" && localStorage.getItem("ba-muted") === "1";

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem("ba-muted", m ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

function ac(): AudioContext | null {
  if (muted) return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freqFrom: number, freqTo: number, durMs: number, type: OscillatorType, gain: number, delayMs = 0): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delayMs / 1000;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqFrom, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + durMs / 1000);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

export const sfx = {
  move(): void {
    tone(520, 640, 60, "sine", 0.05);
  },
  place(): void {
    tone(880, 220, 180, "sawtooth", 0.07);
    tone(1320, 660, 120, "sine", 0.05, 10);
  },
  collide(): void {
    tone(140, 60, 120, "square", 0.08);
  },
  error(): void {
    tone(220, 160, 140, "square", 0.05);
  },
  countdown(final: boolean): void {
    tone(final ? 880 : 440, final ? 880 : 440, final ? 220 : 120, "sine", 0.08);
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 200, "sine", 0.08, i * 110));
  },
  lose(): void {
    [392, 330, 262].forEach((f, i) => tone(f, f * 0.9, 200, "sine", 0.07, i * 130));
  },
};
