'use client';

import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { Strings } from '@/lib/i18n/core';

const INK = '#0d1a73';

/**
 * Draw a signature with a finger, stylus or mouse (smoothed strokes, pressure-aware on pens), or type a
 * name as a keyboard alternative. Hands back a PNG cropped to the ink, with a transparent background,
 * so it sits cleanly on the printed line. The image stays in the browser.
 */
export function SignaturePad({ t, disabled, onDone }: { t: Strings; disabled?: boolean; onDone: (png: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number; w: number } | null>(null);
  const pointer = useRef<number | null>(null);
  const [inked, setInked] = useState(false);
  const [typed, setTyped] = useState('');

  // Match the canvas to its on-screen size at the device's pixel ratio, so lines are crisp.
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const fit = () => {
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const width = Math.round(c.clientWidth * dpr), height = Math.round(c.clientHeight * dpr);
      if (!width || !height || (c.width === width && c.height === height)) return;
      // Resizing the backing bitmap clears it. Keep the ink across responsive layout changes
      // and ignore ResizeObserver's initial notification when the size hasn't changed.
      const previous = document.createElement('canvas');
      previous.width = c.width; previous.height = c.height;
      previous.getContext('2d')!.drawImage(c, 0, 0);
      c.width = width;
      c.height = height;
      const g = c.getContext('2d')!;
      g.drawImage(previous, 0, 0, width, height);
      g.scale(width / c.clientWidth, height / c.clientHeight);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = g.fillStyle = INK;
      last.current = null;
      pointer.current = null;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    return { x: (e.clientX - r.left) * e.currentTarget.offsetWidth / r.width - e.currentTarget.clientLeft,
      y: (e.clientY - r.top) * e.currentTarget.offsetHeight / r.height - e.currentTarget.clientTop, w: 1.2 + pressure * 2.6 };
  };

  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || pointer.current !== null || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointer.current = e.pointerId;
    last.current = point(e);
    const g = e.currentTarget.getContext('2d')!;
    const p = last.current;
    g.beginPath();
    g.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2);
    g.fill();
    setInked(true);
    setTyped('');
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const g = canvas.current?.getContext('2d');
    const p0 = last.current;
    if (disabled || pointer.current !== e.pointerId || !g || !p0) return;
    const p = point(e);
    // A quadratic curve through the midpoint smooths out jagged pointer samples.
    const mx = (p0.x + p.x) / 2, my = (p0.y + p.y) / 2;
    g.lineWidth = (p0.w + p.w) / 2;
    g.beginPath();
    g.moveTo(p0.x, p0.y);
    g.quadraticCurveTo(p0.x, p0.y, mx, my);
    g.lineTo(p.x, p.y);
    g.stroke();
    last.current = p;
    setInked(true);
  };
  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId) return;
    if (e.type === 'pointerup') move(e);
    last.current = null;
    pointer.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const clear = () => {
    const c = canvas.current;
    if (!c) return;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    last.current = null;
    pointer.current = null;
    setInked(false);
  };

  /** Typed name, written across the pad in a handwriting-style font. */
  const writeTyped = (name: string) => {
    setTyped(name);
    const c = canvas.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    const r = c.getBoundingClientRect();
    g.clearRect(0, 0, c.width, c.height);
    if (!name.trim()) return setInked(false);
    let size = 44;
    g.font = `italic 600 ${size}px "Segoe Script", "Brush Script MT", "Noto Sans", cursive`;
    while (size > 14 && g.measureText(name).width > r.width - 24) { size -= 2; g.font = `italic 600 ${size}px "Segoe Script", "Brush Script MT", "Noto Sans", cursive`; }
    g.textBaseline = 'middle';
    g.fillText(name, 12, r.height / 2);
    setInked(true);
  };

  /** Crops to the ink (plus a little margin), so the signature fills its box on the page. */
  const use = () => {
    const c = canvas.current;
    if (!c || !inked) return;
    const { width: W, height: H } = c;
    const data = c.getContext('2d')!.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3]! > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return;
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    onDone(out.toDataURL('image/png'));
  };

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted">{t.session.sign_prompt}</p>
      <canvas ref={canvas} role="img" aria-label={t.session.sign_pad}
        className="h-44 w-full touch-none rounded-[var(--r-16)] border-2 border-dashed bg-white"
        style={{ borderColor: 'var(--violet-300)', cursor: disabled ? 'not-allowed' : 'crosshair' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} />
      <label className="grid gap-1 text-sm">
        <span className="text-muted">{t.session.sign_or_type}</span>
        <input className="min-h-11 rounded-[var(--r-12)] border border-line bg-surface px-3" value={typed} maxLength={60}
          autoComplete="name" disabled={disabled} onChange={(e) => writeTyped(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <button type="button" className="btn flex-1" disabled={disabled || !inked} onClick={use}>{t.session.sign_use}</button>
        <button type="button" className="btn btn-ghost" disabled={disabled || !inked} onClick={() => { clear(); setTyped(''); }}>{t.session.sign_clear}</button>
      </div>
    </div>
  );
}
