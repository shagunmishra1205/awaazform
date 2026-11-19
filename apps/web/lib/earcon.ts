'use client';

// A soft two-note "hmm" while Bolu thinks, so Live Mode never feels frozen. Made with Web Audio (no file).
let ctx: AudioContext | null = null;

export function thinkingSound(volume = 0.05) {
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime;
    for (const [freq, at] of [[523.25, 0], [659.25, 0.14]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(volume, t0 + at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.25);
    }
  } catch {
    // No audio: nothing to play.
  }
}
