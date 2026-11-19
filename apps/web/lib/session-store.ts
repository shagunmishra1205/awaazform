'use client';

import type { Session } from '@awaazform/core';
import { openText, RETENTION_MS, sealText } from './secure-store';

// FR-22: sessions survive reload, and can be discarded. Each source (an online form, a PDF, a Word file)
// has its own key; the report shows the most recent one. Stored encrypted (lib/secure-store.ts) and
// dropped after 24 hours without use.
export const PDF_KEY = 'awaazform.session.pdf';
export const GFORM_KEY = 'awaazform.session.gform';
export const DOCX_KEY = 'awaazform.session.docx';
const LAST = 'awaazform.session.last';

interface Envelope { at: number; session: Session }

export async function loadSession(key: string): Promise<Session | null> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const text = await openText(raw);
    if (!text) return discardSession(key), null;
    const parsed = JSON.parse(text) as Envelope | Session;
    const env: Envelope = 'session' in parsed ? parsed : { at: Date.now(), session: parsed };
    if (Date.now() - env.at > RETENTION_MS) return discardSession(key), null;
    const s = env.session;
    // A reload mid-recording should not leave an answer stuck in "listening".
    for (const a of Object.values(s.answers)) if (a.status === 'listening') a.status = 'pending';
    return s;
  } catch {
    return null;
  }
}

// Writes are chained per key, so a slow encryption can't let an older state overwrite a newer one.
const queues = new Map<string, Promise<void>>();

export function saveSession(s: Session, key: string): Promise<void> {
  const next = (queues.get(key) ?? Promise.resolve()).then(async () => {
    const sealed = await sealText(JSON.stringify({ at: Date.now(), session: s } satisfies Envelope));
    localStorage.setItem(key, sealed);
    localStorage.setItem(LAST, key);
  }).catch(() => {});
  queues.set(key, next);
  return next;
}

export function loadLastSession(): Promise<Session | null> {
  return loadSession(localStorage.getItem(LAST) ?? GFORM_KEY);
}

export function discardSession(key: string) {
  localStorage.removeItem(key);
}
