'use client';

import type { FormQuestion, SessionEvent } from '@awaazform/core';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, type KeyboardEvent } from 'react';
import { en, fmt, localizeMessage, type Strings } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { EASE } from './Motion';

export type CardTone = 'info' | 'pending' | 'ok' | 'warn' | 'bad';
export interface TimelineCard {
  id: string;
  title: string;
  detail?: string;
  tone: CardTone;
  actor: 'ai' | 'you' | 'app';
  at: number;
}

/** The plain-language line for a tool call, in the interface language. */
function describe(t: Strings, name: string, args: Record<string, unknown>, label: string): string {
  const tl = t.timeline;
  const key = (k: unknown) => t.keys[String(k) as keyof Strings['keys']] ?? String(k).replace(/_/g, ' ');
  switch (name) {
    case 'scan_form': return tl.tool_scan;
    case 'get_current_question': return tl.tool_current;
    case 'ask_user': return fmt(tl.tool_ask, { label });
    case 'propose_fill': return fmt(tl.tool_propose, { value: String(args.value), label });
    case 'read_back': return fmt(tl.tool_read_back, { value: String(args.value) });
    case 'explain_field': return fmt(tl.tool_explain, { label });
    case 'lookup_profile': return fmt(tl.tool_lookup, { key: key(args.key) });
    case 'offer_save': return fmt(tl.tool_offer, { key: key(args.key) });
    case 'highlight_field': return fmt(tl.tool_highlight, { label });
    case 'verify_field': return fmt(tl.tool_verify, { label });
    case 'build_report': return tl.tool_report;
    case 'go_to_question': return fmt(tl.tool_goto, { label });
    default: return name;
  }
}

/** Turns session events into plain-language cards (FR-24). Tool calls update in place by callId. */
export function applyEvent(cards: TimelineCard[], e: SessionEvent, questions: FormQuestion[], t: Strings = en): TimelineCard[] {
  const tl = t.timeline;
  const label = (id: string) => questions.find((q) => q.id === id)?.label ?? id;
  const add = (c: Omit<TimelineCard, 'id' | 'at'>, id: string = crypto.randomUUID()) => [...cards, { ...c, id, at: Date.now() }];
  const key = (k: string) => t.keys[k as keyof Strings['keys']] ?? k.replace(/_/g, ' ');

  switch (e.type) {
    case 'question.presented':
      return add({ title: fmt(tl.now_on, { label: label(e.questionId) }), tone: 'info', actor: 'app' });
    case 'tool.called': {
      const args = (e.args ?? {}) as Record<string, unknown>;
      const q = typeof args.questionId === 'string' ? label(args.questionId) : '';
      return add({ title: describe(t, e.name, args, q), detail: fmt(tl.ai_used, { tool: e.name }), tone: 'pending', actor: 'ai' }, e.callId);
    }
    case 'tool.result': {
      const existing = cards.find((c) => c.id === e.callId);
      if (existing) return cards.map((c) => (c.id === e.callId ? { ...c, tone: e.ok ? 'ok' : 'bad', detail: e.ok ? c.detail : fmt(tl.refused, { reason: localizeMessage(t, e.summary) }) } : c));
      return add({ title: e.ok ? e.summary : fmt(tl.call_refused, { tool: e.name }), detail: e.ok ? undefined : localizeMessage(t, e.summary), tone: e.ok ? 'ok' : 'bad', actor: 'ai' }, e.callId);
    }
    case 'fill.proposed': {
      const src = { spoken: tl.src_spoken, typed: tl.src_typed, profile: tl.src_profile }[e.source];
      return add({ title: fmt(tl.waiting, { value: e.value }), detail: fmt(tl.from_source, { label: label(e.questionId), source: src }), tone: 'pending', actor: e.source === 'profile' ? 'app' : 'you' });
    }
    case 'fill.confirmed':
      return add({ title: fmt(tl.confirmed, { value: e.value }), detail: label(e.questionId), tone: 'ok', actor: 'you' });
    case 'fill.written':
      return add({ title: tl.written, detail: label(e.questionId), tone: 'info', actor: 'app' });
    case 'fill.verified':
      return add(e.ok
        ? { title: tl.verified, detail: label(e.questionId), tone: 'ok', actor: 'app' }
        : { title: t.session.didnt_take, detail: e.actual !== undefined ? fmt(tl.field_shows, { label: label(e.questionId), actual: e.actual }) : label(e.questionId), tone: 'warn', actor: 'app' });
    case 'profile.offered':
      return add({ title: fmt(tl.offered, { key: key(e.key) }), tone: 'info', actor: 'app' });
    case 'profile.saved':
      return add({ title: fmt(tl.saved, { key: key(e.key) }), tone: 'ok', actor: 'you' });
    case 'error':
      return add({ title: localizeMessage(t, e.message), tone: e.recoverable ? 'warn' : 'bad', actor: 'app' });
  }
}

