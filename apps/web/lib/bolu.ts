// Bolu, AwaazForm's robot, as a live SVG. Framework-free so the website and the browser extension share it.
// States: idle (bob and blink), listening (glows with your voice), thinking (looks up, antenna blinks),
// speaking (mouth moves), happy (a little hop and a wave). With reduced motion it holds a still pose.

export type BoluState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'happy';

export interface BoluHandle {
  setState(s: BoluState): void;
  /** Microphone level, 0–1, while listening. */
  setLevel(l: number): void;
  setReduceMotion(r: boolean): void;
  destroy(): void;
}

let seq = 0;

/** The SVG markup. `head` crops to the face, for avatars and the launcher button. */
export function boluSvg(id: string, head = false): string {
  const vb = head ? '14 0 192 160' : '0 0 220 260';
  return `<svg viewBox="${vb}" width="100%" height="100%" style="overflow:visible;display:block" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="${id}h" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a63f0"/><stop offset="1" stop-color="#c63af8"/></linearGradient>
    <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef0f4"/></linearGradient>
    <radialGradient id="${id}a"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="#ffd387"/><stop offset="1" stop-color="#f7a12b"/></radialGradient>
    <filter id="${id}s" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  ${head ? '' : `<ellipse data-b="shadow" cx="110" cy="252" rx="62" ry="10" fill="#151718" opacity=".16"/>`}
  <g data-b="all">
    ${head ? '' : `<g data-b="armL" style="transform-origin:58px 160px"><rect x="22" y="152" width="40" height="22" rx="11" fill="url(#${id}h)"/><circle cx="24" cy="163" r="13" fill="#ab9ff4"/></g>
    <g data-b="armR" style="transform-origin:162px 160px"><rect x="158" y="152" width="40" height="22" rx="11" fill="url(#${id}h)"/><circle cx="196" cy="163" r="13" fill="#ab9ff4"/></g>
    <rect x="56" y="128" width="108" height="100" rx="42" fill="url(#${id}b)" stroke="#e1e3ea" stroke-width="2"/>
    <rect x="84" y="160" width="52" height="40" rx="14" fill="url(#${id}h)"/>
    <rect data-b="bar1" x="98" y="172" width="6" height="16" rx="3" fill="#fff"/>
    <rect data-b="bar2" x="107" y="166" width="6" height="28" rx="3" fill="#fff"/>
    <rect data-b="bar3" x="116" y="170" width="6" height="20" rx="3" fill="#fff"/>`}
    <g data-b="head" style="transform-origin:110px 150px">
      <line x1="110" y1="44" x2="110" y2="18" stroke="#7a63f0" stroke-width="6" stroke-linecap="round"/>
      <circle data-b="glow" cx="110" cy="14" r="16" fill="#ffd387" filter="url(#${id}s)" opacity=".7"/>
      <circle data-b="ball" cx="110" cy="14" r="10" fill="url(#${id}a)"/>
      <circle cx="20" cy="96" r="13" fill="#ab9ff4"/><circle cx="200" cy="96" r="13" fill="#ab9ff4"/>
      <rect x="22" y="38" width="176" height="114" rx="50" fill="url(#${id}h)"/>
      <rect x="42" y="56" width="136" height="80" rx="36" fill="#151718"/>
      <ellipse cx="80" cy="70" rx="22" ry="6" fill="#fff" opacity=".08"/>
      <g data-b="eyes">
        <rect data-b="eyeL" x="72" y="74" width="20" height="26" rx="10" fill="#bff3ff"/>
        <rect data-b="eyeR" x="128" y="74" width="20" height="26" rx="10" fill="#bff3ff"/>
        <circle data-b="glintL" cx="86" cy="80" r="3.5" fill="#fff"/><circle data-b="glintR" cx="142" cy="80" r="3.5" fill="#fff"/>
      </g>
      <circle cx="64" cy="114" r="8" fill="#ff7eb3" opacity=".55"/><circle cx="156" cy="114" r="8" fill="#ff7eb3" opacity=".55"/>
      <path data-b="smile" d="M96 112 Q110 124 124 112" stroke="#bff3ff" stroke-width="5" fill="none" stroke-linecap="round"/>
      <ellipse data-b="mouth" cx="110" cy="116" rx="12" ry="2" fill="#ff8fb1" opacity="0"/>
    </g>
  </g>
</svg>`;
}

