'use client';

import { apiUrl } from './api';
import { en, fmt, type Strings } from '@/lib/i18n/core';
import { formOutline, type FormQuestion, type Language, type SessionController, type Shield, type ToolRunner } from '@awaazform/core';

// Client-side tool loop (§8.5): the model proposes tool calls, the runner validates and executes
// them against browser-side state. Max 6 tool rounds per turn.

const MAX_ROUNDS = 6;

type ToolCallMsg = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ChatMsg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallMsg[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export class AiUnavailable extends Error {}

interface Ctx {
  ctl: SessionController;
  runner: ToolRunner;
  profileLabel: string;
  language: Language;
  /** Privacy shield: identifiers are swapped for placeholders before anything reaches the AI. */
  shield?: Shield;
}

async function step(ctx: Ctx, messages: ChatMsg[], noTools = false): Promise<Extract<ChatMsg, { role: 'assistant' }>> {
  const s = ctx.ctl.session;
  const res = await fetch(apiUrl('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      formTitle: s.formTitle,
      profileLabel: ctx.profileLabel,
      language: ctx.language,
      question: s.questions[s.currentIndex],
      position: { index: s.currentIndex, total: s.questions.length },
      outline: noTools ? undefined : formOutline(s.questions, Object.fromEntries(Object.entries(s.answers).map(([k, a]) => [k, a.status]))),
      messages,
      noTools,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { message?: Extract<ChatMsg, { role: 'assistant' }>; error?: string };
  if (!res.ok || !json.message) throw new AiUnavailable(json.error ?? 'AI is unavailable');
  return json.message;
}

/** Runs one user turn through the model and tools. Returns the assistant's final words, if any. */
export async function assistantTurn(ctx: Ctx, history: ChatMsg[], utterance: string): Promise<{ reply: string | null; history: ChatMsg[]; proposed: string[] }> {
  const proposed: string[] = [];
  const hide = (s: string) => (ctx.shield ? ctx.shield.hide(s) : s);
  const reveal = (s: string) => (ctx.shield ? ctx.shield.reveal(s) : s);
  const messages: ChatMsg[] = [...history, { role: 'user', content: hide(utterance.slice(0, 2000)) }];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const msg = await step(ctx, messages);
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) return { reply: msg.content ? reveal(msg.content) : null, history: messages, proposed };
    for (const tc of msg.tool_calls) {
      // Real values go back in locally, just before the runner validates the call.
      const args = reveal(tc.function.arguments);
      const out = await ctx.runner.run({ id: tc.id, name: tc.function.name, arguments: args });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: hide(out.content) });
      if (out.ok && tc.function.name === 'propose_fill') {
        try {
          const id = String((JSON.parse(args) as { questionId?: unknown }).questionId);
          if (!proposed.includes(id)) proposed.push(id);
        } catch { /* the runner already rejected bad JSON */ }
      }
    }
  }
  return { reply: null, history: messages, proposed };
}

/** FR-18 / J6: plain-language explanation. Never suggests an answer. */
export async function explainQuestion(ctx: Ctx, q: FormQuestion): Promise<string> {
  try {
    const msg = await step(
      ctx,
      [{ role: 'user', content: `Explain in one or two plain sentences what this question is asking: “${q.label}”${q.helpText ? ` (help text: “${q.helpText}”)` : ''}. Do not suggest an answer.` }],
      true,
    );
    if (msg.content) return msg.content;
  } catch {
    // fall back below
  }
  return fallbackExplanation(q);
}

/** Plain-language explanation when the AI is unavailable, in the interface language. */
export function fallbackExplanation(q: FormQuestion, t: Strings = en): string {
  const e = t.explain;
  const kind: Record<FormQuestion['type'], string> = {
    text: e.k_text, paragraph: e.k_paragraph, number: e.k_number, date: e.k_date, time: e.k_time, email: e.k_email,
    phone: e.k_phone, yesno: e.k_yesno, choice: e.k_choice, multichoice: e.k_multi, checkbox: e.k_multi, dropdown: e.k_choice, scale: e.k_scale, file: e.k_file,
  };
  return [
    fmt(e.asks, { label: q.label, kind: kind[q.type] }),
    q.helpText ? fmt(e.form_says, { help: q.helpText }) : '',
    q.options?.length ? fmt(e.options_are, { list: q.options.join(', ') }) : '',
  ].filter(Boolean).join(' ');
}
