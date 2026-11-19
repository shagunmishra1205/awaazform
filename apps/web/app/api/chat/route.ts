import { LANGUAGES, questionContext, systemPrompt, toolDeclarations, type FormQuestion, type Language, type OutlineItem } from '@awaazform/core';
import { chatCompletion, config, errorResponse } from '@/lib/groq';
import { rateLimit, tooMany } from '@/lib/rate-limit';
import { guard, preflight, withCors } from '@/lib/guard';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Msg =
  | { role: 'user' | 'assistant'; content: string; tool_calls?: unknown[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatBody {
  formTitle: string;
  profileLabel: string;
  language: Language;
  question?: FormQuestion;
  position: { index: number; total: number };
  /** Labels, types and options of every question; never answer values. */
  outline?: OutlineItem[];
  messages: Msg[];
  /** When set, the model may not call tools — used for explain-only requests. */
  noTools?: boolean;
}

/**
 * One model step. The tool loop (max 6 rounds, §8.5) runs in the browser, because tools act on
 * browser-side state; this route only forwards the minimal context to Groq (§8.5).
 */
async function handlePost(req: Request): Promise<Response> {
  if (!rateLimit(req, 'chat', 60)) return tooMany();
  if (!config.chatModel) return Response.json({ error: 'AI chat is not configured', fallback: 'typing' }, { status: 503 });
  try {
    const body = (await req.json()) as ChatBody;
    const messages = Array.isArray(body.messages) ? body.messages.slice(-16) : [];
    const size = JSON.stringify(messages).length;
    if (size > config.maxChatChars * 8) return Response.json({ error: 'Conversation too long' }, { status: 413 });
    for (const m of messages) {
      if (m.role === 'user' && m.content.length > config.maxChatChars) {
        return Response.json({ error: 'Message too long' }, { status: 413 });
      }
    }

    const res = await chatCompletion((model) => ({
        model,
        temperature: 0.2,
        max_tokens: 1200,
        // gpt-oss models reason before answering; low effort keeps voice replies quick.
        ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
        messages: [
          { role: 'system', content: systemPrompt({ formTitle: String(body.formTitle).slice(0, 200), profileLabel: String(body.profileLabel).slice(0, 60), language: LANGUAGES.includes(body.language) ? body.language : 'en' }) },
          { role: 'system', content: `Current question: ${questionContext(body.question, body.position?.index ?? 0, body.position?.total ?? 0)}` },
          ...(Array.isArray(body.outline) && body.outline.length
            ? [{ role: 'system' as const, content: `Form outline (all questions; use these ids): ${JSON.stringify(body.outline.slice(0, 120)).slice(0, 16000)}` }]
            : []),
          ...messages,
        ],
        ...(body.noTools ? {} : { tools: toolDeclarations(), tool_choice: 'auto' }),
    }));
    const json = (await res.json()) as { choices?: { message?: Msg }[] };
    const message = json.choices?.[0]?.message;
    if (!message || message.role !== 'assistant') return Response.json({ error: 'Empty reply' }, { status: 502 });
    // Return only what the client needs; the model's hidden reasoning stays on the server.
    return Response.json({ message: { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Same-origin pages and the AwaazForm extension only (lib/guard.ts). */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.response;
  return withCors(await handlePost(req), g);
}

export const OPTIONS = preflight;