/** Mounts an animated Bolu into `el`. */
export function mountBolu(el: HTMLElement, opts: { head?: boolean; state?: BoluState; reduceMotion?: boolean } = {}): BoluHandle {
  const id = `bolu${++seq}`;
  el.innerHTML = boluSvg(id, opts.head);
  const $ = (n: string) => el.querySelector<SVGElement>(`[data-b="${n}"]`);
  const parts = {
    all: $('all'), head: $('head'), shadow: $('shadow'), glow: $('glow'), ball: $('ball'), mouth: $('mouth'), smile: $('smile'),
    eyeL: $('eyeL'), eyeR: $('eyeR'), eyes: $('eyes'), armL: $('armL'), armR: $('armR'), bars: [$('bar1'), $('bar2'), $('bar3')],
  };
  let state: BoluState = opts.state ?? 'idle';
  let level = 0;
  let smooth = 0;
  let reduce = !!opts.reduceMotion;
  let raf = 0;
  let happyAt = 0;
  const t0 = performance.now();

  const draw = (t: number) => {
    smooth += (level - smooth) * 0.25;
    const talking = state === 'speaking';
    const mouth = talking ? 0.35 + 0.35 * Math.sin(t * 16) + 0.2 * Math.sin(t * 27) : 0;
    const hop = state === 'happy' ? Math.max(0, Math.sin(Math.min(1, (t - happyAt) / 0.5) * Math.PI)) * 14 : 0;
    const bob = reduce ? 0 : Math.sin(t * (state === 'listening' ? 3 : 2.2)) * (state === 'thinking' ? 2 : 5) - hop;
    parts.all?.setAttribute('transform', `translate(0 ${bob.toFixed(2)})`);
    parts.shadow?.setAttribute('rx', String(62 - bob * 0.8));
    const tilt = state === 'thinking' ? -6 : state === 'listening' ? Math.sin(t * 1.3) * 2 : 0;
    if (parts.head) parts.head.style.transform = `rotate(${reduce ? 0 : tilt}deg)`;

    const blink = !reduce && t % 3.4 > 3.28 ? 0.12 : 1;
    const look = state === 'thinking' ? [0.8, -0.9] : state === 'listening' ? [0, -0.2] : [0, 0];
    for (const [eye, cx] of [[parts.eyeL, 82], [parts.eyeR, 138]] as const) {
      const squint = state === 'happy' ? 0.55 : 1;
      eye?.setAttribute('transform', `translate(${look[0]! * 6} ${look[1]! * 5}) translate(${cx} 87) scale(1 ${blink * squint}) translate(${-cx} -87)`);
    }
    parts.mouth?.setAttribute('ry', String(2 + Math.max(0, mouth) * 11));
    parts.mouth?.setAttribute('opacity', mouth > 0.04 ? '1' : '0');
    parts.smile?.setAttribute('opacity', mouth > 0.04 ? '0' : '1');
    parts.smile?.setAttribute('d', state === 'happy' ? 'M92 110 Q110 130 128 110' : state === 'thinking' ? 'M100 116 Q110 118 120 116' : 'M96 112 Q110 124 124 112');

    const glow = state === 'listening' ? 0.35 + smooth * 0.9 : state === 'thinking' ? (Math.sin(t * 9) > 0 ? 0.95 : 0.25) : state === 'speaking' ? 0.6 + mouth * 0.4 : 0.45 + 0.25 * Math.sin(t * 2.5);
    parts.glow?.setAttribute('opacity', glow.toFixed(2));
    parts.ball?.setAttribute('r', String(10 + (state === 'listening' ? smooth * 4 : 0)));

    [16, 28, 20].forEach((h, i) => {
      const k = state === 'listening' ? 0.35 + smooth * (0.65 + 0.3 * Math.sin(t * 14 + i * 2))
        : talking ? 0.5 + 0.5 * Math.sin(t * 18 + i * 2) : 0.55;
      const hh = h * Math.max(0.3, Math.min(1.15, k));
      const b = parts.bars[i];
      b?.setAttribute('height', hh.toFixed(1));
      b?.setAttribute('y', (180 - hh / 2).toFixed(1));
    });
    const wave = state === 'happy' && !reduce ? -120 + Math.sin(t * 10) * 28 : 12 + Math.sin(t * 2.2) * (reduce ? 0 : 4);
    if (parts.armR) parts.armR.style.transform = `rotate(${wave}deg)`;
    if (parts.armL) parts.armL.style.transform = `rotate(${-12 - Math.sin(t * 2.2) * (reduce ? 0 : 4)}deg)`;
  };

  const loop = () => {
    draw((performance.now() - t0) / 1000);
    raf = reduce ? 0 : requestAnimationFrame(loop);
  };
  loop();

  return {
    setState(s) {
      if (s === 'happy' && state !== 'happy') happyAt = (performance.now() - t0) / 1000;
      state = s;
      if (reduce) draw(0);
    },
    setLevel(l) { level = Math.max(0, Math.min(1, l)); },
    setReduceMotion(r) {
      reduce = r;
      cancelAnimationFrame(raf);
      loop();
    },
    destroy() {
      cancelAnimationFrame(raf);
      el.innerHTML = '';
    },
  };
}