const DOT: Record<CardTone, string> = { info: 'var(--ink-400)', pending: 'var(--violet-500)', ok: 'var(--green-600)', warn: 'var(--amber-700)', bad: 'var(--red-600)' };

export function Timeline({ cards, title }: { cards: TimelineCard[]; title: string }) {
  const { reduceMotion, t } = useSettings();
  const tl = t.timeline;
  const ACTOR = { ai: tl.actor_ai, you: tl.actor_you, app: 'AwaazForm' } as const;
  const TONE: Record<CardTone, { dot: string; label: string }> = {
    info: { dot: DOT.info, label: tl.tone_info }, pending: { dot: DOT.pending, label: tl.tone_pending }, ok: { dot: DOT.ok, label: tl.tone_ok },
    warn: { dot: DOT.warn, label: tl.tone_warn }, bad: { dot: DOT.bad, label: tl.tone_bad },
  };
  const listRef = useRef<HTMLOListElement>(null);
  const latest = cards[cards.length - 1];

  // FR-29: arrow keys move between cards; Home/End jump.
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-card]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); items[Math.max(0, Math.min(items.length - 1, n))]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
  };

  return (
    <section aria-labelledby="timeline-h" className="card flex min-h-0 flex-col p-0">
      <h2 id="timeline-h" className="border-b border-line px-5 py-4 text-base">{title}</h2>
      {/* Screen readers hear each new step once. */}
      <p className="sr-only" aria-live="polite" aria-atomic>{latest ? `${ACTOR[latest.actor]}: ${latest.title}` : ''}</p>
      {cards.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">{tl.empty}</p>
      ) : (
        <ol ref={listRef} onKeyDown={onKeyDown} className="flex max-h-[520px] flex-col overflow-y-auto px-3 py-2" aria-label={tl.list}>
          <AnimatePresence initial={false}>
            {[...cards].reverse().map((c, i) => (
              <motion.li
                key={c.id}
                layout={!reduceMotion}
                initial={reduceMotion ? false : { opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: EASE }}
              >
                <div
                  data-card
                  tabIndex={i === 0 ? 0 : -1}
                  className="flex gap-3 rounded-[var(--r-12)] px-2 py-2.5 text-sm"
                >
                  <span className="relative mt-1.5 h-2.5 w-2.5 flex-none rounded-full" style={{ background: TONE[c.tone].dot }} role="img" aria-label={TONE[c.tone].label}>
                    {c.tone === 'pending' && !reduceMotion && (
                      <span className="absolute inset-0 rounded-full" style={{ background: TONE[c.tone].dot, animation: 'ring 1.6s var(--ease-out) infinite' }} />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium break-words">{c.title}</span>
                    <span className="block text-xs text-muted">
                      {ACTOR[c.actor]}{c.detail ? ` · ${c.detail}` : ''}
                    </span>
                  </span>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
    </section>
  );
}
