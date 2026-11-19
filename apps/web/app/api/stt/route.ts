import { LANGUAGES } from '@awaazform/core';
import { config, errorResponse, groqFetch } from '@/lib/groq';
import { rateLimit, tooMany } from '@/lib/rate-limit';
import { guard, preflight, withCors } from '@/lib/guard';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Speech-to-text. Audio is forwarded to Groq and never written to disk (§9.4).
async function handlePost(req: Request): Promise<Response> {
  if (!rateLimit(req, 'stt')) return tooMany();
  try {
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > config.maxAudioBytes + 10_000) return Response.json({ error: 'Recording is too long' }, { status: 413 });

    const form = await req.formData();
    const audio = form.get('audio');
    const language = form.get('language');
    if (!(audio instanceof Blob) || audio.size === 0) return Response.json({ error: 'No audio' }, { status: 400 });
    if (audio.size > config.maxAudioBytes) return Response.json({ error: 'Recording is too long' }, { status: 413 });

    const body = new FormData();
    body.set('file', audio, 'answer.webm');
    body.set('model', config.sttModel);
    body.set('response_format', 'json');
    body.set('temperature', '0');
    if (typeof language === 'string' && (LANGUAGES as readonly string[]).includes(language)) body.set('language', language);
    // Context for Whisper: the question being answered (no personal data), capped well under its limit.
    const prompt = form.get('prompt');
    if (typeof prompt === 'string' && prompt.trim()) body.set('prompt', prompt.slice(0, 600));

    const res = await groqFetch('/audio/transcriptions', { method: 'POST', body });
    const json = (await res.json()) as { text?: string };
    return Response.json({ text: (json.text ?? '').trim() });
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
