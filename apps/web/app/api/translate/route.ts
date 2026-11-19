import { LANGUAGE_NAMES, LANGUAGES, type Language } from '@awaazform/core';
import { z } from 'zod';
import { chatCompletion, config, errorResponse } from '@/lib/groq';
import { guard, preflight, withCors } from '@/lib/guard';
import { rateLimit, tooMany } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Translates a form's own wording (question labels, help text, options) into the user's language, so
// Bolu can ask in Hindi, Tamil… Only the form's printed text is sent, never the user's answers.

const Input = z.object({
  language: z.string(),
  items: z.array(z.string().max(600)).min(1).max(80),
});

async function handlePost(req: Request): Promise<Response> {
  if (!rateLimit(req, 'translate', 30)) return tooMany();
  if (!config.chatModel) return Response.json({ error: 'AI is not configured' }, { status: 503 });
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !(LANGUAGES as readonly string[]).includes(parsed.data.language) || parsed.data.language === 'en') {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { items } = parsed.data;
  const language = parsed.data.language as Language;
  try {
    const input = Object.fromEntries(items.map((s, i) => [String(i), s]));
    const res = await chatCompletion((model) => ({
      model,
      temperature: 0.1,
      max_tokens: Math.min(6000, 400 + JSON.stringify(input).length * 3),
      ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Translate each value of the JSON object into ${LANGUAGE_NAMES[language]}. These are questions and answer options from a form that someone will hear read aloud: use simple, natural, everyday words, and the polite form. Keep the same keys. Keep names of people, organisations and products, email addresses, numbers and abbreviations (e.g. SISC, NA, PIN) as they are. Return only the JSON object.`,
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
    }));
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    let out: Record<string, unknown> = {};
    try {
      out = JSON.parse(json.choices?.[0]?.message?.content ?? '{}') as Record<string, unknown>;
    } catch { /* fall back to the originals below */ }
    // Anything missing or odd stays in the form's own words.
    const translations = items.map((s, i) => (typeof out[String(i)] === 'string' && (out[String(i)] as string).trim() ? (out[String(i)] as string).trim().slice(0, 800) : s));
    return Response.json({ translations });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.response;
  return withCors(await handlePost(req), g);
}

export const OPTIONS = preflight;
