'use client';

import { LiveListener, type LiveCallbacks } from './live';

// Live Mode's ears. Silero VAD (a small neural voice detector, run in the browser with ONNX) tells real
// speech from fans, typing and clicks far better than a loudness threshold, so turns end promptly
// (~0.45 s after you stop) without cutting you off. If it can't load (old browser, blocked WebAssembly),
// the loudness-based listener takes over. Audio still never leaves the browser until a turn ends.

export interface Listener {
  start(): Promise<void>;
  stop(): void;
  setPaused(p: boolean): void;
  setSpeaking(on: boolean, allowBargeIn?: boolean): void;
}

const SAMPLE_RATE = 16000;

/** 16 kHz mono float samples → a small WAV file for speech-to-text. */
function toWav(samples: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

class SileroListener implements Listener {
  private vad: { start(): Promise<void>; pause(): Promise<void>; destroy(): Promise<void>; setOptions(o: Record<string, number>): void } | null = null;
  private paused = false;
  private hold = false;
  private bargeIn = false;
  private tail: ReturnType<typeof setTimeout> | null = null;

  constructor(private cb: LiveCallbacks, private assets: string) {}

  async start() {
    const { MicVAD } = await import('@ricky0123/vad-web');
    this.vad = await MicVAD.new({
      model: 'v5',
      baseAssetPath: this.assets,
      onnxWASMBasePath: this.assets,
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.4,
      redemptionMs: 450,
      preSpeechPadMs: 300,
      minSpeechMs: 250,
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }),
      onFrameProcessed: (p: { isSpeech: number }) => this.cb.onLevel?.(p.isSpeech),
      onSpeechStart: () => { if (!this.ignored()) this.cb.onSpeechStart(); },
      onSpeechEnd: (audio: Float32Array) => { if (!this.ignored()) this.cb.onUtterance(toWav(audio)); },
      onVADMisfire: () => {},
    } as never) as unknown as SileroListener['vad'];
    await this.vad!.start();
  }

  /** Speech is dropped while paused (the AI is working) or while Bolu talks (unless barge-in is on). */
  private ignored() {
    return this.paused || (this.hold && !this.bargeIn);
  }

  setPaused(p: boolean) {
    this.paused = p;
  }

  setSpeaking(on: boolean, allowBargeIn = false) {
    if (this.tail) clearTimeout(this.tail);
    this.tail = null;
    if (on) {
      this.hold = true;
      this.bargeIn = allowBargeIn;
      // With headphones, an interruption must be clearly speech, not Bolu's echo.
      if (allowBargeIn) this.vad?.setOptions({ positiveSpeechThreshold: 0.85, negativeSpeechThreshold: 0.6, minSpeechMs: 400 });
      return;
    }
    this.vad?.setOptions({ positiveSpeechThreshold: 0.6, negativeSpeechThreshold: 0.4, minSpeechMs: 250 });
    this.tail = setTimeout(() => { this.hold = false; }, 350);
  }

  stop() {
    void this.vad?.destroy();
    this.vad = null;
  }
}

/** Silero when it loads, otherwise the loudness-based listener. `assets` is where /vad/ files are served. */
export async function createListener(cb: LiveCallbacks, assets = '/vad/'): Promise<Listener> {
  try {
    const l = new SileroListener(cb, assets);
    await l.start();
    return l;
  } catch (err) {
    if ((err as Error)?.name === 'NotAllowedError') throw err; // microphone refused: say so, don't fall back
    const l = new LiveListener(cb);
    await l.start();
    return l;
  }
}
