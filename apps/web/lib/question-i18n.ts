'use client';

import type { FormQuestion, Language } from '@awaazform/core';
import { apiUrl } from './api';

// The form's own wording in the user's language. The form still gets its original text: these are
// for showing and speaking only. Cached per form and language in this browser.

export interface QuestionText { label: string; helpText?: string; options?: string[] }
export type QuestionTexts = Record<string, QuestionText>;

const KEY = 'awaazform.qtext.';

async function hash(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function translateQuestions(questions: FormQuestion[], lang: Language): Promise<QuestionTexts> {
  if (lang === 'en' || !questions.length) return {};
  // Every distinct string once: labels, help text and options.
  const strings: string[] = [];
  const at = new Map<string, number>();
  const add = (s?: string) => {
    if (!s || at.has(s) || !/[A-Za-z]/.test(s)) return; // already in another script: nothing to translate
    at.set(s, strings.length);
    strings.push(s);
  };
  for (const q of questions) { add(q.label); add(q.helpText); q.options?.forEach(add); }

  const cacheKey = KEY + (await hash(`${lang}\n${strings.join('\n')}`));
  let done: string[] | null = null;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) done = JSON.parse(cached) as string[];
  } catch { /* no cache */ }

  if (!done) {
    done = [...strings];
    for (let i = 0; i < strings.length; i += 60) {
      const items = strings.slice(i, i + 60);
      const res = await fetch(apiUrl('/api/translate'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: lang, items }) });
      if (!res.ok) throw new Error('Translation is unavailable right now');
      const json = (await res.json()) as { translations?: string[] };
      json.translations?.forEach((t, j) => { done![i + j] = t; });
    }
    try { localStorage.setItem(cacheKey, JSON.stringify(done)); } catch { /* storage full: fine */ }
  }

  const tr = (s?: string) => (s && at.has(s) ? done![at.get(s)!] : s);
  return Object.fromEntries(questions.map((q) => [q.id, { label: tr(q.label)!, helpText: tr(q.helpText), options: q.options?.map((o) => tr(o)!) }]));
}
